'use strict';

// Camada de dados sobre D1.
//
// ## Por que os mapas de linha
//
// O resto do projeto foi escrito contra o NeDB e fala em `camelCase` com `_id`
// (`user.senhaHash`, `payment.aplicadoEm`). D1 devolve `snake_case` com `id`.
// Traduzir na fronteira, com `linhaParaX` e `xParaLinha`, mantém as regras de
// negócio, as rotas e os testes iguais aos que já estavam escritos e revisados —
// a única coisa que muda é de onde o dado vem.
//
// ## Datas
//
// Toda data é TEXT em ISO 8601 UTC. Isso permite comparar com `<`, `>` e
// `ORDER BY` direto, porque string ISO ordena como tempo. O helper `iso()`
// centraliza a conversão; nunca use `toISOString()` espalhado pelo código.

const AGORA = () => new Date().toISOString();

function iso(valor) {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) return valor.toISOString();
  if (typeof valor === 'number') return new Date(valor).toISOString();
  return String(valor);
}

function data(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

function inteiroOuZero(valor) {
  return Number.isInteger(valor) ? valor : 0;
}

function entidade(valor) {
  return Boolean(valor && Number(valor) === 1);
}

function id() {
  return crypto.randomUUID();
}

/* ------------------------------------------------------------------ users */

function linhaParaUsuario(row) {
  if (!row) return null;
  return {
    _id: row.id,
    nome: row.nome,
    email: row.email,
    senhaHash: row.senha_hash,
    plano: row.plano,
    tipoPlano: row.tipo_plano,
    statusPagamento: row.status_pagamento,
    trialInicio: row.trial_inicio,
    trialFim: row.trial_fim,
    dataInicio: row.data_inicio,
    dataExpiracao: row.data_expiracao,
    ultimoAcessoEm: row.ultimo_acesso_em,
    ultimoPagamentoEm: row.ultimo_pagamento_em,
    senhaAlteradaEm: row.senha_alterada_em,
    loginFalhas: inteiroOuZero(row.login_falhas),
    bloqueadoAte: row.bloqueado_ate,
    bloqueado: entidade(row.bloqueado),
    admin: entidade(row.admin),
    criadoEm: row.criado_em
  };
}

/**
 * Os `INSERT` já montam um objeto em `camelCase` (é a entrada que o resto do
 * projeto usa), então não podem passar por `linhaParaUsuario`, que espera a
 * linha `snake_case` do D1. Passar o objeto errado por ali devolvia
 * `{_id: undefined, nome: undefined, ...}`, e o cadastro seguia com um usuário
 * sem id: a sessão criada logo depois saía com `user_id` vazio. Este construtor
 * produz o mesmo formato de `linhaParaUsuario`, alimentado pela entrada em vez
 * da linha.
 */
function usuarioDeValores(v) {
  return {
    _id: v._id,
    nome: v.nome,
    email: v.email,
    senhaHash: v.senhaHash,
    plano: v.plano,
    tipoPlano: v.tipoPlano ?? null,
    statusPagamento: v.statusPagamento,
    trialInicio: v.trialInicio ?? null,
    trialFim: v.trialFim ?? null,
    dataInicio: v.dataInicio ?? null,
    dataExpiracao: v.dataExpiracao ?? null,
    ultimoAcessoEm: v.ultimoAcessoEm ?? null,
    ultimoPagamentoEm: v.ultimoPagamentoEm ?? null,
    senhaAlteradaEm: v.senhaAlteradaEm ?? null,
    loginFalhas: inteiroOuZero(v.loginFalhas),
    bloqueadoAte: v.bloqueadoAte ?? null,
    bloqueado: Boolean(v.bloqueado),
    admin: Boolean(v.admin),
    criadoEm: v.criadoEm
  };
}

const COLUNAS_USUARIO = {
  nome: 'nome',
  email: 'email',
  senhaHash: 'senha_hash',
  plano: 'plano',
  tipoPlano: 'tipo_plano',
  statusPagamento: 'status_pagamento',
  trialInicio: 'trial_inicio',
  trialFim: 'trial_fim',
  dataInicio: 'data_inicio',
  dataExpiracao: 'data_expiracao',
  ultimoAcessoEm: 'ultimo_acesso_em',
  ultimoPagamentoEm: 'ultimo_pagamento_em',
  senhaAlteradaEm: 'senha_alterada_em',
  loginFalhas: 'login_falhas',
  bloqueadoAte: 'bloqueado_ate',
  bloqueado: 'bloqueado',
  admin: 'admin',
  criadoEm: 'criado_em'
};

function set(campos) {
  const partes = [];
  const valores = [];
  for (const [chave, valor] of Object.entries(campos)) {
    const coluna = COLUNAS_USUARIO[chave];
    if (!coluna) throw new Error(`coluna de usuário desconhecida: ${chave}`);
    partes.push(`${coluna} = ?`);
    valores.push(typeof valor === 'boolean' ? (valor ? 1 : 0) : valor);
  }
  return { sql: partes.join(', '), valores };
}

function users_porId(env, userId) {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first().then(linhaParaUsuario);
}

function users_porEmail(env, email) {
  return env.DB.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').bind(email).first().then(linhaParaUsuario);
}

async function users_inserir(env, user) {
  const novo = {
    _id: user._id || id(),
    nome: user.nome,
    email: String(user.email).toLowerCase(),
    senhaHash: user.senhaHash,
    plano: user.plano || 'trial',
    tipoPlano: user.tipoPlano ?? null,
    statusPagamento: user.statusPagamento || 'trial',
    trialInicio: iso(user.trialInicio),
    trialFim: iso(user.trialFim),
    dataInicio: iso(user.dataInicio),
    dataExpiracao: iso(user.dataExpiracao),
    ultimoAcessoEm: iso(user.ultimoAcessoEm),
    ultimoPagamentoEm: iso(user.ultimoPagamentoEm),
    senhaAlteradaEm: iso(user.senhaAlteradaEm),
    loginFalhas: user.loginFalhas || 0,
    bloqueadoAte: iso(user.bloqueadoAte),
    bloqueado: user.bloqueado ? 1 : 0,
    admin: user.admin ? 1 : 0,
    criadoEm: iso(user.criadoEm) || AGORA()
  };

  await env.DB.prepare(
    `INSERT INTO users (id, nome, email, senha_hash, plano, tipo_plano, status_pagamento,
       trial_inicio, trial_fim, data_inicio, data_expiracao, ultimo_acesso_em,
       ultimo_pagamento_em, senha_alterada_em, login_falhas, bloqueado_ate,
       bloqueado, admin, criado_em)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      novo._id, novo.nome, novo.email, novo.senhaHash, novo.plano, novo.tipoPlano, novo.statusPagamento,
      novo.trialInicio, novo.trialFim, novo.dataInicio, novo.dataExpiracao, novo.ultimoAcessoEm,
      novo.ultimoPagamentoEm, novo.senhaAlteradaEm, novo.loginFalhas, novo.bloqueadoAte,
      novo.bloqueado, novo.admin, novo.criadoEm
    )
    .run();

  return usuarioDeValores(novo);
}

// `$set` e `$unset` viram dois `UPDATE`. Um `NULL` no SQLite é a forma de
// "remover" o valor, que é o que o NeDB fazia com `$unset`.
async function users_atualizar(env, userId, campos) {
  const { sql, valores } = set(campos);
  if (!sql) return;
  await env.DB.prepare(`UPDATE users SET ${sql} WHERE id = ?`).bind(...valores, userId).run();
}

async function users_removerCampos(env, userId, campos) {
  const colunas = campos.map(chave => COLUNAS_USUARIO[chave]).filter(Boolean);
  if (!colunas.length) return;
  const sql = colunas.map(coluna => `${coluna} = NULL`).join(', ');
  await env.DB.prepare(`UPDATE users SET ${sql} WHERE id = ?`).bind(userId).run();
}

function users_todos(env) {
  return env.DB.prepare('SELECT * FROM users ORDER BY criado_em DESC').all().then(r => r.results.map(linhaParaUsuario));
}

async function users_contar(env, filtro = {}) {
  const { sql, valores } = montarFiltroUsuarios(filtro);
  const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM users ${sql}`).bind(...valores).first();
  return Number(row?.total || 0);
}

async function users_listar(env, { filtro = {}, ordem = 'criado_em DESC', limite = 25, offset = 0 } = {}) {
  const { sql, valores } = montarFiltroUsuarios(filtro);
  const rows = await env.DB.prepare(`SELECT * FROM users ${sql} ORDER BY ${ordem} LIMIT ? OFFSET ?`)
    .bind(...valores, limite, offset)
    .all();
  return rows.results.map(linhaParaUsuario);
}

function montarFiltroUsuarios(filtro = {}) {
  const condicoes = [];
  const valores = [];

  if (filtro.busca) {
    condicoes.push('(nome LIKE ? ESCAPE \'\\\' OR email LIKE ? ESCAPE \'\\\')');
    const termo = `%${escaparLike(String(filtro.busca))}%`;
    valores.push(termo, termo);
  }

  if (filtro.plano) {
    condicoes.push('plano = ?');
    valores.push(String(filtro.plano));
  }

  return {
    sql: condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '',
    valores
  };
}

function escaparLike(termo) {
  return termo.replace(/[\\%_]/g, char => `\\${char}`);
}

async function users_excluir(env, userId) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM payments WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM resets WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId)
  ]);
}

