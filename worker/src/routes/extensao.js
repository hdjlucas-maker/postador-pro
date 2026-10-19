'use strict';

import { Hono } from 'hono';
import * as configMod from '../config.js';
import * as auth from '../auth.js';
import * as security from '../security.js';
import * as billing from '../billing.js';
import * as log from '../log.js';
import * as db from '../db.js';
import * as ia from '../ia.js';
import * as helpers from './helpers.js';

// Rotas consumidas pela extensão. Aqui não entra campanha, imagem, destino nem
// histórico: tudo isso vive no `chrome.storage` e no IndexedDB do navegador do
// cliente. O servidor responde três coisas — quem é o usuário, até quando a
// licença vale, e onde pagar.
//
// Nenhuma rota recebe `env` por argumento: o app é montado uma vez no módulo e
// o objeto de ambiente pertence à requisição, então cada handler lê `c.env`.

// Nota a partir da qual a avaliação do cliente entra publicada direto na
// janela "Avaliar ferramenta". Abaixo disso (1 a 3), espera aprovação no
// painel do administrador.
const NOTA_PUBLICA_DIRETA = 4;


function resumoLicenca(env, user) {
  const adm = auth.eAdmin(user, env);
  const limites = auth.limitesDoPlano(env, user);
  const expiracao = user.dataExpiracao ? new Date(user.dataExpiracao) : null;
  const fimAvaliacao = user.trialFim ? new Date(user.trialFim) : null;
  const valida = d => d && !Number.isNaN(d.getTime());

  return {
    email: user.email,
    nome: user.nome,
    // Administrador não expira: para a extensão ele aparece como Pro
    // permanente, sem data de fim e com os limites do Pro.
    plano: adm ? 'pro' : user.plano,
    tipoPlano: user.tipoPlano || null,
    statusPagamento: user.statusPagamento,
    expiraEm: valida(expiracao) ? expiracao.toISOString() : null,
    avaliacaoAte: !adm && valida(fimAvaliacao) ? fimAvaliacao.toISOString() : null,
    limites: {
      gruposPorDia: limites.gruposPorDia,
      campanhasAtivas: limites.campanhasAtivas,
      destinosPorCampanha: limites.destinosPorCampanha
    }
  };
}

function porConta(c) {
  return c.get('user')?._id || 'desconhecido';
}

