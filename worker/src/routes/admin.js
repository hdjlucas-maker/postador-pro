'use strict';

import { Hono } from 'hono';
import * as configMod from '../config.js';
import * as db from '../db.js';
import * as auth from '../auth.js';
import * as billing from '../billing.js';
import * as log from '../log.js';
import * as crypto from '../crypto.js';
import { naoEncontrado, paginacao } from './helpers.js';

// Painel do administrador. Protegido por `exigirLogin` + `exigirAdmin`, e só
// exibe o que a conta e o pagamento conhecem: nada de campanha ou conta do
// Facebook, porque isso não existe no servidor.
//
// Nenhuma rota recebe `env` por argumento: o app é montado uma vez no módulo e
// o objeto de ambiente pertence à requisição, então cada handler lê `c.env`.


function resumo(env, user, estado) {
  return {
    id: user._id,
    nome: user.nome,
    email: user.email,
    plano: user.plano || 'trial',
    tipoPlano: user.tipoPlano || null,
    status: estado,
    trialFim: user.trialFim || null,
    dataExpiracao: user.dataExpiracao || null,
    criadoEm: user.criadoEm,
    ultimoAcessoEm: user.ultimoAcessoEm || null,
    bloqueado: Boolean(user.bloqueado),
    admin: auth.eAdmin(user, env)
  };
}