function users_estaEmDia(env) {
  const agora = AGORA();
  return env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN (plano = 'pro' AND data_expiracao > ?) OR trial_fim > ? THEN 1 ELSE 0 END) AS ativos,
       SUM(CASE WHEN plano = 'pro' THEN 1 ELSE 0 END) AS pro,
       SUM(CASE WHEN plano = 'trial' THEN 1 ELSE 0 END) AS trial,
       SUM(CASE WHEN bloqueado = 1 THEN 1 ELSE 0 END) AS bloqueados
     FROM users`
  )
    .bind(agora, agora)
    .first();
}

/* --------------------------------------------------------------- sessions */

function linhaParaSessao(row) {
  if (!row) return null;
  return {
    _id: row.id,
    tokenHash: row.token_hash,
    userId: row.user_id,
    escopo: row.escopo,
    criadoEm: row.criado_em,
    expiresAt: row.expira_em
  };
}

async function sessions_inserir(env, sessao) {
  const nova = {
    _id: sessao._id || id(),
    tokenHash: sessao.tokenHash,
    userId: sessao.userId,
    escopo: sessao.escopo || 'web',
    criadoEm: iso(sessao.criadoEm) || AGORA(),
    expiresAt: iso(sessao.expiresAt)
  };

  await env.DB.prepare(
    'INSERT INTO sessions (id, token_hash, user_id, escopo, criado_em, expira_em) VALUES (?,?,?,?,?,?)'
  )
    .bind(nova._id, nova.tokenHash, nova.userId, nova.escopo, nova.criadoEm, nova.expiresAt)
    .run();

  return {
    _id: nova._id,
    tokenHash: nova.tokenHash,
    userId: nova.userId,
    escopo: nova.escopo,
    criadoEm: nova.criadoEm,
    expiresAt: nova.expiresAt
  };
}

function sessions_porTokenHash(env, tokenHash) {
  return env.DB.prepare('SELECT * FROM sessions WHERE token_hash = ?').bind(tokenHash).first().then(linhaParaSessao);
}

async function sessions_listarPorUsuario(env, userId) {
  const rows = await env.DB.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY criado_em ASC').bind(userId).all();
  return rows.results.map(linhaParaSessao);
}

async function sessions_contarPorUsuario(env, userId) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM sessions WHERE user_id = ?').bind(userId).first();
  return Number(row?.total || 0);
}

async function sessions_contarPorUsuarioEscopo(env, userId, escopo) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM sessions WHERE user_id = ? AND escopo = ?')
    .bind(userId, escopo)
    .first();
  return Number(row?.total || 0);
}

async function sessions_removerPorId(env, sessaoId) {
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessaoId).run();
}

async function sessions_removerPorUsuario(env, userId) {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

async function sessions_removerPorTokenHash(env, tokenHash) {
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

// A extensão tem um token só por conta: criar um novo derruba o anterior.
async function sessions_removerExtensaoExceto(env, userId, tokenHash) {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND escopo = 'extensao' AND token_hash != ?")
    .bind(userId, tokenHash)
    .run();
}

async function sessions_expurgar(env) {
  const r = await env.DB.prepare('DELETE FROM sessions WHERE expira_em <= ?').bind(AGORA()).run();
  return Number(r.meta?.changes || 0);
}

/* --------------------------------------------------------------- payments */

function linhaParaPagamento(row) {
  if (!row) return null;
  return {
    _id: row.id,
    order_nsu: row.order_nsu,
    userId: row.user_id,
    plan: row.plan,
    amount: row.amount,
    status: row.status,
    checkoutUrl: row.checkout_url,
    transaction_nsu: row.transaction_nsu,
    invoice_slug: row.invoice_slug,
    receipt_url: row.receipt_url,
    origem: row.origem,
    adminEmail: row.admin_email,
    motivo: row.motivo,
    erro: row.erro,
    dataExpiracaoConcedida: row.data_expiracao_concedida,
    criadoEm: row.criado_em,
    pagoEm: row.pago_em,
    aplicadoEm: row.aplicado_em
  };
}

async function payments_inserir(env, pagamento) {
  const novo = {
    _id: pagamento._id || id(),
    order_nsu: pagamento.order_nsu,
    userId: pagamento.userId,
    plan: pagamento.plan,
    amount: pagamento.amount,
    status: pagamento.status || 'pending',
    checkoutUrl: pagamento.checkoutUrl ?? null,
    transaction_nsu: pagamento.transaction_nsu ?? null,
    invoice_slug: pagamento.invoice_slug ?? null,
    receipt_url: pagamento.receipt_url ?? null,
    origem: pagamento.origem ?? null,
    adminEmail: pagamento.adminEmail ?? null,
    motivo: pagamento.motivo ?? null,
    erro: pagamento.erro ?? null,
    dataExpiracaoConcedida: iso(pagamento.dataExpiracaoConcedida),
    criadoEm: iso(pagamento.criadoEm) || AGORA(),
    pagoEm: iso(pagamento.pagoEm),
    aplicadoEm: iso(pagamento.aplicadoEm)
  };

  await env.DB.prepare(
    `INSERT INTO payments (id, order_nsu, user_id, plan, amount, status, checkout_url,
       transaction_nsu, invoice_slug, receipt_url, origem, admin_email, motivo, erro,
       data_expiracao_concedida, criado_em, pago_em, aplicado_em)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      novo._id, novo.order_nsu, novo.userId, novo.plan, novo.amount, novo.status, novo.checkoutUrl,
      novo.transaction_nsu, novo.invoice_slug, novo.receipt_url, novo.origem, novo.adminEmail, novo.motivo, novo.erro,
      novo.dataExpiracaoConcedida, novo.criadoEm, novo.pagoEm, novo.aplicadoEm
    )
    .run();

  return {
    _id: novo._id,
    order_nsu: novo.order_nsu,
    userId: novo.userId,
    plan: novo.plan,
    amount: novo.amount,
    status: novo.status,
    checkoutUrl: novo.checkoutUrl,
    transaction_nsu: novo.transaction_nsu,
    invoice_slug: novo.invoice_slug,
    receipt_url: novo.receipt_url,
    origem: novo.origem,
    adminEmail: novo.adminEmail,
    motivo: novo.motivo,
    erro: novo.erro,
    dataExpiracaoConcedida: novo.dataExpiracaoConcedida,
    criadoEm: novo.criadoEm,
    pagoEm: novo.pagoEm,
    aplicadoEm: novo.aplicadoEm
  };
}

