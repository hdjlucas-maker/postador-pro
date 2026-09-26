'use strict';

// Ponto de entrada do Worker.
//
// ## Por que o app é montado uma vez
//
// A primeira versão fazia `criarApp(env)` no topo do módulo, e isso quebrava: o
// `env` só existe durante uma requisição, então ler `config(env)` ali dava
// `TypeError` ao carregar o módulo. A saída certa não é remontar o roteador a
// cada requisição (caro), e sim montar uma vez e ler o ambiente de `c.env`, que
// é exatamente o que o Hono prepara por requisição. Os middlewares de
// `auth.js` e `security.js` seguem a mesma regra.
//
// ## Ordem dos middlewares
//
// 1. `cabecalhosSeguranca` — vale para toda resposta da API.
// 2. `corsExtensao` — precisa vir antes de qualquer outra coisa que possa
//    responder, para o preflight OPTIONS sair com o `Access-Control-Allow-Origin`.
// 3. Teto geral pelo binding nativo do edge, e teto próprio do webhook.
// 4. `aplicarOrigem` e `aplicarCsrf` nas rotas de `/api`.
//
// ## Estáticos
//
// Os arquivos de `public/` são servidos pelo binding de assets antes de o Worker
// ser chamado, com os cabeçalhos de segurança vindos de `public/_headers`. As
// rotas de página (`/`, `/redefinir`, `/admin`) não passam por aqui — são
// arquivos. Só `/api/*` e o webhook chegam neste módulo.

const { Hono } = require('hono');
const configMod = require('./config');
const security = require('./security');
const auth = require('./auth');
const db = require('./db');
const log = require('./log');

const VERSAO = '1.0.0';

const rotas = {
  auth: require('./routes/auth'),
  billing: require('./routes/billing'),
  extensao: require('./routes/extensao'),
  admin: require('./routes/admin')
};

function cabecalhosSeguranca() {
  return async function headers(c, next) {
    const path = new URL(c.req.url).pathname;
    const ehApi = path === '/api' || path.startsWith('/api/');

    c.res.headers.set('Content-Security-Policy', security.CSP);
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.res.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
    c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    // A extensão lê a API de outra origem. Com `same-origin` o navegador
    // descarta a resposta antes de a extensão ver o conteúdo.
    c.res.headers.set('Cross-Origin-Resource-Policy', ehApi ? 'cross-origin' : 'same-origin');
    c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    if (ehApi) c.res.headers.set('Cache-Control', 'no-store');

    return next();
  };
}

function logHttp() {
  return async function logRequisicao(c, next) {
    const inicio = Date.now();
    await next();
    const path = new URL(c.req.url).pathname;
    if (!path.startsWith('/api/')) return;
    log.info('http', {
      metodo: c.req.method,
      rota: path,
      status: c.res.status,
      ms: Date.now() - inicio,
      ip: security.clientIp(c),
      userId: c.get('user')?._id
    });
  };
}

function normalizarErro(erro) {
  if (erro && typeof erro.getResponse === 'function') {
    // HTTPException do Hono.
    return { status: erro.getResponse().status, mensagem: 'Requisição inválida.' };
  }
  return {
    status: erro?.status || erro?.statusCode || 500,
    mensagem: erro?.message || 'Erro interno do servidor.'
  };
}

const app = new Hono();

app.use('*', cabecalhosSeguranca());
app.use('/api/*', security.corsExtensao());
app.use('/api/*', logHttp());

// Público: só diz que o serviço está no ar. A extensão usa isto para não tentar
// falar com a API antes de ela estar disponível.
app.get('/api/health', async c => {
  const sistema = await db.sistema_info(c.env).catch(() => null);
  const instaladoEm = sistema?.instalado_em ? new Date(sistema.instalado_em).getTime() : null;

  return c.json({
    ok: true,
    versao: VERSAO,
    // Não existe processo de longa duração no Worker, então isto mede desde a
    // instalação da base, não desde o boot.
    uptime: instaladoEm ? Math.max(0, Math.round((Date.now() - instaladoEm) / 1000)) : 0,
    instaladoEm: sistema?.instalado_em || null
  });
});

// Teto específico do webhook, separado do `RL_GERAL` das rotas normais. Sem isto,
// quem inundar o `/api/subscription` esgotaria o orçamento do IP inteiro e
// derrubaria de quebra a entrega de pagamento de todo mundo.
app.use('/api/webhooks/*', async (c, next) => {
  const binding = c.env.RL_WEBHOOK;
  if (!binding) return next();

  const { success } = await binding.limit({ key: security.clientIp(c) });
  if (success) return next();

  c.header('Retry-After', '60');
  return c.json({ success: false, message: 'Muitas requisições. Tente novamente.' }, 429);
});

// Fica antes do rate limit geral e responde sem revelar nada a quem não é
// administrador: o middleware de admin devolve 401 ou 403 sem detailing.
app.get('/api/estado', auth.exigirLogin(), auth.exigirAdmin(), c => {
  const { problemas, avisos } = configMod.validarConfig(c.env);
  return c.json({ problemas, avisos, pago: Boolean(configMod.config(c.env).INFINITEPAY_HANDLE) });
});

const api = new Hono();

api.use('*', async (c, next) => {
  await security.limiteGeral(c);
  return security.aplicarOrigem()(c, next);
});
api.use('*', security.aplicarCsrf());

api.route('/', rotas.auth.criar());
api.route('/', rotas.billing.criar());
api.route('/extensao', rotas.extensao.criar());
api.route('/', rotas.admin.criar());

app.route('/api', api);

// `/`, `/redefinir` e `/admin` são arquivos estáticos e já foram atendidos pelo
// binding de assets. Este bloco cobre o resto: dentro de `/api` a resposta é
// JSON, fora dela o Worker repassa para os assets.
app.all('/api/*', c => c.json({ erro: 'Recurso não encontrado.' }, 404));

app.all('*', async c => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text('Não encontrado', 404);
});

app.onError((erro, c) => {
  const { status, mensagem } = normalizarErro(erro);

  if (status >= 500) {
    log.error('erro_interno', {
      rota: c.req.path,
      metodo: c.req.method,
      erro: String(erro.message || erro)
    });
  }

  return c.json(
    {
      erro: status >= 500 ? 'Erro interno do servidor. Tente novamente em instantes.' : mensagem,
      ...(erro?.codigo ? { codigo: erro.codigo } : {})
    },
    status
  );
});

// `sistema` guarda o instante de instalação, que é o que o `/api/health` mostra
// no lugar do "uptime" do processo. Criado em segundo plano no primeiro request
// de cada isolate: `INSERT OR IGNORE` não escreve nada quando a linha já existe,
// e o `waitUntil` faz a resposta não esperar por essa escrita.
async function fetchHandler(request, env, ctx) {
  const resposta = await app.fetch(request, env);
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(db.sistema_inicializar(env, VERSAO).catch(() => {}));
  }
  return resposta;
}

async function scheduledHandler(event, env, ctx) {
  ctx.waitUntil(
    db
      .sistema_inicializar(env, VERSAO)
      .then(() => db.manutencao(env, log))
      .catch(erro => log.error('manutencao_falhou', { erro: erro.message }))
  );
}

module.exports = {
  fetch: fetchHandler,
  scheduled: scheduledHandler,
  app,
  VERSAO
};