function criar() {
  const app = new Hono();
  const soAdmin = [auth.exigirLogin(), auth.exigirAdmin()];

  app.get('/admin/overview', ...soAdmin, async c => {
    const env = c.env;
    const cfg = configMod.config(env);

    const [contagem, resumoPagamentos, sistema, avaliacoesPendentes] = await Promise.all([
      db.users_estaEmDia(env),
      db.payments_resumo(env),
      db.sistema_info(env),
      db.avaliacoes_contarPendentes(env)
    ]);

    const instaladoEm = sistema?.instalado_em ? new Date(sistema.instalado_em).getTime() : null;

    return c.json({
      usuarios: {
        total: Number(contagem?.total || 0),
        ativos: Number(contagem?.ativos || 0),
        pro: Number(contagem?.pro || 0),
        trial: Number(contagem?.trial || 0),
        bloqueados: Number(contagem?.bloqueados || 0)
      },
      pagamentos: resumoPagamentos,
      avaliacoes: { pendentes: avaliacoesPendentes },
      sistema: {
        email: cfg.EMAIL_ENABLED,
        pagamento: Boolean(cfg.INFINITEPAY_HANDLE)
      },
      // No Worker não existe processo de longa duração, então "uptime" não faz
      // sentido. O que importa é quando a base foi instalada e quando roda pela
      // última vez a limpeza.
      tempoAtivoSegundos: instaladoEm ? Math.max(0, Math.round((Date.now() - instaladoEm) / 1000)) : 0,
      instaladoEm: sistema?.instalado_em || null,
      ultimaLimpeza: sistema?.ultima_limpeza || null
    });
  });

  app.get('/admin/users', ...soAdmin, async c => {
    const env = c.env;
    const query = c.req.query();
    const { page, perPage, skip } = paginacao(query);

    const filtro = {};
    if (query.busca) filtro.busca = query.busca;
    if (query.plano) filtro.plano = query.plano;

    const [total, usuarios] = await Promise.all([
      db.users_contar(env, filtro),
      db.users_listar(env, { filtro, limite: perPage, offset: skip })
    ]);

    return c.json({
      usuarios: usuarios.map(user => resumo(env, user, auth.estadoDeAcesso(user).status)),
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage)
    });
  });

  app.get('/admin/payments', ...soAdmin, async c => {
    const env = c.env;
    const query = c.req.query();
    const { page, perPage, skip } = paginacao(query);

    const filtro = {};
    if (query.status) filtro.status = query.status;

    const [total, lista] = await Promise.all([
      db.payments_contar(env, filtro),
      db.payments_listar(env, { filtro, limite: perPage, offset: skip })
    ]);

    return c.json({
      pagamentos: lista.map(p => ({
        id: p._id,
        order_nsu: p.order_nsu,
        userId: p.userId,
        plano: p.plan,
        valor: p.amount,
        status: p.status,
        origem: p.origem || 'checkout',
        criadoEm: p.criadoEm,
        pagoEm: p.pagoEm || null
      })),
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage)
    });
  });

  // Avaliações da ferramenta. A janela "Avaliar ferramenta" da extensão mostra
  // só o que o administrador deixou publicado; aqui ele vê tudo — pendentes
  // (nota 1 a 3 aguardando revisão), publicadas e ocultas — e decide com um
  // clique: aprovar, ocultar, editar o texto ou excluir.
  app.get('/admin/avaliacoes', ...soAdmin, async c => {
    const lista = await db.avaliacoes_listar(c.env, { limite: 100 });
    return c.json({
      avaliacoes: lista.map(a => ({
        id: a._id,
        nome: a.nome,
        email: a.usuarioEmail,
        nota: a.nota,
        comentario: a.comentario,
        aprovada: a.aprovada,
        // Sem conta é avaliação de exemplo (vem da migração 0003).
        exemplo: !a.userId,
        criadoEm: a.criadoEm
      }))
    });
  });

  app.post('/admin/avaliacoes/:id/aprovar', ...soAdmin, async c => {
    const env = c.env;
    const avaliacao = await db.avaliacoes_porId(env, c.req.param('id'));
    if (!avaliacao) throw naoEncontrado('Avaliação não encontrada.');

    const body = await c.req.json().catch(() => ({}));
    const aprovada = Boolean(body.aprovada);
    await db.avaliacoes_atualizar(env, avaliacao._id, { aprovada });

    log.info('admin_avaliacao_visibilidade', {
      admin: c.get('user').email,
      avaliacaoId: avaliacao._id,
      aprovada
    });
    return c.json({ ok: true, aprovada });
  });

  app.post('/admin/avaliacoes/:id/editar', ...soAdmin, async c => {
    const env = c.env;
    const avaliacao = await db.avaliacoes_porId(env, c.req.param('id'));
    if (!avaliacao) throw naoEncontrado('Avaliação não encontrada.');

    const body = await c.req.json().catch(() => ({}));
    const comentario = String(body.comentario ?? '').trim().slice(0, 500);
    await db.avaliacoes_atualizar(env, avaliacao._id, { comentario });

    log.info('admin_avaliacao_editada', { admin: c.get('user').email, avaliacaoId: avaliacao._id });
    return c.json({ ok: true, comentario });
  });

  app.delete('/admin/avaliacoes/:id', ...soAdmin, async c => {
    const env = c.env;
    const avaliacao = await db.avaliacoes_porId(env, c.req.param('id'));
    if (!avaliacao) throw naoEncontrado('Avaliação não encontrada.');

    await db.avaliacoes_remover(env, avaliacao._id);

    log.info('admin_avaliacao_excluida', { admin: c.get('user').email, avaliacaoId: avaliacao._id });
    return c.json({ ok: true });
  });

  app.post('/admin/users/:id/redefinir-senha', ...soAdmin, async c => {
    const env = c.env;
    const cfg = configMod.config(env);
    const user = await db.users_porId(env, c.req.param('id'));
    if (!user) throw naoEncontrado('Usuário não encontrado.');

    // A senha aparece uma única vez para o administrador, que a entrega ao
    // usuário pelo canal de suporte. Nunca é registrada no log.
    const senhaTemporaria = `PP-${crypto.novoToken(6).slice(0, 10).toUpperCase()}`;
    await db.users_atualizar(env, user._id, {
      senhaHash: await crypto.hasharSenha(senhaTemporaria, cfg.PBKDF2_ITERACOES),
      senhaAlteradaEm: new Date(),
      loginFalhas: 0,
      bloqueadoAte: null
    });
    await db.sessions_removerPorUsuario(env, user._id);

    log.info('admin_senha_redefinida', { admin: c.get('user').email, userId: user._id });
    return c.json({ ok: true, senhaTemporaria });
  });

  app.post('/admin/users/:id/acesso', ...soAdmin, async c => {
    const env = c.env;
    const cfg = configMod.config(env);
    const user = await db.users_porId(env, c.req.param('id'));
    if (!user) throw naoEncontrado('Usuário não encontrado.');

    const body = await c.req.json().catch(() => ({}));
    const dias = Math.max(1, Math.min(3650, Number(body.dias) || 30));
    const plano = cfg.PLANS[body.plano] ? String(body.plano) : 'monthly';

    const dataExpiracao = await billing.concessaoManual(env, {
      user,
      dias,
      plano,
      motivo: String(body.motivo || 'Concessão manual pelo painel'),
      admin: c.get('user').email
    });

    return c.json({ ok: true, dataExpiracao });
  });

  app.post('/admin/users/:id/bloqueio', ...soAdmin, async c => {
    const env = c.env;
    const user = await db.users_porId(env, c.req.param('id'));
    if (!user) throw naoEncontrado('Usuário não encontrado.');

    const body = await c.req.json().catch(() => ({}));
    const bloqueado = Boolean(body.bloqueado);
    if (user._id === c.get('user')._id && bloqueado) {
      throw Object.assign(new Error('Você não pode bloquear a própria conta.'), { status: 400 });
    }

    await db.users_atualizar(env, user._id, { bloqueado });
    if (bloqueado) await db.sessions_removerPorUsuario(env, user._id);

    log.info('admin_bloqueio', { admin: c.get('user').email, userId: user._id, bloqueado });
    return c.json({ ok: true, bloqueado });
  });

  app.post('/admin/users/:id/reiniciar-trial', ...soAdmin, async c => {
    const env = c.env;
    const cfg = configMod.config(env);
    const user = await db.users_porId(env, c.req.param('id'));
    if (!user) throw naoEncontrado('Usuário não encontrado.');

    const body = await c.req.json().catch(() => ({}));
    const dias = Math.max(1, Math.min(90, Number(body.dias) || cfg.TRIAL_DAYS));
    const inicio = new Date();
    const fim = auth.addDays(inicio, dias);

    await db.users_atualizar(env, user._id, {
      plano: 'trial',
      statusPagamento: 'trial',
      trialInicio: inicio,
      trialFim: fim
    });

    log.info('admin_trial_reiniciado', { admin: c.get('user').email, userId: user._id, dias });
    return c.json({ ok: true, trialFim: fim });
  });

  app.delete('/admin/users/:id', ...soAdmin, async c => {
    const env = c.env;
    const user = await db.users_porId(env, c.req.param('id'));
    if (!user) throw naoEncontrado('Usuário não encontrado.');
    if (user._id === c.get('user')._id) {
      throw Object.assign(new Error('Você não pode excluir a própria conta pelo painel.'), { status: 400 });
    }

    await db.users_excluir(env, user._id);

    log.info('admin_usuario_excluido', { admin: c.get('user').email, userId: user._id, email: user.email });
    return c.json({ ok: true });
  });

  /**
   * No servidor isto copiava os arquivos `.db` para `data/backups/`. Worker não
   * tem sistema de arquivos, e o D1 já resolve isso de outro jeito: Time Travel
   * mantém o estado do banco por um prazo e permite restaurar por timestamp.
   *
   * Esta rota virou um relatório do que a Cloudflare guardou, para o
   * administrador saber até onde dá para voltar sem precisar abrir o painel.
   */
  app.get('/admin/backup', ...soAdmin, async c => {
    const sistema = await db.sistema_info(c.env);
    return c.json({
      ok: true,
      metodo: 'd1-time-travel',
      observacao:
        'O D1 guarda histórico do próprio banco. Não é preciso copiar arquivo: ' +
        'restaure por timestamp no painel da Cloudflare (Workers & Pages > D1 > banco > Time Travel).',
      instaladoEm: sistema?.instalado_em || null,
      ultimaLimpeza: sistema?.ultima_limpeza || null
    });
  });

  return app;
}

export { criar };