function payments_porOrder(env, orderNsu) {
  return env.DB.prepare('SELECT * FROM payments WHERE order_nsu = ?').bind(orderNsu).first().then(linhaParaPagamento);
}

function payments_porId(env, pagamentoId) {
  return env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(pagamentoId).first().then(linhaParaPagamento);
}

async function payments_atualizar(env, orderNsu, campos) {
  const mapa = {
    status: 'status',
    checkoutUrl: 'checkout_url',
    transaction_nsu: 'transaction_nsu',
    invoice_slug: 'invoice_slug',
    receipt_url: 'receipt_url',
    origem: 'origem',
    erro: 'erro',
    pagoEm: 'pago_em',
    aplicadoEm: 'aplicado_em',
    dataExpiracaoConcedida: 'data_expiracao_concedida'
  };

  const partes = [];
  const valores = [];
  for (const [chave, valor] of Object.entries(campos)) {
    const coluna = mapa[chave];
    if (!coluna) throw new Error(`coluna de pagamento desconhecida: ${chave}`);
    partes.push(`${coluna} = ?`);
    valores.push(iso(valor));
  }

  if (!partes.length) return;
  await env.DB.prepare(`UPDATE payments SET ${partes.join(', ')} WHERE order_nsu = ?`)
    .bind(...valores, orderNsu)
    .run();
}

