'use strict';

const path = require('path');
const fs = require('fs');

const ROOT_DIR = path.resolve(__dirname, '..');
const IS_PROD = process.env.NODE_ENV === 'production';

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(value).trim().toLowerCase());
}

function list(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

const TRIAL_DAYS = num(process.env.TRIAL_DAYS, 7);
const SESSION_DAYS = num(process.env.SESSION_DAYS, 30);

const PLANS = {
  monthly: { id: 'monthly', name: 'Postador Pro Mensal', price: num(process.env.PLAN_MONTHLY_PRICE, 2500), days: 30 },
  annual: { id: 'annual', name: 'Postador Pro Anual', price: num(process.env.PLAN_ANNUAL_PRICE, 24900), days: 365 }
};

// Limites que a extensão respeita. O servidor não guarda campanha nem
// publicação: ele devolve os números do plano e a extensão faz a autolimitação.
const PLAN_LIMITS = {
  trial: {
    gruposPorDia: num(process.env.LIMIT_TRIAL_GRUPOS_DIA, 10),
    campanhasAtivas: num(process.env.LIMIT_TRIAL_CAMPANHAS, 3),
    destinosPorCampanha: num(process.env.LIMIT_TRIAL_DESTINOS, 5)
  },
  pro: {
    gruposPorDia: num(process.env.LIMIT_PRO_GRUPOS_DIA, 300),
    campanhasAtivas: num(process.env.LIMIT_PRO_CAMPANHAS, 50),
    destinosPorCampanha: num(process.env.LIMIT_PRO_DESTINOS, 100)
  }
};

const PORT = num(process.env.PORT, 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const INFINITEPAY_HANDLE = String(process.env.INFINITEPAY_HANDLE || '').trim();
const INFINITEPAY_API = process.env.INFINITEPAY_API || 'https://api.checkout.infinitepay.io';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const TRUST_PROXY = process.env.TRUST_PROXY || '';
const COOKIE_SECURE = PUBLIC_BASE_URL.startsWith('https://');
const SESSION_COOKIE = 'postador_session';
const CSRF_COOKIE = 'postador_csrf';
const CSRF_HEADER = 'x-csrf-token';

// Origens da extensão autorizada a chamar a API. Cada item é o ID da extensão
// sem o prefixo: em `chrome://extensions` aparece como `ID` e a extensão
// manda `chrome-extension://<ID>` como origem. Vazio = nenhuma extensão pode
// chamar a API, e nenhuma requisição de origem desconhecida passa.
const EXTENSAO_IDS = list(process.env.EXTENSAO_IDS);
const TOKEN_EXTENSAO_DIAS = num(process.env.TOKEN_EXTENSAO_DIAS, 30);

// Bloqueio por tentativas erradas de login. O rate limit por IP segura uma
// origem; isto segura uma conta que sofre tentativa de muitos IPs diferentes.
const LOGIN_FALHAS_MAX = num(process.env.LOGIN_FALHAS_MAX, 8);
const LOGIN_BLOQUEIO_MINUTOS = num(process.env.LOGIN_BLOQUEIO_MINUTOS, 15);

const MAX_IMAGE_BYTES = num(process.env.MAX_IMAGE_BYTES, 8 * 1024 * 1024);
const MAX_TEXTOS = num(process.env.MAX_TEXTOS, 20);
const MAX_TEXT_LENGTH = num(process.env.MAX_TEXT_LENGTH, 5000);
const MAX_CAMPANHA_NOME = num(process.env.MAX_CAMPANHA_NOME, 100);
const MIN_LEAD_MINUTES = num(process.env.MIN_LEAD_MINUTES, 2);
const MAX_DIAS_AGENDAMENTO = num(process.env.MAX_DIAS_AGENDAMENTO, 90);

// Ritmo de publicação. É o que evita bloqueio de conta: nunca publique em
// rajada. Os mesmos números são levados para a extensão.
const DELAY_ENTRE_POSTS_MIN = num(process.env.DELAY_ENTRE_POSTS_MIN, 25);
const DELAY_ENTRE_POSTS_MAX = num(process.env.DELAY_ENTRE_POSTS_MAX, 60);
const CADENCIA_MIN_MS = num(process.env.CADENCIA_MIN_MS, 35);
const CADENCIA_MAX_MS = num(process.env.CADENCIA_MAX_MS, 95);

const ADMIN_EMAILS = list(process.env.ADMIN_EMAILS);
const SMTP = {
  host: process.env.SMTP_HOST || '',
  port: num(process.env.SMTP_PORT, 587),
  secure: bool(process.env.SMTP_SECURE, false),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || 'Postador Pro <nao-responda@localhost>'
};
const SMTP_ENABLED = Boolean(SMTP.host && SMTP.user && SMTP.pass);
const RESET_TOKEN_MINUTES = num(process.env.RESET_TOKEN_MINUTES, 60);
const LOGIN_MINUTOS = num(process.env.LOGIN_MINUTOS, 5);

// Expor o link de redefinição na resposta da API permite que qualquer pessoa
// assuma a conta de quem tem o e-mail cadastrado. Só faz sentido para
// desenvolvimento, e mesmo assim precisa ser ligado à mão. Em produção a
// opção é ignorada por segurança.
const EXPOSIR_LINK_REDEFINICAO =
  !IS_PROD && ['1', 'true', 'sim', 'yes'].includes(String(process.env.EXPOSIR_LINK_REDEFINICAO || '').trim().toLowerCase());

const COMPACTACAO_MINUTOS = num(process.env.COMPACTACAO_MINUTOS, 30);
const BACKUP_MINUTOS = num(process.env.BACKUP_MINUTOS, 360);
// Com backup a cada 6 horas, 30 cópias dão pouco mais de 7 dias de histórico.
const BACKUPS_MAXIMOS = Math.max(1, num(process.env.BACKUPS_MAXIMOS, 30));

// Limites por IP das rotas sensíveis. Ajustáveis para instalações com proxy
// compartilhado ou para a suíte de testes.
const RATE_LIMITS = {
  registro: num(process.env.RATE_LIMIT_REGISTRO, 5),
  login: num(process.env.RATE_LIMIT_LOGIN, 10),
  trocaSenha: num(process.env.RATE_LIMIT_TROCA_SENHA, 10),
  recuperar: num(process.env.RATE_LIMIT_RECUPERAR, 5),
  redefinir: num(process.env.RATE_LIMIT_REDEFINIR, 10),
  excluirConta: num(process.env.RATE_LIMIT_EXCLUIR_CONTA, 5)
};

for (const dir of [DATA_DIR, BACKUP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const config = {
  ROOT_DIR,
  IS_PROD,
  PORT,
  HOST,
  TRIAL_DAYS,
  SESSION_DAYS,
  PLANS,
  PLAN_LIMITS,
  PUBLIC_BASE_URL,
  COOKIE_SECURE,
  SESSION_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  EXTENSAO_IDS,
  TOKEN_EXTENSAO_DIAS,
  LOGIN_FALHAS_MAX,
  LOGIN_BLOQUEIO_MINUTOS,
  INFINITEPAY_HANDLE,
  INFINITEPAY_API,
  TRUST_PROXY,
  DATA_DIR,
  BACKUP_DIR,
  MAX_IMAGE_BYTES,
  MAX_TEXTOS,
  MAX_TEXT_LENGTH,
  MAX_CAMPANHA_NOME,
  MIN_LEAD_MINUTES,
  MAX_DIAS_AGENDAMENTO,
  DELAY_ENTRE_POSTS_MIN,
  DELAY_ENTRE_POSTS_MAX,
  ADMIN_EMAILS,
  SMTP,
  SMTP_ENABLED,
  EXPOSIR_LINK_REDEFINICAO,
  RATE_LIMITS,
  RESET_TOKEN_MINUTES,
  LOGIN_MINUTOS,
  COMPACTACAO_MINUTOS,
  BACKUP_MINUTOS,
  BACKUPS_MAXIMOS
};

function validarConfig() {
  const problemas = [];
  const avisos = [];

  if (!INFINITEPAY_HANDLE) {
    avisos.push('INFINITEPAY_HANDLE vazio: o checkout da InfinitePay ficará indisponível.');
  }

  if (IS_PROD && !PUBLIC_BASE_URL.startsWith('https://')) {
    problemas.push('PUBLIC_BASE_URL deve usar HTTPS em produção (o cookie de sessão depende disso).');
  }

  if (IS_PROD && !TRUST_PROXY) {
    avisos.push('TRUST_PROXY vazio em produção: se houver proxy reverso, o IP real e o cookie Secure podem ficar errados.');
  }

  if (!ADMIN_EMAILS.length) {
    avisos.push('ADMIN_EMAILS vazio: nenhum usuário terá acesso ao painel administrativo.');
  }

  if (!EXTENSAO_IDS.length) {
    avisos.push('EXTENSAO_IDS vazio: nenhuma extensão está autorizada a chamar a API. A extensão não vai funcionar até você colocar o ID dela aqui.');
  }

  if (TOKEN_EXTENSAO_DIAS < 1 || TOKEN_EXTENSAO_DIAS > 365) {
    problemas.push('TOKEN_EXTENSAO_DIAS precisa estar entre 1 e 365 dias.');
  }

  if (!SMTP_ENABLED) {
    if (IS_PROD) {
      problemas.push('SMTP é obrigatório em produção: sem ele o cliente não consegue recuperar a senha.');
    } else {
      avisos.push('SMTP não configurado: o link de recuperação de senha será registrado no log do servidor.');
    }
  }

  if (EXPOSIR_LINK_REDEFINICAO) {
    avisos.push('EXPOSIR_LINK_REDEFINICAO ligado: a API devolve o link de redefinição de senha. Nunca use fora de desenvolvimento.');
  }

  if (DELAY_ENTRE_POSTS_MAX < DELAY_ENTRE_POSTS_MIN) {
    problemas.push('DELAY_ENTRE_POSTS_MAX precisa ser maior ou igual a DELAY_ENTRE_POSTS_MIN.');
  }

  if (CADENCIA_MAX_MS < CADENCIA_MIN_MS) {
    problemas.push('CADENCIA_MAX_MS precisa ser maior ou igual a CADENCIA_MIN_MS.');
  }

  // O intervalo vira uma expressão cron, que não aceita `*/360`: um valor
  // inválido aqui significaria compactação e backup nunca executando.
  for (const [nome, valor] of [
    ['BACKUP_MINUTOS', BACKUP_MINUTOS],
    ['COMPACTACAO_MINUTOS', COMPACTACAO_MINUTOS]
  ]) {
    if (valor < 1 || valor > 1440) {
      problemas.push(`${nome} precisa estar entre 1 e 1440 minutos (recebido: ${valor}).`);
    }
  }

  return { problemas, avisos };
}

module.exports = config;
module.exports.validarConfig = validarConfig;
