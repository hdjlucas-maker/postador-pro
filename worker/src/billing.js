'use strict';

// Cobrança InfinitePay.
//
// A regra de segurança continua a mesma do servidor: o corpo do webhook não é
// confiável. O que vale é a resposta da consulta que este servidor faz à
// InfinitePay, comparando `paid` e `amount` com o que o plano cobra. Um
// atacante que descubra a URL do webhook e mande `paid: true` não libera
// acesso, porque o valor confere contra a planilha de preços do servidor e
// não contra o corpo da requisição.

const crypto = require('./crypto');
const configMod = require('./config');
const db = require('./db');
const auth = require('./auth');
const log = require('./log');
const email = require('./email');

function precoEmCentavos(valor) {
  return Math.round(Number(valor) * 100);
}

async function criarCheckout(env, request, user, planoId) {
  // Valida a entrada antes do ambiente: um pedido inválido é erro do cliente,
  // mesmo que o servidor esteja sem a InfinitePay configurada.
  const cfg = configMod.config(env);
  const plano = cfg.PLANS[planoId];
  if (!plano) {
    throw Object.assign(new Error('Plano inválido.'), { status: 400 });
  }

  if (!cfg.INFINITEPAY_HANDLE) {
    throw Object.assign(new Error('Configure INFINITEPAY_HANDLE no servidor.'), { status: 500 });
  }

  const base = configMod.baseUrl(env, request);
  const order_nsu = `postador-${user._id}-${Date.now()}-${crypto.novoToken(3)}`;

  await db.payments_inserir(env, {
    order_nsu,
    userId: user._id,
    plan: planoId,
    amount: plano.price,
    status: 'pending',
    criadoEm: auth.agora()
  });

  const payload = {
    handle: cfg.INFINITEPAY_HANDLE,
    redirect_url: `${base}/?pagamento=retorno`,
    webhook_url: `${base}/api/webhooks/infinitepay`,
    order_nsu,
    items: [{ quantity: 1, price: plano.price, description: plano.name }]
  };

  let resposta;
  try {
    resposta = await fetch(`${cfg.INFINITEPAY_API}/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });
  } catch (erro) {
    await db.payments_atualizar(env, order_nsu, { status: 'erro', erro: erro.message });
    throw Object.assign(new Error('Não foi possível falar com a InfinitePay. Tente novamente.'), { status: 502 });
  }

  const data = await resposta.json().catch(() => ({}));

  if (!resposta.ok || !data.url) {
    await db.payments_atualizar(env, order_nsu, { status: 'erro', erro: data.message || 'checkout_recusado' });
    log.warn('checkout_recusado', { order_nsu, status: resposta.status });
    throw Object.assign(new Error(data.message || 'Não foi possível criar o checkout.'), { status: 502 });
  }

  await db.payments_atualizar(env, order_nsu, { checkoutUrl: data.url });
  log.info('checkout_criado', { order_nsu, plan: planoId, userId: user._id });

  return data.url;
}

async function confirmarComInfinitePay(env, { order_nsu, transaction_nsu, invoice_slug, expectedAmount }) {
  const cfg = configMod.config(env);
  if (!cfg.INFINITEPAY_HANDLE) {
    throw new Error('INFINITEPAY_HANDLE não configurado.');
  }

  const resposta = await fetch(`${cfg.INFINITEPAY_API}/payment_check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handle: cfg.INFINITEPAY_HANDLE,
      order_nsu,
      transaction_nsu,
      slug: invoice_slug
    }),
    signal: AbortSignal.timeout(20000)
  });

  const data = await resposta.json().catch(() => ({}));

  if (!resposta.ok || data.success !== true) {
    throw new Error(data.message || 'Não foi possível confirmar o pagamento.');
  }

  if (data.paid !== true) {
    throw new Error('Pagamento ainda não confirmado pela InfinitePay.');
  }

  if (Number(data.amount) !== Number(expectedAmount)) {
    throw new Error('Valor confirmado não confere com o plano.');
  }

  return data;
}

