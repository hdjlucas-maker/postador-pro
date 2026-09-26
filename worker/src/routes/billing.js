'use strict';

// Assinatura, checkout, reconciliação e o webhook da InfinitePay.
//
// Nenhuma rota recebe `env` por argumento: o app é montado uma vez no módulo e
// o objeto de ambiente pertence à requisição, então cada handler lê `c.env`.

const { Hono } = require('hono');
const configMod = require('../config');
const db = require('../db');
const auth = require('../auth');
const billing = require('../billing');
const security = require('../security');
const log = require('../log');

// A chave do rate limit de checkout e reconciliação é a conta, não o IP: o
// cliente pode mudar de rede no meio do pagamento, e o que precisa ser limitado
// é quantas vezes uma mesma conta abre checkout.
function porConta(c) {
  return c.get('user')?._id || 'desconhecido';
}

function criar() {
  const app = new Hono();

  app.get('/subscription', auth.exigirLogin(), async c => {
    const env = c.env;
    const cfg = configMod.config(env);
    const user = c.get('user');
    const estado = auth.estadoDeAcesso(user);
    const plano = cfg.PLANS[user.tipoPlano];

    let nome = 'Acesso encerrado';
    let descricao = 'Escolha um plano para continuar.';

    if (estado.status === 'trial') {
      const dias = Math.max(0, Math.ceil((new Date(user.trialFim) - Date.now()) / 86400000));
      nome = `Avaliação gratuita — ${dias} dia(s)`;
      descricao = `Sua avaliação termina em ${new Date(user.trialFim).toLocaleDateString('pt-BR')}.`;
    }

    if (estado.status === 'pro') {
      nome = plano ? plano.name : 'Postador Pro';
      descricao = `Acesso ativo até ${new Date(user.dataExpiracao).toLocaleDateString('pt-BR')}.`;
    }

    const ultimoPago = await db.payments_ultimoPago(env, user._id);

    return c.json({
      ativo: estado.permitido,
      status: estado.status,
      nome,
      descricao,
      plano: plano ? { id: plano.id, preco: plano.price, dias: plano.dias } : null,
      expiraEm: user.dataExpiracao || null,
      trialFim: user.trialFim || null,
      ultimoPagamento: ultimoPago
        ? {
            data: ultimoPago.pagoEm || ultimoPago.criadoEm,
            plano: ultimoPago.plan,
            origem: ultimoPago.origem || 'checkout'
          }
        : null,
      limites: auth.limitesDoPlano(env, user)
    });
  });

  app.post('/billing/checkout', auth.exigirLogin(), security.limiteD1('checkout', { chave: porConta }), async c => {
    const env = c.env;
    const body = await c.req.json().catch(() => ({}));
    const url = await billing.criarCheckout(env, c.req.raw, c.get('user'), String(body.plano || ''));
    return c.json({ url });
  });

  app.post('/billing/reconciliar', auth.exigirLogin(), security.limiteD1('reconciliar', { chave: porConta }), async c => {
    const env = c.env;
    const resultado = await billing.reconciliar(env, c.get('user'));
    const user = resultado.aplicados ? await db.users_porId(env, c.get('user')._id) : c.get('user');

    return c.json({
      ...resultado,
      statusPagamento: auth.estadoDeAcesso(user).status,
      dataExpiracao: user.dataExpiracao || null
    });
  });

  // Webhook da InfinitePay. Não passa por CSRF nem por allowlist de origem: quem
  // chama é o servidor da InfinitePay, que não é navegador e não manda cookie.
  // O que protege a rota é `billing.webhook` confirmar o pagamento com a
  // InfinitePay e comparar o valor, não o corpo da requisição.
  app.post('/webhooks/infinitepay', async c => {
    const body = await c.req.json().catch(() => ({}));
    const resultado = await billing.webhook(c.env, body);
    log.info('infinitepay_webhook', { status: resultado.status });
    return c.json(resultado.body, resultado.status);
  });

  return app;
}

module.exports = { criar };
