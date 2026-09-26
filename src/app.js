'use strict';

const path = require('path');
const express = require('express');

const config = require('./config');
const security = require('./security');
const http = require('./http');
const auth = require('./auth');
const log = require('./log');

const rotas = {
  auth: require('./routes/auth'),
  billing: require('./routes/billing'),
  extensao: require('./routes/extensao'),
  admin: require('./routes/admin')
};

function criarApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('etag', 'strong');

  if (config.TRUST_PROXY) {
    const saltos = Number(config.TRUST_PROXY);
    app.set('trust proxy', Number.isInteger(saltos) && saltos > 0 ? saltos : config.TRUST_PROXY);
  }

  app.use(http.cabecalhosSeguranca);
  app.use(http.corsExtensao);
  app.use(http.parseCookies);
  app.use(express.json({ limit: '1mb' }));
  app.use(http.naoCacheApi);
  app.use(http.loggerHttp);

  // Público: só diz que o serviço está no ar. A extensão usa isto para não
  // tentar falar com a API antes de ela estar disponível.
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      versao: require('../package.json').version,
      uptime: Math.round(process.uptime()),
      memoriaMB: Math.round(process.memoryUsage().rss / 1048576)
    });
  });

  // Já exigia `exigirLogin` + `exigirAdmin` abaixo; fica aqui para responder
  // antes do rate limit geral, sem revelar nada a quem não é administrador.
  app.get('/api/estado', auth.exigirLogin, auth.exigirAdmin, (req, res) => {
    const { problemas, avisos } = config.validarConfig();
    res.json({ problemas, avisos, pago: Boolean(config.INFINITEPAY_HANDLE) });
  });

  const limiteGeral = security.criarRateLimit({ nome: 'api', max: 600, janelaMs: 60 * 1000 });
  const api = express.Router();

  api.use(segurancaDeOrigem);
  api.use(limiteGeral);
  api.use(segurancaDeCsrf);

  for (const modulo of Object.values(rotas)) {
    modulo.registrar(api);
  }

  app.use('/api', api);

  //-interface
  // Três telas, e só três. A extensão é o produto; aqui fica o que o cliente
  // precisa sem a extensão: saber o que é, pagar, recuperar a senha e o
  // painel do administrador. Nada de menu de campanha que não existe mais.
  const paginas = express.Router();
  paginas.get('/', (req, res) => {
    security.assegurarCsrf(req, res);
    res.sendFile(path.join(config.ROOT_DIR, 'public', 'index.html'));
  });
  paginas.get(['/redefinir', '/redefinir-senha'], (req, res) => {
    security.assegurarCsrf(req, res);
    res.sendFile(path.join(config.ROOT_DIR, 'public', 'redefinir.html'));
  });
  paginas.get('/admin', (req, res) => {
    security.assegurarCsrf(req, res);
    res.sendFile(path.join(config.ROOT_DIR, 'public', 'admin.html'));
  });
  paginas.get('/termos', (req, res) => res.sendFile(path.join(config.ROOT_DIR, 'public', 'termos.html')));
  paginas.get('/privacidade', (req, res) => res.sendFile(path.join(config.ROOT_DIR, 'public', 'privacidade.html')));
  paginas.use(http.estaticos());
  app.use(paginas);

  app.use(http.naoEncontrado);

  app.use((erro, req, res, next) => {
    if (res.headersSent) return next(erro);

    const status = erro.status || erro.statusCode || 500;
    const interno = status >= 500;

    if (interno) {
      log.error('erro_interno', {
        rota: req.originalUrl,
        metodo: req.method,
        erro: String(erro.message || erro),
        pilha: erro.stack
      });
    }

    if (erro.type === 'entity.too.large') {
      return res.status(413).json({ erro: 'Envio maior que o limite permitido.' });
    }

    if (erro.type === 'entity.parse.failed') {
      return res.status(400).json({ erro: 'Requisição malformada.' });
    }

    res.status(status).json({
      erro: interno ? 'Erro interno do servidor. Tente novamente em instantes.' : String(erro.message || 'Erro'),
      ...(erro.codigo ? { codigo: erro.codigo } : {})
    });
  });

  return app;
}

function segurancaDeOrigem(req, res, next) {
  if (req.path.startsWith('/webhooks/')) return next();
  security.aplicarOrigem(req, res, next);
}

// A extensão não tem cookie jar: ela não tem como ter o par cookie+header do
// CSRF, nem precisa dele. As rotas `/extensao/*` autenticam por
// `Authorization: Bearer`, que o navegador nunca anexa sozinho numa requisição
// cross-site. Onde o token falta, quem responde é `exigirToken` com 401, e não
// um 403 de CSRF que não ajuda ninguém a diagnosticar. Continua valendo a
// allowlist de `segurancaDeOrigem`, o rate limit e o travamento de conta.
function segurancaDeCsrf(req, res, next) {
  if (req.path.startsWith('/webhooks/')) return next();
  if (req.path === '/extensao' || req.path.startsWith('/extensao/')) return next();
  security.aplicarCsrf(req, res, next);
}

module.exports = { criarApp };