/**
 * Aplica o acesso do usuário. Idempotente por pedido: a `payments_reservar` faz
 * um `UPDATE ... WHERE aplicado_em IS NULL`, e só uma execução afeta a linha.
 * Reenvios do webhook, da reconciliação ou duas entregas simultâneas do mesmo
 * pedido enxergam `changes = 0` e saem sem cobrar de novo.
 */
async function aplicarPagamento(env, payment, extras = {}) {
  const cfg = configMod.config(env);
  const plano = cfg.PLANS[payment.plan];
  if (!plano) throw new Error('Plano do pedido inválido.');

  const user = await db.users_porId(env, payment.userId);
  if (!user) throw new Error('Usuário não encontrado.');

  const afetados = await db.payments_reservar(env, payment._id, extras);

  if (!afetados) {
    const jaAplicado = await db.payments_porId(env, payment._id);
    log.info('pagamento_ja_aplicado', {
      order_nsu: payment.order_nsu,
      userId: payment.userId,
      expiraEm: jaAplicado?.dataExpiracaoConcedida || null
    });
    return {
      user,
      dataExpiracao: jaAplicado?.dataExpiracaoConcedida
        ? new Date(jaAplicado.dataExpiracaoConcedida)
        : new Date(user.dataExpiracao || auth.agora()),
      jaAplicado: true
    };
  }

  try {
    const expiracaoAtual =
      user.dataExpiracao && new Date(user.dataExpiracao) > auth.agora()
        ? new Date(user.dataExpiracao)
        : auth.agora();

    const dataExpiracao = auth.addDays(expiracaoAtual, plano.days);

    await db.users_atualizar(env, user._id, {
      plano: 'pro',
      tipoPlano: payment.plan,
      statusPagamento: 'paid',
      dataInicio: user.dataInicio || auth.agora(),
      ultimoPagamentoEm: auth.agora(),
      dataExpiracao
    });

    await db.payments_atualizarPorId(env, payment._id, { dataExpiracaoConcedida: dataExpiracao });

    log.info('pagamento_aplicado', {
      order_nsu: payment.order_nsu,
      plan: payment.plan,
      userId: user._id,
      expiraEm: dataExpiracao
    });

    await email.avisarPagamento(env, {
      email: user.email,
      nome: user.nome,
      plano: plano.name,
      expiraEm: dataExpiracao
    });

    return { user, dataExpiracao, jaAplicado: false };
  } catch (erro) {
    // Desfaz a reserva para que a reconciliação possa tentar de novo.
    await db.payments_desfazerReserva(env, payment._id);
    throw erro;
  }
}

async function webhook(env, dados) {
  const cfg = configMod.config(env);
  const order_nsu = String(dados.order_nsu || '');
  const transaction_nsu = String(dados.transaction_nsu || '');
  const invoice_slug = String(dados.invoice_slug || '');

  if (!order_nsu) {
    return { status: 400, body: { success: false, message: 'order_nsu ausente' } };
  }

  const payment = await db.payments_porOrder(env, order_nsu);
  if (!payment) {
    return { status: 400, body: { success: false, message: 'Pedido não encontrado' } };
  }

  if (payment.status === 'paid' && payment.aplicadoEm) {
    return { status: 200, body: { success: true, message: null } };
  }

  if (!transaction_nsu || !invoice_slug) {
    return { status: 400, body: { success: false, message: 'Dados da transação ausentes' } };
  }

  const plano = cfg.PLANS[payment.plan];
  if (!plano) {
    return { status: 400, body: { success: false, message: 'Plano do pedido inválido' } };
  }

  if (Number(dados.amount) !== Number(plano.price)) {
    log.warn('infinitepay_valor_divergente', { order_nsu, recebido: dados.amount, esperado: plano.price });
    return { status: 400, body: { success: false, message: 'Valor do pedido não confere' } };
  }

  try {
    await confirmarComInfinitePay(env, {
      order_nsu,
      transaction_nsu,
      invoice_slug,
      expectedAmount: plano.price
    });
  } catch (erro) {
    log.error('infinitepay_confirmacao', { order_nsu, erro: erro.message });
    return { status: 400, body: { success: false, message: erro.message } };
  }

  try {
    await aplicarPagamento(env, payment, {
      transaction_nsu,
      invoice_slug,
      receipt_url: dados.receipt_url || null
    });
  } catch (erro) {
    log.error('infinitepay_aplicar', { order_nsu, erro: erro.message });
    return { status: 500, body: { success: false, message: erro.message } };
  }

  return { status: 200, body: { success: true, message: null } };
}

