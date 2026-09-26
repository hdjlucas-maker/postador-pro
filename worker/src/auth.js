'use strict';

// Autenticação: cadastro, login, sessões de cookie e tokens da extensão.
//
// A lógica é a mesma do servidor Express, com três trocas: o hash de senha vem
// de `crypto.hasharSenha` (PBKDF2) em vez de `bcryptjs`, o banco é D1 e os
// middlewares do Express viraram middlewares do Hono que escrevem em `c.user`
// e `c.acesso`.

const crypto = require('./crypto');
const configMod = require('./config');
const db = require('./db');
const security = require('./security');
const log = require('./log');

const MAX_SESSOES_POR_CONTA = 5;

function agora() {
  return new Date();
}

function addDays(date, days) {
  return new Date(new Date(date).getTime() + days * 86400000);
}

function addMinutos(date, minutos) {
  return new Date(new Date(date).getTime() + minutos * 60000);
}

function normalizarEmail(valor) {
  return String(valor || '').trim().toLowerCase();
}

function emailValido(email) {
  return /^\S+@\S+\.\S+$/.test(email) && email.length <= 254;
}

function forcaSenha(senha) {
  return String(senha || '').length >= 8 && String(senha || '').length <= 200;
}

function eAdmin(user, env) {
  if (!user) return false;
  if (user.admin === true) return true;
  return configMod.config(env).ADMIN_EMAILS.includes(String(user.email || '').toLowerCase());
}

function tokenDeExtensaoExpiracao(env) {
  const cfg = configMod.config(env);
  return addDays(agora(), cfg.TOKEN_EXTENSAO_DIAS);
}

async function criarSessao(env, userId) {
  const cfg = configMod.config(env);
  const token = crypto.novoToken(32);

  await db.sessions_inserir(env, {
    tokenHash: crypto.sha256Hex(token),
    userId,
    escopo: 'web',
    criadoEm: agora(),
    expiresAt: addDays(agora(), cfg.SESSION_DAYS)
  });

  // Cinco sessões por conta. Um login repetido por script não acumula cookie
  // indefinidamente.
  const existentes = await db.sessions_listarPorUsuario(env, userId);
  const excedente = existentes.length - MAX_SESSOES_POR_CONTA;
  if (excedente > 0) {
    const antigas = existentes.slice(0, excedente);
    await env.DB.batch(antigas.map(s => env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(s._id)));
  }

  return token;
}

/**
 * O token da extensão usa o mesmo formato e o mesmo hash SHA-256 da sessão web.
 * A diferença é o transporte: a extensão não tem cookie jar, então manda
 * `Authorization: Bearer`, que o navegador nunca anexa sozinho num ataque
 * cross-site.
 */
async function criarTokenExtensao(env, userId) {
  const token = crypto.novoToken(32);

  await db.sessions_inserir(env, {
    tokenHash: crypto.sha256Hex(token),
    userId,
    escopo: 'extensao',
    criadoEm: agora(),
    expiresAt: tokenDeExtensaoExpiracao(env)
  });

  // Um token só por conta: pedir um novo derruba o antigo, o que impede que
  // tokens vazados continuem válidos ao mesmo tempo.
  await db.sessions_removerExtensaoExceto(env, userId, crypto.sha256Hex(token));

  return token;
}

async function sessaoPorToken(env, token) {
  if (!token) return null;

  const sessao = await db.sessions_porTokenHash(env, crypto.sha256Hex(token));
  if (!sessao) return null;

  if (new Date(sessao.expiresAt) <= agora()) {
    await db.sessions_removerPorId(env, sessao._id);
    return null;
  }

  return sessao;
}

async function usuarioPorToken(env, token) {
  const sessao = await sessaoPorToken(env, token);
  if (!sessao) return null;

  const user = await db.users_porId(env, sessao.userId);
  if (!user || user.bloqueado) return null;

  return user;
}

async function encerrarToken(c) {
  const token = security.extrairBearer(c);
  if (!token) return;
  await db.sessions_removerPorTokenHash(c.env, crypto.sha256Hex(token));
}

function aplicarSessao(c, token) {
  const cfg = configMod.config(c.env);
  security.definirCookie(c, cfg.SESSION_COOKIE, token, cfg.SESSION_DAYS * 86400);
  security.rotacionarCsrf(c);
}

