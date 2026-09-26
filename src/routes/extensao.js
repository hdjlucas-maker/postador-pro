'use strict';

// Rotas consumidas pela extensão. Aqui não entra campanha, imagem, destino
// nem histórico: tudo isso vive no `chrome.storage` e no IndexedDB do
// navegador do cliente. O servidor responde três coisas — quem é o usuário,
// até quando a licença vale, e onde pagar.

const config = require('../config');
const auth = require('../auth');
const security = require('../security');
const billing = require('../billing');
const log = require('../log');
const { db } = require('../db');

function limite(nome, max, janelaMs) {
  return security.criarRateLimit({ nome, max, janelaMs });
}

function resumoLicenca(user) {
  const limites = auth.limitesDoPlano(user);
  const expiracao = user.dataExpiracao ? new Date(user.dataExpiracao) : null;
  const fimAvaliacao = user.trialFim ? new Date(user.trialFim) : null;

  return {
    email: user.email,
    nome: user.nome,
    plano: user.plano,
    tipoPlano: user.tipoPlano || null,
    statusPagamento: user.statusPagamento,
    expiraEm: expiracao && !Number.isNaN(expiracao.getTime()) ? expiracao.toISOString() : null,
    avaliacaoAte: fimAvaliacao && !Number.isNaN(fimAvaliacao.getTime()) ? fimAvaliacao.toISOString() : null,
    limites: {
      gruposPorDia: limites.gruposPorDia,
      campanhasAtivas: limites.campanhasAtivas,
      destinosPorCampanha: limites.destinosPorCampanha
    }
  };
}

function registrar(router) {
  // Público: a extensão precisa dos preços e dos limites antes de o usuário
  // criar conta, para mostrar a vitrine. Não devolve nada de usuário.
  router.get('/extensao/planos', (req, res) => {
    res.json({
      planos: Object.values(config.PLANS).map(p => ({
        id: p.id,
        nome: p.name,
        preco: p.price,
        dias: p.days
      })),
      limites: config.PLAN_LIMITS,
      avaliacaoDias: config.TRIAL_DAYS,
      pago: Boolean(config.INFINITEPAY_HANDLE)
    });
  });

  // Público no acesso, restrito na origem: a extensão autorizada faz login
  // com e-mail e senha e recebe um token. A resposta nunca traz a senha nem o
  // hash, e o token fica guardado só como SHA-256 no servidor.
  router.post(
    '/extensao/login',
    limite('extensaoLogin', config.RATE_LIMITS.login, 15 * 60 * 1000),
    async (req, res, next) => {
      try {
        const user = await auth.autenticar({
          email: req.body?.email,
          senha: req.body?.senha
        });

        const token = await auth.criarTokenExtensao(user._id);
        const estado = await auth.estadoDeAcesso(user);

        log.info('extensao_login', { userId: user._id, status: estado.status });

        res.json({
          token,
          expiraEm: new Date(Date.now() + config.TOKEN_EXTENSAO_DIAS * 86400000).toISOString(),
          acesso: estado,
          licenca: resumoLicenca(user)
        });
      } catch (erro) {
        next(erro);
      }
    }
  );

  router.post(
    '/extensao/cadastro',
    limite('extensaoCadastro', config.RATE_LIMITS.registro, 60 * 60 * 1000),
    async (req, res, next) => {
      try {
        const user = await auth.registrar({
          nome: req.body?.nome,
          email: req.body?.email,
          senha: req.body?.senha
        });

        const token = await auth.criarTokenExtensao(user._id);
        const estado = await auth.estadoDeAcesso(user);

        res.status(201).json({
          token,
          expiraEm: new Date(Date.now() + config.TOKEN_EXTENSAO_DIAS * 86400000).toISOString(),
          acesso: estado,
          licenca: resumoLicenca(user)
        });
      } catch (erro) {
        next(erro);
      }
    }
  );

  // Token válido, licença vencida ainda responde: a extensão precisa saber
  // que está expirada para mostrar a tela de assinatura, e não um erro.
  router.get('/extensao/licenca', auth.exigirToken, (req, res) => {
    res.json({ acesso: req.acesso, licenca: resumoLicenca(req.user) });
  });

  router.post('/extensao/sair', auth.exigirToken, async (req, res, next) => {
    try {
      await auth.encerrarToken(req);
      res.json({ ok: true });
    } catch (erro) {
      next(erro);
    }
  });

  router.post(
    '/extensao/checkout',
    auth.exigirToken,
    limite('extensaoCheckout', 10, 10 * 60 * 1000),
    async (req, res, next) => {
      try {
        const url = await billing.criarCheckout(req.user, String(req.body?.plano || ''));
        res.json({ url });
      } catch (erro) {
        next(erro);
      }
    }
  );

  // Reconciliação: se o webhook se perdeu, a extensão pergunta ao voltar do
  // checkout. Sem token válido não sai nada, e a consulta à InfinitePay
  // acontece no servidor, não no navegador.
  router.post(
    '/extensao/reconciliar',
    auth.exigirToken,
    limite('extensaoReconciliar', 20, 10 * 60 * 1000),
    async (req, res, next) => {
      try {
        const resultado = await billing.reconciliar(req.user);
        // `req.user` foi lido antes de a reconciliação rodar. Se ela aplicou
        // um pagamento, a licença mudou agora: reler para devolver o estado novo.
        const user = resultado.aplicados ? await db.users.findOne({ _id: req.user._id }) : req.user;

        res.json({
          ...resultado,
          acesso: await auth.estadoDeAcesso(user),
          licenca: resumoLicenca(user)
        });
      } catch (erro) {
        next(erro);
      }
    }
  );
}

module.exports = { registrar, resumoLicenca };
