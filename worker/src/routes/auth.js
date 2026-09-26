'use strict';

// Rotas de conta: cadastro, login, perfil, recuperação de senha e LGPD.
//
// Nenhuma rota recebe `env` por argumento. O app é montado uma vez no módulo e
// o objeto de ambiente pertence à requisição, então cada handler lê `c.env`.

const { Hono } = require('hono');
const crypto = require('../crypto');
const configMod = require('../config');
const db = require('../db');
const auth = require('../auth');
const security = require('../security');
const email = require('../email');
const log = require('../log');
const { texto } = require('./helpers');

function perfilPublico(env, user, estado) {
  return {
    id: user._id,
    nome: user.nome,
    email: user.email,
    plano: user.plano || 'trial',
    tipoPlano: user.tipoPlano || null,
    statusPagamento: estado.status,
    admin: auth.eAdmin(user, env),
    trialInicio: user.trialInicio || null,
    trialFim: user.trialFim || null,
    dataExpiracao: user.dataExpiracao || null,
    limites: auth.limitesDoPlano(env, user),
    criadoEm: user.criadoEm || null
  };
}

function criar() {
  const app = new Hono();

  app.get('/config', async c => {
    const env = c.env;
    const cfg = configMod.config(env);

    // Dá o par de cookies para o primeiro POST passar na verificação de CSRF.
    security.assegurarCsrf(c);

    return c.json({
      planos: Object.values(cfg.PLANS).map(plano => ({
        id: plano.id,
        nome: plano.name,
        preco: plano.price,
        dias: plano.dias
      })),
      trialDias: cfg.TRIAL_DAYS,
      limites: cfg.PLAN_LIMITS,
      // Indica que o checkout está disponível, ou seja, que a InfinitePay está
      // configurada. NÃO é o status de pagamento deste usuário: o acesso de cada
      // um vem da sessão.
      pago: Boolean(cfg.INFINITEPAY_HANDLE)
    });
  });

  app.post('/register', security.limiteD1('registro'), async c => {
    const env = c.env;
    const body = await c.req.json().catch(() => ({}));
    const user = await auth.registrar(env, body);
    const token = await auth.criarSessao(env, user._id);
    auth.aplicarSessao(c, token);

    return c.json(perfilPublico(env, user, auth.estadoDeAcesso(user)), 201);
  });

  app.post('/login', security.limiteD1('login'), async c => {
    const env = c.env;
    const body = await c.req.json().catch(() => ({}));
    const user = await auth.autenticar(env, body);
    const token = await auth.criarSessao(env, user._id);
    auth.aplicarSessao(c, token);

    log.info('login', { userId: user._id, ip: security.clientIp(c) });
    return c.json(perfilPublico(env, user, auth.estadoDeAcesso(user)));
  });

  app.post('/logout', async c => {
    const env = c.env;
    const cfg = configMod.config(env);
    const token = c.req.cookie(cfg.SESSION_COOKIE);
    if (token) await db.sessions_removerPorTokenHash(env, crypto.sha256Hex(token));
    auth.encerrarSessao(c);
    return c.json({ ok: true });
  });

  app.get('/me', async c => {
    const user = await auth.usuarioAtual(c);
    if (!user) return c.json({ erro: 'Não autenticado.', codigo: 'nao_autenticado' }, 401);
    return c.json(perfilPublico(c.env, user, auth.estadoDeAcesso(user)));
  });

  app.patch('/me', auth.exigirLogin(), async c => {
    const env = c.env;
    const body = await c.req.json().catch(() => ({}));
    const nome = texto(body.nome, 'seu nome', { min: 2, max: 80 });
    await db.users_atualizar(env, c.get('user')._id, { nome });
    const user = await db.users_porId(env, c.get('user')._id);
    return c.json(perfilPublico(env, user, auth.estadoDeAcesso(user)));
  });

  app.post('/me/senha', auth.exigirLogin(), security.limiteD1('trocaSenha'), async c => {
    const env = c.env;
    const body = await c.req.json().catch(() => ({}));
    await auth.trocarSenha(env, c.get('user'), body.senhaAtual, body.novaSenha);
    return c.json({ ok: true, mensagem: 'Senha alterada. Entre novamente com a nova senha.' });
  });

  app.post('/recuperar-senha', security.limiteD1('recuperar'), async c => {
    const env = c.env;
    const cfg = configMod.config(env);
    const body = await c.req.json().catch(() => ({}));
    const emailRecebido = auth.normalizarEmail(body.email);
    const resposta = {
      ok: true,
      mensagem: 'Se o e-mail estiver cadastrado, você receberá o link de recuperação.'
    };

    // A mesma resposta para e-mail cadastrado e não cadastrado: differçar os
    // dois revelaria quem tem conta.
    if (!auth.emailValido(emailRecebido)) return c.json(resposta);

    const user = await db.users_porEmail(env, emailRecebido);
    if (!user || user.bloqueado) return c.json(resposta);

    const token = crypto.novoToken(24);
    await db.resets_inserir(env, {
      tokenHash: crypto.sha256Hex(token),
      userId: user._id,
      criadoEm: new Date(),
      expiraEm: new Date(Date.now() + cfg.RESET_TOKEN_MINUTES * 60000),
      usadoEm: null
    });

    const link = `${configMod.baseUrl(env, c.req.raw)}/redefinir?token=${token}`;
    const envio = await email.enviarRecuperacao(env, { email: user.email, link });

    if (!envio.enviado && envio.link && env.EXPOSIR_LINK_REDEFINICAO) {
      resposta.linkDev = envio.link;
      resposta.aviso = 'E-mail não configurado: o link de redefinição foi registrado no log do servidor.';
    }

    return c.json(resposta);
  });

  app.post('/redefinir-senha', security.limiteD1('redefinir'), async c => {
    const env = c.env;
    const cfg = configMod.config(env);
    const body = await c.req.json().catch(() => ({}));
    const token = String(body.token || '');
    if (!token) throw Object.assign(new Error('Token inválido.'), { status: 400 });

    const registro = await db.resets_porTokenHash(env, crypto.sha256Hex(token));
    if (!registro || registro.usadoEm || new Date(registro.expiraEm) <= new Date()) {
      throw Object.assign(new Error('Link expirado ou já utilizado. Solicite um novo.'), { status: 400 });
    }

    const novaSenha = String(body.novaSenha || '');
    if (!auth.forcaSenha(novaSenha)) {
      throw Object.assign(new Error('A senha precisa ter pelo menos 8 caracteres.'), { status: 400 });
    }

    await db.users_atualizar(env, registro.userId, {
      senhaHash: await crypto.hasharSenha(novaSenha, cfg.PBKDF2_ITERACOES),
      senhaAlteradaEm: new Date()
    });

    await db.resets_marcarUsado(env, registro._id);
    // Trocar a senha derruba as sessões, inclusive o token da extensão.
    await db.sessions_removerPorUsuario(env, registro.userId);

    log.info('senha_redefinida', { userId: registro.userId });
    return c.json({ ok: true, mensagem: 'Senha redefinida. Faça login com a nova senha.' });
  });

  // LGPD: portabilidade. O servidor só tem o que é da conta e do pagamento:
  // campanha, publicação e imagem vivem no navegador do cliente, e o cliente as
  // exporta de lá.
  app.get('/me/dados', auth.exigirLogin(), async c => {
    const env = c.env;
    const user = c.get('user');
    const pagamentos = await db.payments_porUsuario(env, user._id);

    c.header('Content-Disposition', `attachment; filename="postador-dados-${user._id}.json"`);
    return c.json({
      geradoEm: new Date().toISOString(),
      observacao: 'Campanhas, publicações e imagens ficam somente no navegador do cliente e não são enviadas ao servidor.',
      conta: {
        id: user._id,
        nome: user.nome,
        email: user.email,
        criadoEm: user.criadoEm,
        trialInicio: user.trialInicio,
        trialFim: user.trialFim,
        plano: user.plano,
        dataExpiracao: user.dataExpiracao
      },
      pagamentos
    });
  });

  // LGPD: eliminação
  app.post('/me/excluir', auth.exigirLogin(), security.limiteD1('excluirConta'), async c => {
    const env = c.env;
    const body = await c.req.json().catch(() => ({}));
    const user = c.get('user');

    const confere = await crypto.confereSenha(String(body.senha || ''), user.senhaHash);
    if (!confere) throw Object.assign(new Error('Senha incorreta.'), { status: 400 });

    await db.users_excluir(env, user._id);
    auth.encerrarSessao(c);

    log.info('conta_excluida', { userId: user._id });
    return c.json({
      ok: true,
      mensagem: 'Conta e dados do servidor excluídos. Os dados que estavam no navegador precisam ser apagados pela extensão.'
    });
  });

  return app;
}

module.exports = { criar, perfilPublico };