async function payments_atualizarPorId(env, pagamentoId, campos) {
  const mapa = {
    status: 'status',
    dataExpiracaoConcedida: 'data_expiracao_concedida',
    aplicadoEm: 'aplicado_em',
    pagoEm: 'pago_em'
  };

  const partes = [];
  const valores = [];
  for (const [chave, valor] of Object.entries(campos)) {
    const coluna = mapa[chave];
    if (!coluna) throw new Error(`coluna de pagamento desconhecida: ${chave}`);
    partes.push(`${coluna} = ?`);
    valores.push(iso(valor));
  }

  if (!partes.length) return;
  await env.DB.prepare(`UPDATE payments SET ${partes.join(', ')} WHERE id = ?`).bind(...valores, pagamentoId).run();
}

/**
 * Desfaz a reserva de `payments_reservar` para que a reconciliação possa tentar
 * de novo.
 *
 * O status volta para `pending`, e não para `NULL`: `payments.status` é
 * `NOT NULL` no esquema, e escrever `NULL` aqui fazia o próprio rollback
 * estourar a restrição dentro do `catch` de `aplicarPagamento` — ou seja, a
 * falha original (não conseguir conceder o acesso) era substituída por um
 * "NOT NULL constraint failed" sem nenhuma pista do que aconteceu.
 */