function encerrarSessao(c) {
  const cfg = configMod.config(c.env);
  security.encerrarCookie(c, cfg.SESSION_COOKIE);
}

async function usuarioAtual(c) {
  const cfg = configMod.config(c.env);
  const token = c.req.cookie(cfg.SESSION_COOKIE);
  if (!token) return null;
  return usuarioPorToken(c.env, token);
}

function estadoDeAcesso(user) {
  if (!user) return { permitido: false, status: 'nao_autenticado' };

  if (user.plano === 'pro' && user.dataExpiracao && new Date(user.dataExpiracao) > agora()) {
    return { permitido: true, status: 'pro' };
  }

  if (user.trialFim && new Date(user.trialFim) > agora()) {
    return { permitido: true, status: 'trial' };
  }

  return { permitido: false, status: 'expirado' };
}

function limitesDoPlano(env, user) {
  const cfg = configMod.config(env);
  return user && user.plano === 'pro' ? cfg.PLAN_LIMITS.pro : cfg.PLAN_LIMITS.trial;
}

/* ------------------------------------------------------------- middlewares */

// Os middlewares não recebem `env`: o app é montado uma vez, no módulo, e o
// objeto de ambiente só existe durante a requisição. Ler de `c.env` é o que
// permite montar o roteador uma única vez em vez de a cada requisição.
function exigirToken() {
  return async function middleware(c, next) {
    const user = await usuarioPorToken(c.env, security.extrairBearer(c));
    if (!user) {
      return c.json({ erro: 'Faça login na extensão para continuar.', codigo: 'nao_autenticado' }, 401);
    }
    c.set('user', user);
    c.set('acesso', estadoDeAcesso(user));
    return next();
  };
}

function exigirTokenComAcesso() {
  return async function middleware(c, next) {
    const user = await usuarioPorToken(c.env, security.extrairBearer(c));
    const estado = estadoDeAcesso(user);

    if (!estado.permitido) {
      return c.json({ erro: 'Faça login na extensão para continuar.', codigo: 'nao_autenticado' }, 401);
    }

    c.set('user', user);
    c.set('acesso', estado);
    return next();
  };
}

function exigirLogin() {
  return async function middleware(c, next) {
    const user = await usuarioAtual(c);
    if (!user) {
      return c.json({ erro: 'Faça login para continuar.', codigo: 'nao_autenticado' }, 401);
    }
    c.set('user', user);
    return next();
  };
}

function exigirAcesso() {
  return async function middleware(c, next) {
    const user = await usuarioAtual(c);
    const estado = estadoDeAcesso(user);

    if (!estado.permitido) {
      return c.json({ erro: 'Seu acesso expirou. Escolha um plano para continuar.', codigo: 'acesso_expirado' }, 402);
    }

    c.set('user', user);
    c.set('acesso', estado);
    return next();
  };
}

function exigirAdmin() {
  return async function middleware(c, next) {
    if (!eAdmin(c.get('user'), c.env)) {
      return c.json({ erro: 'Acesso restrito ao administrador.', codigo: 'sem_permissao' }, 403);
    }
    return next();
  };
}

/* ------------------------------------------------------------- regras */

async function registrar(env, { nome, email, senha }) {
  const cfg = configMod.config(env);
  const nomeLimpo = String(nome || '').trim();
  const emailLimpo = normalizarEmail(email);
  const senhaTexto = String(senha || '');

  if (nomeLimpo.length < 2 || nomeLimpo.length > 80) {
    throw Object.assign(new Error('Informe seu nome (2 a 80 caracteres).'), { status: 400 });
  }

  if (!emailValido(emailLimpo)) {
    throw Object.assign(new Error('Informe um e-mail válido.'), { status: 400 });
  }

  if (!forcaSenha(senhaTexto)) {
    throw Object.assign(new Error('A senha precisa ter pelo menos 8 caracteres.'), { status: 400 });
  }

  const existente = await db.users_porEmail(env, emailLimpo);
  if (existente) {
    throw Object.assign(new Error('Este e-mail já está cadastrado.'), { status: 409 });
  }

  const criadoEm = agora();
  const admin = cfg.ADMIN_EMAILS.includes(emailLimpo);

  const user = await db.users_inserir(env, {
    nome: nomeLimpo,
    email: emailLimpo,
    senhaHash: await crypto.hasharSenha(senhaTexto, cfg.PBKDF2_ITERACOES),
    criadoEm,
    trialInicio: criadoEm,
    trialFim: addDays(criadoEm, cfg.TRIAL_DAYS),
    plano: 'trial',
    statusPagamento: 'trial',
    admin
  });

  log.info('conta_criada', { userId: user._id, email: emailLimpo, admin });
  return user;
}