function criar() {
  const app = new Hono();

  // Público: a extensão precisa dos preços e dos limites antes de o usuário criar
  // conta, para montar a vitrine. Não devolve nada de usuário.
  app.get('/planos', c => {
    const cfg = configMod.config(c.env);
    return c.json({
      planos: Object.values(cfg.PLANS).map(p => ({ id: p.id, nome: p.name, preco: p.price, dias: p.days })),
      limites: cfg.PLAN_LIMITS,
      avaliacaoDias: cfg.TRIAL_DAYS,
      pago: Boolean(cfg.INFINITEPAY_HANDLE)
    });
  });

  // Público no acesso, restrito na origem: a extensão autorizada faz login com
  // e-mail e senha e recebe um token. A resposta nunca traz a senha nem o hash,
  // e o token fica guardado só como SHA-256 no servidor.
  app.post('/login', security.limiteD1('extensaoLogin', { max: 10 }), async c => {
    const env = c.env;
    const body = await c.req.json().catch(() => ({}));
    const user = await auth.autenticar(env, { email: body.email, senha: body.senha });

    const token = await auth.criarTokenExtensao(env, user._id);
    const estado = auth.estadoDeAcesso(env, user);

    log.info('extensao_login', { userId: user._id, status: estado.status });

    return c.json({
      token,
      expiraEm: auth.tokenDeExtensaoExpiracao(env).toISOString(),
      acesso: estado,
      licenca: resumoLicenca(env, user)
    });
  });

  app.post('/cadastro', security.limiteD1('extensaoCadastro', { max: 5 }), async c => {
    const env = c.env;
    const body = await c.req.json().catch(() => ({}));
    const user = await auth.registrar(env, body);

    const token = await auth.criarTokenExtensao(env, user._id);
    const estado = auth.estadoDeAcesso(env, user);

    return c.json(
      {
        token,
        expiraEm: auth.tokenDeExtensaoExpiracao(env).toISOString(),
        acesso: estado,
        licenca: resumoLicenca(env, user)
      },
      201
    );
  });

  // Token válido, licença vencida ainda responde: a extensão precisa saber que
  // está expirada para mostrar a tela de assinatura, e não um erro.
  app.get('/licenca', auth.exigirToken(), c =>
    c.json({ acesso: c.get('acesso'), licenca: resumoLicenca(c.env, c.get('user')) })
  );

  app.post('/sair', auth.exigirToken(), async c => {
    await auth.encerrarToken(c);
    return c.json({ ok: true });
  });

  app.post('/checkout', auth.exigirToken(), security.limiteD1('checkout', { max: 10, chave: porConta }), async c => {
    const env = c.env;
    const body = await c.req.json().catch(() => ({}));
    const url = await billing.criarCheckout(env, c.req.raw, c.get('user'), String(body.plano || ''));
    return c.json({ url });
  });

  // Reconciliação: se o webhook se perdeu, a extensão pergunta ao voltar do
  // checkout. Sem token válido não sai nada, e a consulta à InfinitePay acontece
  // no servidor, não no navegador.
  app.post('/reconciliar', auth.exigirToken(), security.limiteD1('reconciliar', { max: 20, chave: porConta }), async c => {
    const env = c.env;
    const resultado = await billing.reconciliar(env, c.get('user'));
    // O usuário foi lido antes de a reconciliação rodar. Se ela aplicou um
    // pagamento, a licença mudou agora: reler para devolver o estado novo.
    const user = resultado.aplicados ? await db.users_porId(env, c.get('user')._id) : c.get('user');

    return c.json({
      ...resultado,
      acesso: auth.estadoDeAcesso(env, user),
      licenca: resumoLicenca(env, user)
    });
  });

  // Limite diário server-side: a extensão consulta antes de publicar e o servidor
  // incrementa somente quando a publicação é confirmada. Isso impede que quem
  // editar a extensão localmente passe do limite do plano — e, com acesso
  // exigido (402 quando vencido), o vencido não consegue nem contar publicação.
  app.get('/publicacao/hoje', auth.exigirTokenComAcesso(), async c => {
    const env = c.env;
    const user = c.get('user');
    const hoje = new Date().toISOString().slice(0, 10);
    const limites = auth.limitesDoPlano(env, user);
    const contador = await db.publicacoes_contarHoje(env, user._id, hoje);
    return c.json({
      hoje,
      limite: limites.gruposPorDia,
      contador,
      restante: Math.max(0, limites.gruposPorDia - contador),
      pode: contador < limites.gruposPorDia
    });
  });

  // Incrementa o contador de hoje de forma atômica. Só avança se o contador
  // atual for menor que o limite do plano, então requisições duplicadas ou
  // simultâneas nunca ultrapassam o teto.
  app.post('/publicacao', auth.exigirTokenComAcesso(), security.limiteD1('publicacao', { max: 60, chave: porConta }), async c => {
    const env = c.env;
    const user = c.get('user');
    const hoje = new Date().toISOString().slice(0, 10);
    const limites = auth.limitesDoPlano(env, user);
    const resultado = await db.publicacoes_incrementarHoje(env, user._id, hoje, limites.gruposPorDia);

    if (!resultado.ok) {
      log.warn('limite_diario_atingido', { userId: user._id, hoje, limite: limites.gruposPorDia });
      return c.json({ ok: false, erro: 'Limite diário atingido. A fila foi pausada para proteger sua conta.' }, 429);
    }

    log.info('publicacao_registrada', { userId: user._id, hoje, contador: resultado.contador, limite: limites.gruposPorDia });
    return c.json({
      ok: true,
      hoje,
      limite: limites.gruposPorDia,
      contador: resultado.contador,
      restante: Math.max(0, limites.gruposPorDia - resultado.contador)
    });
  });

  // Gera três variações de mensagem com a IA da Cloudflare (binding `AI`).
  // A conta precisa ter acesso válido (a avaliação conta) e a cota fica no D1:
  // 10 gerações por conta a cada 24 h por padrão (`RATE_LIMIT_GERAR_TEXTOS`).
  app.post('/gerar-textos', auth.exigirTokenComAcesso(), security.limiteD1('gerarTextos', {
    chave: porConta,
    mensagem: 'Você já usou as gerações de texto de hoje. Tente novamente amanhã ou escreva as mensagens manualmente.'
  }), async c => {
    const body = await c.req.json().catch(() => ({}));

    const produto = helpers.texto(body.produto, 'o produto ou serviço', { max: 120 });
    const beneficios = helpers.texto(body.beneficios, 'os benefícios', { obrigatorio: false, max: 500 });
    const publico = helpers.texto(body.publico, 'o público', { obrigatorio: false, max: 160 });
    const link = helpers.texto(body.link, 'o link', { obrigatorio: false, max: 300 });
    if (link && !/^https?:\/\//i.test(link)) {
      throw helpers.erroDeValidacao('O link precisa começar com http:// ou https://.');
    }

    const textos = await ia.gerarTextos(c.env, {
      produto,
      beneficios,
      publico,
      link,
      tom: body.tom,
      objetivo: body.objetivo
    });

    log.info('textos_gerados', { userId: c.get('user')._id, quantidade: textos.length });
    return c.json({ textos });
  });

  // Avaliações exibidas na janela "Avaliar ferramenta". Público de propósito:
  // quem ainda não entrou também vê o que os clientes estão dizendo. Nota alta
  // (4 ou 5) entra publicada na hora; nota baixa (1 a 3) espera aprovação no
  // painel — o administrador decide o que aparece, e pode ocultar depois.
  app.get('/avaliacoes', security.limiteD1('avaliacoes', { max: 120 }), async c => {
    const resumo = await db.avaliacoes_resumo(c.env);
    return c.json({
      media: resumo.media,
      total: resumo.total,
      avaliacoes: resumo.avaliacoes.map(a => ({
        nome: a.nome,
        nota: a.nota,
        comentario: a.comentario,
        criadoEm: a.criadoEm
      }))
    });
  });

  // Envio exige conta (Bearer). O nome exibido é só o primeiro nome da conta,
  // por privacidade, e uma avaliação por conta: reenviar atualiza a anterior e
  // ela volta para revisão.
  app.post('/avaliacao', auth.exigirToken(), security.limiteD1('avaliacao', { max: 5, chave: porConta }), async c => {
    const env = c.env;
    const user = c.get('user');
    const corpo = await c.req.json().catch(() => ({}));

    const nota = Math.round(Number(corpo.nota));
    if (!Number.isInteger(nota) || nota < 1 || nota > 5) {
      return c.json({ erro: 'Escolha uma nota de 1 a 5.' }, 400);
    }

    const comentario = String(corpo.comentario || '').trim().slice(0, 500);
    const nome = String(user.nome || '').trim().split(/\s+/)[0] || 'Cliente';

    await db.avaliacoes_salvar(env, {
      userId: user._id,
      nome,
      nota,
      comentario,
      aprovada: nota >= NOTA_PUBLICA_DIRETA
    });
    log.info('avaliacao_registrada', { userId: user._id, nota });
    return c.json({ ok: true });
  });

  return app;
}

export { criar, resumoLicenca };