async function payments_desfazerReserva(env, pagamentoId) {
  await env.DB.prepare(
    "UPDATE payments SET aplicado_em = NULL, pago_em = NULL, status = 'pending' WHERE id = ?"
  )
    .bind(pagamentoId)
    .run();
}

/**
 * Reserva atômica do pedido: só uma execução do `UPDATE` acha `aplicado_em IS
 * NULL` e afeta a linha. As outras recebem `changes = 0` e saem sem cobrar de
 * novo. É o que substitui o `update` condicional do NeDB e mantém o webhook
 * idempotente mesmo com reenvio simultâneo.
 */
async function payments_reservar(env, pagamentoId, extras = {}) {
  const r = await env.DB.prepare(
    `UPDATE payments
        SET status = 'paid', pago_em = ?, aplicado_em = ?,
            transaction_nsu = COALESCE(?, transaction_nsu),
            invoice_slug = COALESCE(?, invoice_slug),
            receipt_url = COALESCE(?, receipt_url),
            origem = COALESCE(?, origem)
      WHERE id = ? AND aplicado_em IS NULL`
  )
    .bind(
      AGORA(),
      AGORA(),
      extras.transaction_nsu ?? null,
      extras.invoice_slug ?? null,
      extras.receipt_url ?? null,
      extras.origem ?? null,
      pagamentoId
    )
    .run();

  return Number(r.meta?.changes || 0);
}

async function payments_pendentes(env, userId, limite = 3) {
  const rows = await env.DB.prepare(
    "SELECT * FROM payments WHERE user_id = ? AND status != 'paid' ORDER BY criado_em DESC LIMIT ?"
  )
    .bind(userId, limite)
    .all();
  return rows.results.map(linhaParaPagamento);
}

async function payments_porUsuario(env, userId) {
  const rows = await env.DB.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY criado_em DESC').bind(userId).all();
  return rows.results.map(linhaParaPagamento);
}

async function payments_ultimoPago(env, userId) {
  const row = await env.DB.prepare(
    "SELECT * FROM payments WHERE user_id = ? AND status = 'paid' ORDER BY criado_em DESC LIMIT 1"
  )
    .bind(userId)
    .first();
  return linhaParaPagamento(row);
}