// Reconciliação: se o webhook se perdeu, o próprio cliente dispara a checagem ao
// voltar do checkout. Sem isso, o cliente paga e fica sem acesso.
const MAX_VERIFICACOES_POR_CHAMADA = 3;

async function reconciliar(env, user) {
  const pendentes = await db.payments_pendentes(env, user._id, MAX_VERIFICACOES_POR_CHAMADA);
  const cfg = configMod.config(env);

  let verificados = 0;
  let aplicados = 0;

  for (const payment of pendentes) {
    if (!payment.checkoutUrl) continue;
    if (!cfg.PLANS[payment.plan]) continue;
    if (verificados >= MAX_VERIFICACOES_POR_CHAMADA) break;

    verificados += 1;

    const dados = await consultarStatusNaGateway(env, payment);
    const conferido = Number(dados?.amount) === Number(cfg.PLANS[payment.plan].price);

    if (dados && dados.paid === true && conferido) {
      await aplicarPagamento(env, payment, {
        transaction_nsu: dados.transaction_nsu || null,
        invoice_slug: dados.invoice_slug || dados.slug || null,
        receipt_url: dados.receipt_url || null,
        origem: 'reconciliacao'
      });
      aplicados += 1;
    }
  }

  return { verificados, aplicados };
}

async function consultarStatusNaGateway(env, payment) {
  const cfg = configMod.config(env);
  try {
    const resposta = await fetch(`${cfg.INFINITEPAY_API}/payment_check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle: cfg.INFINITEPAY_HANDLE,
        order_nsu: payment.order_nsu
      }),
      signal: AbortSignal.timeout(15000)
    });

    const data = await resposta.json().catch(() => ({}));
    if (!resposta.ok) return null;
    return data;
  } catch (erro) {
    log.warn('infinitepay_consulta', { order_nsu: payment.order_nsu, erro: erro.message });
    return null;
  }
}

async function concessaoManual(env, { user, dias, plano, motivo, admin }) {
  const cfg = configMod.config(env);
  const diasEfetivo = Number(dias) > 0 ? Math.floor(Number(dias)) : 30;
  const planoId = cfg.PLANS[plano] ? plano : 'monthly';
  const expiracaoAtual =
    user.dataExpiracao && new Date(user.dataExpiracao) > auth.agora()
      ? new Date(user.dataExpiracao)
      : auth.agora();
  const dataExpiracao = auth.addDays(expiracaoAtual, diasEfetivo);

  await db.users_atualizar(env, user._id, {
    plano: 'pro',
    tipoPlano: planoId,
    statusPagamento: 'paid',
    dataInicio: user.dataInicio || auth.agora(),
    dataExpiracao
  });

  await db.payments_inserir(env, {
    order_nsu: `manual-${user._id}-${Date.now()}`,
    userId: user._id,
    plan: planoId,
    amount: 0,
    status: 'paid',
    origem: 'admin',
    adminEmail: admin,
    motivo: motivo || 'Concessão manual',
    pagoEm: auth.agora(),
    criadoEm: auth.agora()
  });

  log.info('acesso_concedido_admin', { userId: user._id, admin, dias: diasEfetivo, plano: planoId });
  return dataExpiracao;
}

module.exports = {
  precoEmCentavos,
  criarCheckout,
  webhook,
  reconciliar,
  consultarStatusNaGateway,
  concessaoManual,
  aplicarPagamento
};
