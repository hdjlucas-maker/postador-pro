'use strict';

// Rotas consumidas pela extensão. Aqui não entra campanha, imagem, destino nem
// histórico: tudo isso vive no `chrome.storage` e no IndexedDB do navegador do
// cliente. O servidor responde três coisas — quem é o usuário, até quando a
// licença vale, e onde pagar.
//
// Nenhuma rota recebe `env` por argumento: o app é montado uma vez no módulo e
// o objeto de ambiente pertence à requisição, então cada handler lê `c.env`.

const { Hono } = require('hono');
const configMod = require('../config');
const auth = require('../auth');
const security = require('../security');
const billing = require('../billing');
const log = require('../log');
const db = require('../db');

function resumoLicenca(env, user) {
  const limites = auth.limitesDoPlano(env, user);
  const expiracao = user.dataExpiracao ? new Date(user.dataExpiracao) : null;
  const fimAvaliacao = user.trialFim ? new Date(user.trialFim) : null;
  const valida = d => d && !Number.isNaN(d.getTime());

  return {
    email: user.email,
    nome: user.nome,
    plano: user.plano,
    tipoPlano: user.tipoPlano || null,
    statusPagamento: user.statusPagamento,
    expiraEm: valida(expiracao) ? expiracao.toISOString() : null,
    avaliacaoAte: valida(fimAvaliacao) ? fimAvaliacao.toISOString() : null,
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
      planos: Object.values(cfg.PLANS).map(p => ({ id: p.id, nome: p.name, preco: p.price, dias: p.dias })),
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
    const estado = auth.estadoDeAcesso(user);

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
    const estado = auth.estadoDeAcesso(user);

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
      acesso: auth.estadoDeAcesso(user),
      licenca: resumoLicenca(env, user)
    });
  });

  return app;
}

module.exports = { criar, resumoLicenca };
