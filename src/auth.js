'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { db } = require('./db');
const security = require('./security');
const log = require('./log');

const BCRYPT_ROUNDS = 12;
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

function eAdmin(user) {
  if (!user) return false;
  if (user.admin === true) return true;
  return config.ADMIN_EMAILS.includes(String(user.email || '').toLowerCase());
}

async function criarSessao(userId) {
  const token = security.novoToken(32);
  const tokenHash = security.hashToken(token);

  await db.sessions.insert({
    _id: crypto.randomUUID(),
    tokenHash,
    userId,
    criadoEm: agora(),
    expiresAt: addDays(agora(), config.SESSION_DAYS)
  });

  const existentes = await db.sessions
    .find({ userId })
    .sort({ criadoEm: 1 });

  const antigas = existentes.filter(s => s.tokenHash !== tokenHash).slice(0, Math.max(0, existentes.length - MAX_SESSOES_POR_CONTA));
  for (const sessao of antigas) {
    await db.sessions.remove({ _id: sessao._id }, {});
  }

  return token;
}

function extrairBearer(req) {
  const bruto = String(req.get('authorization') || '');
  const achado = /^Bearer\s+(\S+)$/i.exec(bruto);
  return achado ? achado[1] : null;
}

async function sessaoPorToken(token) {
  if (!token) return null;

  const sessao = await db.sessions.findOne({ tokenHash: security.hashToken(token) });
  if (!sessao) return null;

  if (new Date(sessao.expiresAt) <= agora()) {
    await db.sessions.remove({ _id: sessao._id }, {});
    return null;
  }

  return sessao;
}

// O token da extensão é o mesmo formato da sessão web, guardado na mesma
// coleção e com o mesmo hash SHA-256. A diferença é a origem: a extensão não
// tem cookie, então manda `Authorization: Bearer` e o navegador nunca anexa
// esse cabeçalho sozinho num ataque cross-site.
async function criarTokenExtensao(userId) {
  const token = security.novoToken(32);
  const tokenHash = security.hashToken(token);

  await db.sessions.insert({
    _id: crypto.randomUUID(),
    tokenHash,
    userId,
    escopo: 'extensao',
    criadoEm: agora(),
    expiresAt: addDays(agora(), config.TOKEN_EXTENSAO_DIAS)
  });

  await db.sessions.remove({ userId, escopo: 'extensao', tokenHash: { $ne: tokenHash } }, { multi: true });

  return token;
}

async function usuarioPorToken(token) {
  const sessao = await sessaoPorToken(token);
  if (!sessao) return null;

  const user = await db.users.findOne({ _id: sessao.userId });
  if (!user || user.bloqueado) return null;

  return user;
}

async function exigirToken(req, res, next) {
  try {
    const user = await usuarioPorToken(extrairBearer(req));
    if (!user) {
      return res.status(401).json({
        erro: 'Faça login na extensão para continuar.',
        codigo: 'nao_autenticado'
      });
    }
    req.user = user;
    req.acesso = await estadoDeAcesso(user);
    next();
  } catch (erro) {
    next(erro);
  }
}

async function exigirTokenComAcesso(req, res, next) {
  try {
    const user = await usuarioPorToken(extrairBearer(req));
    const estado = await estadoDeAcesso(user);

    if (!estado.permitido) {
      return res.status(401).json({
        erro: 'Faça login na extensão para continuar.',
        codigo: 'nao_autenticado'
      });
    }

    req.user = user;
    req.acesso = estado;
    next();
  } catch (erro) {
    next(erro);
  }
}

async function encerrarToken(req) {
  const token = extrairBearer(req);
  if (!token) return;
  await db.sessions.remove({ tokenHash: security.hashToken(token) }, {});
}

function aplicarSessao(res, token) {
  security.definirCookie(res, config.SESSION_COOKIE, token, config.SESSION_DAYS * 86400);
  security.rotacionarCsrf(res);
}

function encerrarSessao(res) {
  security.definirCookie(res, config.SESSION_COOKIE, '', 0);
}

async function usuarioAtual(req) {
  const token = req.cookies?.[config.SESSION_COOKIE];
  if (!token) return null;

  const sessao = await db.sessions.findOne({ tokenHash: security.hashToken(token) });
  if (!sessao) return null;

  if (new Date(sessao.expiresAt) <= agora()) {
    await db.sessions.remove({ _id: sessao._id }, {});
    return null;
  }

  const user = await db.users.findOne({ _id: sessao.userId });
  if (!user || user.bloqueado) return null;

  return user;
}

async function estadoDeAcesso(user) {
  if (!user) return { permitido: false, status: 'nao_autenticado' };

  if (user.plano === 'pro' && user.dataExpiracao && new Date(user.dataExpiracao) > agora()) {
    return { permitido: true, status: 'pro' };
  }

  if (user.trialFim && new Date(user.trialFim) > agora()) {
    return { permitido: true, status: 'trial' };
  }

  return { permitido: false, status: 'expirado' };
}