async function autenticar(env, { email, senha }) {
  const cfg = configMod.config(env);
  const emailLimpo = normalizarEmail(email);
  const senhaTexto = String(senha || '');

  const user = await db.users_porEmail(env, emailLimpo);

  if (!user) {
    // Gasta o mesmo tempo de derivada de um login real. Sem isso, "e-mail
    // inexistente" voltaria em 1 ms e "existe, senha errada" em 60 ms, e a
    // diferença revelaria quem tem conta.
    await crypto.gastarTempoDeDerivada(cfg.PBKDF2_ITERACOES);
    throw Object.assign(new Error('E-mail ou senha incorretos.'), { status: 401 });
  }

  if (user.bloqueado) {
    throw Object.assign(new Error('Esta conta está bloqueada. Fale com o suporte.'), { status: 403 });
  }

  // O rate limit por IP segura uma origem. Isto segura a conta: quem tenta de
  // vários endereços IP diferentes bate na mesma contagem e trava a conta.
  if (user.bloqueadoAte && new Date(user.bloqueadoAte) > agora()) {
    const minutos = Math.max(1, Math.ceil((new Date(user.bloqueadoAte) - agora()) / 60000));
    log.warn('login_bloqueado', { userId: user._id, minutos });
    throw Object.assign(
      new Error(`Muitas tentativas erradas. Tente de novo em ${minutos} minuto${minutos > 1 ? 's' : ''}.`),
      { status: 429, codigo: 'conta_bloqueada' }
    );
  }

  const confere = await crypto.confereSenha(senhaTexto, user.senhaHash);
  if (!confere) {
    const falhas = (user.loginFalhas || 0) + 1;
    const trava = falhas >= cfg.LOGIN_FALHAS_MAX;

    await db.users_atualizar(env, user._id, trava
      ? { loginFalhas: 0, bloqueadoAte: addMinutos(agora(), cfg.LOGIN_BLOQUEIO_MINUTOS) }
      : { loginFalhas: falhas });

    if (trava) {
      log.warn('conta_bloqueada_por_falhas', {
        userId: user._id,
        falhas,
        minutos: cfg.LOGIN_BLOQUEIO_MINUTOS
      });
    }

    throw Object.assign(new Error('E-mail ou senha incorretos.'), { status: 401 });
  }

  await db.users_atualizar(env, user._id, { ultimoAcessoEm: agora() });
  await db.users_removerCampos(env, user._id, ['loginFalhas', 'bloqueadoAte']);

  return db.users_porId(env, user._id);
}

async function trocarSenha(env, user, senhaAtual, novaSenha) {
  const cfg = configMod.config(env);

  const confere = await crypto.confereSenha(String(senhaAtual || ''), user.senhaHash);
  if (!confere) {
    throw Object.assign(new Error('Senha atual incorreta.'), { status: 400 });
  }

  if (!forcaSenha(novaSenha)) {
    throw Object.assign(new Error('A nova senha precisa ter pelo menos 8 caracteres.'), { status: 400 });
  }

  await db.users_atualizar(env, user._id, {
    senhaHash: await crypto.hasharSenha(String(novaSenha), cfg.PBKDF2_ITERACOES),
    senhaAlteradaEm: agora()
  });

  // Senha troca derruba todas as sessões, inclusive as da extensão: quem tinha o
  // token de quem saiu estava com a senha antiga.
  await db.sessions_removerPorUsuario(env, user._id);
  log.info('senha_trocada', { userId: user._id });
}

module.exports = {
  agora,
  addDays,
  addMinutos,
  normalizarEmail,
  emailValido,
  forcaSenha,
  eAdmin,
  criarSessao,
  criarTokenExtensao,
  tokenDeExtensaoExpiracao,
  sessaoPorToken,
  usuarioPorToken,
  encerrarToken,
  aplicarSessao,
  encerrarSessao,
  usuarioAtual,
  estadoDeAcesso,
  limitesDoPlano,
  exigirToken,
  exigirTokenComAcesso,
  exigirLogin,
  exigirAcesso,
  exigirAdmin,
  registrar,
  autenticar,
  trocarSenha
};
