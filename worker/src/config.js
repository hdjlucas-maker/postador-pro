'use strict';

// Configuração lida das bindings e dos `vars` do Worker.
//
// Não há `process.env` aqui: no Worker quem carrega o ambiente é o runtime, e o
// objeto `env` chega a cada requisição. Também não há `fs.mkdirSync` como no
// servidor: o D1 e o bucket de estáticos não têm diretório para criar.
//
// `PUBLIC_BASE_URL` é opcional de propósito. Sem ela, a base vem da própria
// requisição (`https://postador-pro-api.<sub>.workers.dev`), que é a URL pública
// real e não precisa ser repetida em dois lugares até divergir. Defina
// explicitamente só quando quiser fixar um host — por exemplo ao colocar um
// domínio próprio na frente.

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

// Sem cache de propósito. A primeira versão guardava a config num `Map`
// indexado pelo objeto `env`, mas no Worker o `env` é um objeto novo a cada
// requisição: a chave nunca se repetia, o `Map` só crescia e nenhuma leitura
// acertava. `carregarConfig` é aritmética e `String` sobre campos já em
// memória, sem I/O, e custa menos que o vazamento que o cache evitava.
function carregarConfig(env) {
  const isProd = env.IS_PROD === '1' || env.IS_PROD === 'true';

  const trialDays = num(env.TRIAL_DAYS, 7);
  const sessionDays = num(env.SESSION_DAYS, 30);

  const config = {
    IS_PROD: isProd,

    TRIAL_DAYS: trialDays,
    SESSION_DAYS: sessionDays,

    PLANS: {
      monthly: { id: 'monthly', name: 'Postador Pro Mensal', price: num(env.PLAN_MONTHLY_PRICE, 2500), days: 30 },
      annual: { id: 'annual', name: 'Postador Pro Anual', price: num(env.PLAN_ANNUAL_PRICE, 24900), days: 365 }
    },

    // O servidor devolve os números e a extensão se autolimita. Nenhum dado de
    // campanha é gravado aqui.
    PLAN_LIMITS: {
      trial: {
        gruposPorDia: num(env.LIMIT_TRIAL_GRUPOS_DIA, 10),
        campanhasAtivas: num(env.LIMIT_TRIAL_CAMPANHAS, 3),
        destinosPorCampanha: num(env.LIMIT_TRIAL_DESTINOS, 5)
      },
      pro: {
        gruposPorDia: num(env.LIMIT_PRO_GRUPOS_DIA, 300),
        campanhasAtivas: num(env.LIMIT_PRO_CAMPANHAS, 50),
        destinosPorCampanha: num(env.LIMIT_PRO_DESTINOS, 100)
      }
    },

    PUBLIC_BASE_URL: String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    INFINITEPAY_HANDLE: String(env.INFINITEPAY_HANDLE || '').trim(),
    INFINITEPAY_API: env.INFINITEPAY_API || 'https://api.checkout.infinitepay.io',

    SESSION_COOKIE: 'postador_session',
    CSRF_COOKIE: 'postador_csrf',
    CSRF_HEADER: 'x-csrf-token',

    EXTENSAO_IDS: list(env.EXTENSAO_IDS),
    TOKEN_EXTENSAO_DIAS: num(env.TOKEN_EXTENSAO_DIAS, 30),

    LOGIN_FALHAS_MAX: num(env.LOGIN_FALHAS_MAX, 8),
    LOGIN_BLOQUEIO_MINUTOS: num(env.LOGIN_BLOQUEIO_MINUTOS, 15),

    ADMIN_EMAILS: list(env.ADMIN_EMAILS),

    RESET_TOKEN_MINUTES: num(env.RESET_TOKEN_MINUTES, 60),
    PBKDF2_ITERACOES: num(env.PBKDF2_ITERACOES, 100000),

    // O envio depende da binding `EMAIL`, que só existe depois que um domínio é
    // habilitado em Email Sending. Sem ela o link de recuperação vai para o
    // log, que serve em desenvolvimento e não serve em produção.
    EMAIL_FROM: String(env.EMAIL_FROM || '').trim(),
    EMAIL_ENABLED: Boolean(env.EMAIL) && Boolean(env.EMAIL_FROM),

    RATE_LIMITS: {
      registro: num(env.RATE_LIMIT_REGISTRO, 5),
      login: num(env.RATE_LIMIT_LOGIN, 10),
      trocaSenha: num(env.RATE_LIMIT_TROCA_SENHA, 10),
      recuperar: num(env.RATE_LIMIT_RECUPERAR, 5),
      redefinir: num(env.RATE_LIMIT_REDEFINIR, 10),
      excluirConta: num(env.RATE_LIMIT_EXCLUIR_CONTA, 5)
    },

    JANELAS_RATE_LIMIT: {
      registro: 60 * 60 * 1000,
      login: 15 * 60 * 1000,
      trocaSenha: 60 * 60 * 1000,
      recuperar: 60 * 60 * 1000,
      redefinir: 60 * 60 * 1000,
      excluirConta: 60 * 60 * 1000,
      extensaoLogin: 15 * 60 * 1000,
      extensaoCadastro: 60 * 60 * 1000,
      checkout: 60 * 60 * 1000,
      reconciliar: 60 * 60 * 1000
    }
  };

  return config;
}