function limitesDoPlano(user) {
  return user && user.plano === 'pro' ? config.PLAN_LIMITS.pro : config.PLAN_LIMITS.trial;
}

async function exigirLogin(req, res, next) {
  try {
    const user = await usuarioAtual(req);
    if (!user) {
      return res.status(401).json({ erro: 'Faça login para continuar.', codigo: 'nao_autenticado' });
    }
    req.user = user;
    next();
  } catch (erro) {
    next(erro);
  }
}

async function exigirAcesso(req, res, next) {
  try {
    const user = await usuarioAtual(req);
    const estado = await estadoDeAcesso(user);

    if (!estado.permitido) {
      return res.status(402).json({
        erro: 'Seu acesso expirou. Escolha um plano para continuar.',
        codigo: 'acesso_expirado'
      });
    }

    req.user = user;
    req.acesso = estado;
    next();
  } catch (erro) {
    next(erro);
  }
}

async function exigirAdmin(req, res, next) {
  if (!eAdmin(req.user)) {
    return res.status(403).json({ erro: 'Acesso restrito ao administrador.', codigo: 'sem_permissao' });
  }
  next();
}

async function registrar({ nome, email, senha }) {
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

  const existente = await db.users.findOne({ email: emailLimpo });
  if (existente) {
    throw Object.assign(new Error('Este e-mail já está cadastrado.'), { status: 409 });
  }

  const criadoEm = agora();
  const admin = config.ADMIN_EMAILS.includes(emailLimpo);

  const user = await db.users.insert({
    _id: crypto.randomUUID(),
    nome: nomeLimpo,
    email: emailLimpo,
    senhaHash: await bcrypt.hash(senhaTexto, BCRYPT_ROUNDS),
    criadoEm,
    trialInicio: criadoEm,
    trialFim: addDays(criadoEm, config.TRIAL_DAYS),
    plano: 'trial',
    statusPagamento: 'trial'
  });

  if (admin) {
    await db.users.update({ _id: user._id }, { $set: { admin: true } });
    user.admin = true;
  }

  log.info('conta_criada', { userId: user._id, email: emailLimpo, admin });
  return user;
}

async function autenticar({ email, senha }) {
  const emailLimpo = normalizarEmail(email);
  const senhaTexto = String(senha || '');

  const user = await db.users.findOne({ email: emailLimpo });

  if (!user) {
    await bcrypt.compare(senhaTexto, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
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

  const confere = await bcrypt.compare(senhaTexto, user.senhaHash);
  if (!confere) {
    const falhas = (user.loginFalhas || 0) + 1;
    const update =
      falhas >= config.LOGIN_FALHAS_MAX
        ? {
            loginFalhas: 0,
            bloqueadoAte: addMinutos(agora(), config.LOGIN_BLOQUEIO_MINUTOS)
          }
        : { loginFalhas: falhas };

    await db.users.update({ _id: user._id }, { $set: update });

    if (falhas >= config.LOGIN_FALHAS_MAX) {
      log.warn('conta_bloqueada_por_falhas', {
        userId: user._id,
        falhas,
        minutos: config.LOGIN_BLOQUEIO_MINUTOS
      });
    }

    throw Object.assign(new Error('E-mail ou senha incorretos.'), { status: 401 });
  }

  await db.users.update(
    { _id: user._id },
    { $set: { ultimoAcessoEm: agora() }, $unset: { loginFalhas: '', bloqueadoAte: '' } }
  );
  return user;
}

async function trocarSenha(user, senhaAtual, novaSenha) {
  const confere = await bcrypt.compare(String(senhaAtual || ''), user.senhaHash);
  if (!confere) {
    throw Object.assign(new Error('Senha atual incorreta.'), { status: 400 });
  }

  if (!forcaSenha(novaSenha)) {
    throw Object.assign(new Error('A nova senha precisa ter pelo menos 8 caracteres.'), { status: 400 });
  }

  await db.users.update(
    { _id: user._id },
    { $set: { senhaHash: await bcrypt.hash(String(novaSenha), BCRYPT_ROUNDS), senhaAlteradaEm: agora() } }
  );

  await db.sessions.remove({ userId: user._id }, {});
  log.info('senha_trocada', { userId: user._id });
}

async function limparExpiradas() {
  const sessoes = await db.sessions.remove({ expiresAt: { $lte: agora() } }, { multi: true });
  const resets = await db.resets.remove({ expiraEm: { $lte: agora() } }, { multi: true });
  if (sessoes || resets) {
    log.info('expirados_removidos', { sessoes, resets });
  }
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
  usuarioPorToken,
  exigirToken,
  exigirTokenComAcesso,
  encerrarToken,
  aplicarSessao,
  encerrarSessao,
  usuarioAtual,
  estadoDeAcesso,
  limitesDoPlano,
  exigirLogin,
  exigirAcesso,
  exigirAdmin,
  registrar,
  autenticar,
  trocarSenha,
  limparExpiradas
};