async function payments_listar(env, { filtro = {}, limite = 25, offset = 0 } = {}) {
  const condicoes = [];
  const valores = [];
  if (filtro.status) {
    condicoes.push('status = ?');
    valores.push(String(filtro.status));
  }
  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  const rows = await env.DB.prepare(`SELECT * FROM payments ${where} ORDER BY criado_em DESC LIMIT ? OFFSET ?`)
    .bind(...valores, limite, offset)
    .all();
  return rows.results.map(linhaParaPagamento);
}

async function payments_contar(env, filtro = {}) {
  const condicoes = [];
  const valores = [];
  if (filtro.status) {
    condicoes.push('status = ?');
    valores.push(String(filtro.status));
  }
  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM payments ${where}`).bind(...valores).first();
  return Number(row?.total || 0);
}

async function payments_resumo(env) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status != 'paid' THEN 1 ELSE 0 END) AS pendentes
     FROM payments`
  ).first();
  return { total: Number(row?.total || 0), pendentes: Number(row?.pendentes || 0) };
}

async function payments_removerPorUsuario(env, userId) {
  await env.DB.prepare('DELETE FROM payments WHERE user_id = ?').bind(userId).run();
}

/* ----------------------------------------------------------------- resets */

function linhaParaReset(row) {
  if (!row) return null;
  return {
    _id: row.id,
    tokenHash: row.token_hash,
    userId: row.user_id,
    criadoEm: row.criado_em,
    expiraEm: row.expira_em,
    usadoEm: row.usado_em
  };
}

async function resets_inserir(env, reset) {
  const novo = {
    _id: reset._id || id(),
    tokenHash: reset.tokenHash,
    userId: reset.userId,
    criadoEm: iso(reset.criadoEm) || AGORA(),
    expiraEm: iso(reset.expiraEm),
    usadoEm: iso(reset.usadoEm)
  };

  await env.DB.prepare('INSERT INTO resets (id, token_hash, user_id, criado_em, expira_em, usado_em) VALUES (?,?,?,?,?,?)')
    .bind(novo._id, novo.tokenHash, novo.userId, novo.criadoEm, novo.expiraEm, novo.usadoEm)
    .run();

  return {
    _id: novo._id,
    tokenHash: novo.tokenHash,
    userId: novo.userId,
    criadoEm: novo.criadoEm,
    expiraEm: novo.expiraEm,
    usadoEm: novo.usadoEm
  };
}

function resets_porTokenHash(env, tokenHash) {
  return env.DB.prepare('SELECT * FROM resets WHERE token_hash = ?').bind(tokenHash).first().then(linhaParaReset);
}

async function resets_atualizarExpiraEm(env, tokenHash, quando) {
  await env.DB.prepare('UPDATE resets SET expira_em = ? WHERE token_hash = ?').bind(iso(quando), tokenHash).run();
}

async function resets_marcarUsado(env, resetId) {
  await env.DB.prepare('UPDATE resets SET usado_em = ? WHERE id = ?').bind(AGORA(), resetId).run();
}

async function resets_expurgar(env) {
  const r = await env.DB.prepare('DELETE FROM resets WHERE expira_em <= ?').bind(AGORA()).run();
  return Number(r.meta?.changes || 0);
}

/* ------------------------------------------------------------ rate limits */

const JANELAS = { 0: 10, 1: 60 };

/**
 * Janela fixa no D1, para os limites que o binding nativo não cobre (o edge só
 * aceita 10 s ou 60 s, e cadastro/login precisam de 15 min e 1 h).
 *
 * `ON CONFLICT DO UPDATE` com `RETURNING` faz o incremento e a leitura em uma
 * única instrução atômica: não existe o `SELECT` seguido de `UPDATE` que daria
 * janela para duas requisições passarem juntas pelo mesmo limite.
 */