function config(env) {
  return carregarConfig(env);
}

/**
 * Base pública das URLs que a API monta: redirecionamento de checkout e link
 * de recuperação. Usa `PUBLIC_BASE_URL` quando definido e cai para a origem da
 * própria requisição, que no plano gratuito é o `workers.dev`.
 */
function baseUrl(env, request) {
  if (config(env).PUBLIC_BASE_URL) return config(env).PUBLIC_BASE_URL;
  return new URL(request.url).origin;
}

function validarConfig(env) {
  const cfg = config(env);
  const problemas = [];
  const avisos = [];

  if (!cfg.INFINITEPAY_HANDLE) {
    avisos.push('INFINITEPAY_HANDLE vazio: o checkout da InfinitePay ficará indisponível.');
  }

  if (!cfg.ADMIN_EMAILS.length) {
    avisos.push('ADMIN_EMAILS vazio: nenhum usuário terá acesso ao painel administrativo.');
  }

  if (!cfg.EXTENSAO_IDS.length) {
    avisos.push('EXTENSAO_IDS vazio: nenhuma extensão está autorizada a chamar a API. Preencha com o ID do manifest.');
  }

  if (cfg.TOKEN_EXTENSAO_DIAS < 1 || cfg.TOKEN_EXTENSAO_DIAS > 365) {
    problemas.push('TOKEN_EXTENSAO_DIAS precisa estar entre 1 e 365 dias.');
  }

  if (cfg.LOGIN_FALHAS_MAX < 1) {
    problemas.push('LOGIN_FALHAS_MAX precisa ser pelo menos 1.');
  }

  if (!cfg.EMAIL_ENABLED) {
    if (cfg.IS_PROD) {
      problemas.push(
        'E-mail obrigatório em produção: habilite um domínio (`npx wrangler email sending enable SEUDOMINIO`), ' +
          'adicione a binding EMAIL no wrangler.jsonc e defina EMAIL_FROM.'
      );
    } else {
      avisos.push('E-mail não configurado: o link de recuperação de senha será registrado no log.');
    }
  }

  // Um custo baixo de PBKDF2 é aceitável no plano gratuito porque a trava de
  // conta segura o número de tentativas, mas precisa estar registrado.
  if (cfg.PBKDF2_ITERACOES < 10000) {
    avisos.push(
      `PBKDF2_ITERACOES em ${cfg.PBKDF2_ITERACOES} está abaixo do aceitável. ` +
        'Use 10000 no plano gratuito e 100000 no Workers Pago.'
    );
  }

  return { problemas, avisos };
}

module.exports = { carregarConfig, config, baseUrl, validarConfig, num, bool, list };
