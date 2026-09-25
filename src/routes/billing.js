'use strict';

const config = require('./../config');
const { db } = require('./../db');
const auth = require('./../auth');
const billing = require('./../billing');
const security = require('./../security');
const log = require('./../log');
const { envolver } = require('./helpers');

function registrar(router) {
  router.get(
    '/subscription',
    auth.exigirLogin,
    envolver(async (req, res) => {
      const estado = await auth.estadoDeAcesso(req.user);
      const plano = config.PLANS[req.user.tipoPlano];

      let nome = 'Acesso encerrado';
      let descricao = 'Escolha um plano para continuar.';

      if (estado.status === 'trial') {
        const dias = Math.max(0, Math.ceil((new Date(req.user.trialFim) - Date.now()) / 86400000));
        nome = `Avaliação gratuita — ${dias} dia(s)`;
        descricao = `Sua avaliação termina em ${new Date(req.user.trialFim).toLocaleDateString('pt-BR')}.`;
      }

      if (estado.status === 'pro') {
        nome = plano ? plano.name : 'Postador Pro';
        descricao = `Acesso ativo até ${new Date(req.user.dataExpiracao).toLocaleDateString('pt-BR')}.`;
      }

      const ultimoPago = await db.payments
        .find({ userId: req.user._id, status: 'paid' })
        .sort({ criadoEm: -1 })
        .limit(1);

      res.json({
        ativo: estado.permitido,
        status: estado.status,
        nome,
        descricao,
        plano: plano ? { id: plano.id, preco: plano.price, dias: plano.days } : null,
        expiraEm: req.user.dataExpiracao || null,
        trialFim: req.user.trialFim || null,
        ultimoPagamento: ultimoPago[0]
          ? {
              data: ultimoPago[0].pagoEm || ultimoPago[0].criadoEm,
              plano: ultimoPago[0].plan,
              origem: ultimoPago[0].origem || 'checkout'
            }
          : null,
        limites: auth.limitesDoPlano(req.user)
      });
    })
  );

  router.post(
    '/billing/checkout',
    auth.exigirLogin,
    security.criarRateLimit({ nome: 'checkout', max: 10, janelaMs: 60 * 60 * 1000, chave: security.usuarioId }),
    envolver(async (req, res) => {
      const url = await billing.criarCheckout(req.user, String(req.body.plano || ''));
      res.json({ url });
    })
  );

  router.post(
    '/billing/reconciliar',
    auth.exigirLogin,
    security.criarRateLimit({ nome: 'reconciliar', max: 20, janelaMs: 60 * 60 * 1000, chave: security.usuarioId }),
    envolver(async (req, res) => {
      const resultado = await billing.reconciliar(req.user);
      const user = await db.users.findOne({ _id: req.user._id });
      const estado = await auth.estadoDeAcesso(user);

      res.json({
        ...resultado,
        statusPagamento: estado.status,
        dataExpiracao: user.dataExpiracao || null
      });
    })
  );

  router.post(
    '/webhooks/infinitepay',
    security.criarRateLimit({ nome: 'webhook', max: 120, janelaMs: 60 * 1000 }),
    envolver(async (req, res) => {
      const resultado = await billing.webhook(req.body || {});
      log.info('infinitepay_webhook', { status: resultado.status });
      res.status(resultado.status).json(resultado.body);
    })
  );
}

module.exports = { registrar };