async function rateLimit_atingir(env, nome, identificador, janelaMs, maximo) {
  const janelaSegundos = Math.max(1, Math.round(janelaMs / 1000));
  const chave = `${nome}:${identificador}:${janelaSegundos}`;
  const janela = Math.floor(Date.now() / 1000 / janelaSegundos);
  const expiraEm = (janela + 2) * janelaSegundos;

  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (chave, janela, contagem, expira_em) VALUES (?, ?, 1, ?)
       ON CONFLICT(chave) DO UPDATE SET
         contagem = CASE WHEN rate_limits.janela = excluded.janela THEN rate_limits.contagem + 1 ELSE 1 END,
         janela   = excluded.janela,
         expira_em = excluded.expira_em
     RETURNING contagem, janela`
  )
    .bind(chave, janela, expiraEm)
    .first();

  const contagem = Number(row?.contagem || 1);
  return {
    permitido: contagem <= maximo,
    restantes: Math.max(0, maximo - contagem),
    expiraEm,
    janelaSegundos
  };
}

/**
 * Remove as janelas vencidas.
 *
 * Não dá para filtrar pelo índice `janela`: ele é um bucket em unidades da
 * própria janela (`floor(agora / janelaSegundos)`), então uma janela de 15 min
 * e uma de 1 h produzem números em escalas diferentes e a comparação entre
 * elas não significa nada. Pior, comparar com `epoch - 3600` apagava todas as
 * linhas vivas: o bucket de 15 min dá ~2,9 milhões, e o corte ficava em ~1,78
 * bilhão, então todo contador válido era considerado antigo e removido — a
 * proteção de login era zerada uma vez por dia. A coluna `expira_em` guarda o
 * instante em segundos e compara direto com o relógio.
 */
async function rateLimit_expurgar(env) {
  const r = await env.DB.prepare('DELETE FROM rate_limits WHERE expira_em <= ?').bind(AGORA()).run();
  return Number(r.meta?.changes || 0);
}

/* --------------------------------------------------------------- sistema */

/**
 * Garante a linha única de `sistema`. É idempotente (`INSERT OR IGNORE`), então
 * pode ser chamado a cada requisição sem custo: o índice primário resolve e nada
 * é gravado quando a linha já existe.
 */
async function sistema_inicializar(env, versao) {
  await env.DB.prepare('INSERT OR IGNORE INTO sistema (id, instalado_em, versao) VALUES (1, ?, ?)')
    .bind(AGORA(), versao)
    .run();
}

function sistema_info(env) {
  return env.DB.prepare('SELECT * FROM sistema WHERE id = 1').first();
}

async function sistema_limpo(env) {
  await env.DB.prepare('UPDATE sistema SET ultima_limpeza = ? WHERE id = 1').bind(AGORA()).run();
}

/* ------------------------------------------------------------- manutenção */

/**
 * Roda pelo cron diário. No servidor antigo isto eram dois `setInterval` no
 * processo; aqui nada roda sozinho, então a limpeza depende deste trigger.
 */
async function manutencao(env, log) {
  const sessoes = await sessions_expurgar(env);
  const resets = await resets_expurgar(env);
  const limites = await rateLimit_expurgar(env);
  await sistema_limpo(env);
  log.info('manutencao', { sessoes, resets, limites });
  return { sessoes, resets, limites };
}

module.exports = {
  AGORA,
  iso,
  data,
  id,
  escaparLike,

  users_porId,
  users_porEmail,
  users_inserir,
  users_atualizar,
  users_removerCampos,
  users_todos,
  users_contar,
  users_listar,
  users_excluir,
  users_estaEmDia,

  sessions_inserir,
  sessions_porTokenHash,
  sessions_listarPorUsuario,
  sessions_contarPorUsuario,
  sessions_contarPorUsuarioEscopo,
  sessions_removerPorId,
  sessions_removerPorUsuario,
  sessions_removerPorTokenHash,
  sessions_removerExtensaoExceto,
  sessions_expurgar,

  payments_inserir,
  payments_porOrder,
  payments_porId,
  payments_atualizar,
  payments_atualizarPorId,
  payments_desfazerReserva,
  payments_reservar,
  payments_pendentes,
  payments_porUsuario,
  payments_ultimoPago,
  payments_listar,
  payments_contar,
  payments_resumo,
  payments_removerPorUsuario,

  resets_inserir,
  resets_porTokenHash,
  resets_atualizarExpiraEm,
  resets_marcarUsado,
  resets_expurgar,

  rateLimit_atingir,
  rateLimit_expurgar,

  sistema_inicializar,
  sistema_info,
  sistema_limpo,
  manutencao
};
