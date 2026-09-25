require('dotenv').config();

const express = require('express');
const Datastore = require('nedb-promises');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { abrirNavegadorFacebook, statusFacebook, profileDir, fecharNavegadorFacebook } = require('./facebook');
const cron = require('node-cron');
const { dispararPostagem, dispararPostagens } = require('./postador');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TRIAL_DAYS = 7;
const SESSION_DAYS = 30;
const PLANS = {
  monthly: { name: 'Postador Pro Mensal', price: 2500, days: 30 },
  annual: { name: 'Postador Pro Anual', price: 24900, days: 365 }
};

const PLAN_LIMITS = {
  trial: { contas: 1, campanhasAtivas: 3, destinosPorCampanha: 20 },
  pro: { contas: 10, campanhasAtivas: 200, destinosPorCampanha: 100 }
};

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const INFINITEPAY_HANDLE = process.env.INFINITEPAY_HANDLE || '';
const COOKIE_SECURE = PUBLIC_BASE_URL.startsWith('https://');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const TRUST_PROXY = process.env.TRUST_PROXY || '';
if (TRUST_PROXY) {
  const hops = Number(TRUST_PROXY);
  app.set('trust proxy', Number.isInteger(hops) && hops > 0 ? hops : TRUST_PROXY);
}

function log(level, evento, extras) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    evento,
    ...(extras || {})
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else console.log(line);
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

app.use((req, res, next) => {
  if (!/^\/api\//.test(req.path)) return next();

  const inicio = Date.now();
  res.on('finish', () => {
    log('info', 'http', {
      metodo: req.method,
      rota: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - inicio,
      ip: req.ip || req.socket.remoteAddress
    });
  });
  next();
});

const users = Datastore.create({ filename: 'users.db', autoload: true });
const sessions = Datastore.create({ filename: 'sessions.db', autoload: true });
const accounts = Datastore.create({ filename: 'facebook-accounts.db', autoload: true });
const campaigns = Datastore.create({ filename: 'campaigns.db', autoload: true });
const posts = Datastore.create({ filename: 'posts.db', autoload: true });
const payments = Datastore.create({ filename: 'payments.db', autoload: true });

const makeId = () => crypto.randomUUID();
const now = () => new Date();

function addDays(date, days) {
  return new Date(new Date(date).getTime() + days * 86400000);
}

function criarRateLimit({ nome, max, janelaMs }) {
  const registros = new Map();

  return (req, res, next) => {
    const chave = `${nome}:${req.ip || '?'}`;
    const agora = Date.now();
    const lista = (registros.get(chave) || []).filter(ts => agora - ts < janelaMs);

    if (lista.length >= max) {
      return res.status(429).json({
        erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'
      });
    }

    lista.push(agora);
    registros.set(chave, lista);

    if (registros.size > 20000) {
      registros.clear();
    }

    next();
  };
}

const limiteLogin = criarRateLimit({ nome: 'login', max: 10, janelaMs: 15 * 60 * 1000 });
const limiteRegistro = criarRateLimit({ nome: 'registro', max: 5, janelaMs: 60 * 60 * 1000 });
const limiteWebhook = criarRateLimit({ nome: 'webhook', max: 60, janelaMs: 60 * 1000 });
const jsonUploads = express.json({ limit: '16mb' });

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

async function atualizarStatusCampanha(campanhaId) {
  const itens = await posts.find({ campanhaId });

  if (!itens.length) return;

  const total = itens.length;
  const concluidos = itens.filter(p => p.status === 'concluido').length;
  const falhas = itens.filter(p => p.status === 'falhou').length;
  const pendentes = itens.filter(p => p.status === 'pendente').length;

  let status = 'processando';

  if (concluidos === total) {
    status = 'concluido';
  } else if (falhas === total) {
    status = 'falhou';
  } else if (pendentes === total) {
    status = 'pendente';
  }

  await campaigns.update({ _id: campanhaId }, { $set: { status } });
}

let filaEmExecucao = false;

async function resetarProcessandoNoBoot() {
  const presos = await posts.update(
    { status: 'processando' },
    { $set: { status: 'pendente', motivo: null } },
    { multi: true }
  );

  if (presos) {
    log('info', 'fila_reinicio', {
      publicacoesOrfas: presos,
      mensagem: 'publicações órfãs voltaram para pendente'
    });
  }
}

async function processarFila() {
  if (filaEmExecucao) return;

  filaEmExecucao = true;
  const campanhasAfetadas = new Set();

  try {
    const devidos = await posts
      .find({ status: 'pendente', dataExecucao: { $lte: now() } })
      .sort({ dataExecucao: 1 });

    if (!devidos.length) return;

    const grupos = new Map();

    for (const post of devidos) {
      campanhasAfetadas.add(post.campanhaId);

      const chave = `${post.userId}::${post.accountId}`;
      if (!grupos.has(chave)) grupos.set(chave, []);
      grupos.get(chave).push(post);
    }

    for (const grupo of grupos.values()) {
      const accountId = grupo[0].accountId;
      const userId = grupo[0].userId;
      const ids = grupo.map(p => p._id);

      await posts.update(
        { _id: { $in: ids } },
        { $set: { status: 'processando', motivo: null } },
        { multi: true }
      );

      const campanhaIds = [...new Set(grupo.map(p => p.campanhaId))];
      await campaigns.update(
        { _id: { $in: campanhaIds } },
        { $set: { status: 'processando' } },
        { multi: true }
      );

      try {
        await fecharNavegadorFacebook(accountId, userId);
      } catch (erro) {
        log('warn', 'fila_fechar_navegador', { accountId, userId, erro: erro.message });
      }

      let resultados;
      try {
        log('info', 'fila_grupo_inicio', {
          conta: grupo[0].perfilId,
          accountId,
          publicacoes: grupo.length,
          destinos: grupo.map(p => p.grupoUrl)
        });

        resultados = await dispararPostagens({ posts: grupo });
      } catch (erro) {
        resultados = grupo.map(() => ({ sucesso: false, erro: String(erro.message || erro) }));
      }

      for (let i = 0; i < grupo.length; i++) {
        const post = grupo[i];
        const resultado = resultados[i] || { sucesso: false, erro: 'Executor não retornou resultado.' };

        if (resultado.sucesso) {
          await posts.update(
            { _id: post._id },
            {
              $set: {
                status: 'concluido',
                executadoEm: now(),
                motivo: null
              }
            }
          );
          log('info', 'publicacao_sucesso', {
            conta: post.perfilId,
            grupo: post.grupoUrl,
            campanhaId: post.campanhaId
          });
        } else {
          await posts.update(
            { _id: post._id },
            {
              $set: {
                status: 'falhou',
                executadoEm: now(),
                motivo: String(resultado.erro || 'Falha ao publicar no destino.')
              },
              $inc: { tentativas: 1 }
            }
          );
          log('warn', 'publicacao_falha', {
            conta: post.perfilId,
            grupo: post.grupoUrl,
            campanhaId: post.campanhaId,
            erro: resultado.erro
          });
        }
      }
    }
  } catch (erro) {
    log('error', 'fila_execucao', { erro: String(erro.message || erro) });
  } finally {
    try {
      for (const campanhaId of campanhasAfetadas) {
        await atualizarStatusCampanha(campanhaId);
      }
    } catch (erro) {
      log('error', 'fila_atualizar_campanha', { erro: String(erro.message || erro) });
    }
    filaEmExecucao = false;
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function getCookie(req, name) {
  const match = req.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

async function getCurrentUser(req) {
  const token = getCookie(req, 'postador_session');
  if (!token) return null;

  const session = await sessions.findOne({ token });
  if (!session) return null;

  if (new Date(session.expiresAt) <= now()) {
    await sessions.remove({ token }, {});
    return null;
  }

  return users.findOne({ _id: session.userId });
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');

  await sessions.insert({
    _id: makeId(),
    token,
    userId,
    createdAt: now(),
    expiresAt: addDays(now(), SESSION_DAYS)
  });

  return token;
}

function setSession(res, token) {
  res.setHeader(
    'Set-Cookie',
    `postador_session=${token}; HttpOnly; Path=/; SameSite=Lax; ${COOKIE_SECURE ? 'Secure; ' : ''}Max-Age=${SESSION_DAYS * 86400}`
  );
}

async function getAccessState(user) {
  if (!user) return { allowed: false, status: 'unauthenticated' };

  if (
    user.plano === 'pro' &&
    user.dataExpiracao &&
    new Date(user.dataExpiracao) > now()
  ) {
    return { allowed: true, status: 'pro' };
  }

  if (user.trialFim && new Date(user.trialFim) > now()) {
    return { allowed: true, status: 'trial' };
  }

  return { allowed: false, status: 'expired' };
}

async function auth(req, res, next) {
  req.user = await getCurrentUser(req);

  if (!req.user) {
    return res.status(401).json({ erro: 'Faça login para continuar.' });
  }

  next();
}

async function access(req, res, next) {
  req.user = await getCurrentUser(req);

  const state = await getAccessState(req.user);

  if (!state.allowed) {
    return res.status(402).json({
      erro: 'Seu acesso expirou. Escolha um plano para continuar.'
    });
  }

  req.access = state;
  next();
}

function limitesDePlano(user) {
  return user && user.plano === 'pro' ? PLAN_LIMITS.pro : PLAN_LIMITS.trial;
}

function normalizarDestinos(values) {
  const vistos = new Set();
  const destinos = [];
  const invalidos = [];

  for (const raw of values) {
    const url = String(raw || '').trim();
    if (!url) continue;

    if (!/^https?:\/\//i.test(url)) {
      invalidos.push(url);
      continue;
    }

    let hostname;
    let protocol;
    try {
      const parsed = new URL(url);
      hostname = parsed.hostname;
      protocol = parsed.protocol;
    } catch {
      invalidos.push(url);
      continue;
    }

    if (protocol !== 'http:' && protocol !== 'https:') {
      invalidos.push(url);
      continue;
    }

    if (!/(^|\.)facebook\.com$/i.test(hostname)) {
      invalidos.push(url);
      continue;
    }

    const chave = hostname.toLowerCase() + url.replace(/\/+$/, '');
    if (vistos.has(chave)) continue;

    vistos.add(chave);
    destinos.push(url);
  }

  return { destinos, invalidos };
}

function mensagemDestinosInvalidos(invalidos) {
  return `URL(s) de destino inválida(s): ${invalidos.slice(0, 3).join(', ')}${invalidos.length > 3 ? ` (e mais ${invalidos.length - 3})` : ''}. Use links https://facebook.com de grupos.`;
}

app.get('/api/me', async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({ erro: 'Não autenticado.' });
    }

    const state = await getAccessState(user);

    res.json({
      id: user._id,
      nome: user.nome,
      email: user.email,
      plano: user.plano || 'trial',
      statusPagamento: state.status,
      trialInicio: user.trialInicio || null,
      trialFim: user.trialFim || null,
      dataExpiracao: user.dataExpiracao || null,
      limites: limitesDePlano(user)
    });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/register', limiteRegistro, async (req, res) => {
  try {
    const nome = String(req.body.nome || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (nome.length < 2) {
      return res.status(400).json({ erro: 'Informe seu nome.' });
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ erro: 'Informe um e-mail válido.' });
    }

    if (password.length < 6) {
      return res.status(400).json({
        erro: 'A senha precisa ter pelo menos 6 caracteres.'
      });
    }

    const existing = await users.findOne({ email });

    if (existing) {
      return res.status(409).json({
        erro: 'Este e-mail já está cadastrado.'
      });
    }

    const createdAt = now();

    const user = await users.insert({
      _id: makeId(),
      nome,
      email,
      senhaHash: await bcrypt.hash(password, 12),
      criadoEm: createdAt,
      trialInicio: createdAt,
      trialFim: addDays(createdAt, TRIAL_DAYS),
      plano: 'trial',
      statusPagamento: 'trial'
    });

    const token = await createSession(user._id);
    setSession(res, token);

    res.status(201).json({
      id: user._id,
      nome: user.nome,
      email: user.email,
      plano: 'trial',
      statusPagamento: 'trial',
      trialFim: user.trialFim
    });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/login', limiteLogin, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    const user = await users.findOne({ email });

    if (!user || !(await bcrypt.compare(password, user.senhaHash))) {
      return res.status(401).json({
        erro: 'E-mail ou senha incorretos.'
      });
    }

    const token = await createSession(user._id);
    setSession(res, token);

    const state = await getAccessState(user);

    res.json({
      id: user._id,
      nome: user.nome,
      email: user.email,
      plano: user.plano || 'trial',
      statusPagamento: state.status,
      trialFim: user.trialFim || null,
      dataExpiracao: user.dataExpiracao || null
    });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    const token = getCookie(req, 'postador_session');

    if (token) {
      await sessions.remove({ token }, {});
    }

    res.setHeader(
      'Set-Cookie',
      `postador_session=; HttpOnly; Path=/; SameSite=Lax; ${COOKIE_SECURE ? 'Secure; ' : ''}Max-Age=0`
    );

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.get('/api/subscription', auth, async (req, res) => {
  const state = await getAccessState(req.user);

  let nome = 'Acesso encerrado';
  let descricao = 'Escolha um plano para continuar.';

  if (state.status === 'trial') {
    nome = 'Avaliação gratuita — 7 dias';
    descricao = `Sua avaliação termina em ${new Date(req.user.trialFim).toLocaleDateString('pt-BR')}.`;
  }

  if (state.status === 'pro') {
    nome =
      req.user.tipoPlano === 'annual'
        ? 'Postador Pro Anual'
        : 'Postador Pro Mensal';

    descricao = `Acesso ativo até ${new Date(req.user.dataExpiracao).toLocaleDateString('pt-BR')}.`;
  }

  res.json({
    ativo: state.allowed,
    status: state.status,
    nome,
    descricao
  });
});

app.get('/api/dashboard', access, async (req, res) => {
  try {
    const userPosts = await posts.find({ userId: req.user._id });
    const userCampaigns = await campaigns.find({ userId: req.user._id });

    const proximas = userCampaigns
      .filter(
        item =>
          ['pendente', 'processando'].includes(item.status) &&
          new Date(item.dataExecucao) >= now()
      )
      .sort((a, b) => new Date(a.dataExecucao) - new Date(b.dataExecucao))
      .slice(0, 5);

    res.json({
      totalCampanhas: userCampaigns.length,
      agendadas: userCampaigns.filter(item => item.status === 'pendente').length,
      concluidas: userPosts.filter(item => item.status === 'concluido').length,
      falhas: userPosts.filter(item => item.status === 'falhou').length,
      proximas: proximas.map(item => ({
        id: item._id,
        nome: item.nome,
        destinos: item.totalDestinos,
        dataExecucao: item.dataExecucao
      }))
    });
  } catch (error) {
    log('error', 'dashboard', { erro: String(error.message || error) });
    res.status(500).json({ erro: error.message });
  }
});

app.get('/api/history', access, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.perPage, 10) || 25)
    );

    const filtro = { userId: req.user._id };

    if (req.query.accountId) {
      filtro.accountId = String(req.query.accountId);
    }

    const total = await posts.count(filtro);
    const totalPages = Math.ceil(total / perPage);

    const resultado = await posts
      .find(filtro)
      .sort({ executadoEm: -1, criadoEm: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage);

    res.json({
      posts: resultado,
      page,
      perPage,
      total,
      totalPages
    });
  } catch (error) {
    log('error', 'historico', { erro: String(error.message || error) });
    res.status(500).json({ erro: error.message });
  }
});

function csvCell(value) {
  const texto = String(value ?? '');
  return /[";,\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

app.get('/api/history/export.csv', access, async (req, res) => {
  try {
    const filtro = { userId: req.user._id };

    if (req.query.accountId) {
      filtro.accountId = String(req.query.accountId);
    }

    const resultado = await posts
      .find(filtro)
      .sort({ executadoEm: -1, criadoEm: -1 });

    const linhas = [[
      'Data',
      'Campanha',
      'Conta',
      'Destino',
      'Status',
      'Tentativas',
      'Erro',
      'Executado em'
    ].join(';')];

    for (const p of resultado) {
      linhas.push([
        csvCell(p.criadoEm ? new Date(p.criadoEm).toLocaleString('pt-BR') : ''),
        csvCell(p.campanhaNome),
        csvCell(p.perfilId),
        csvCell(p.grupoUrl),
        csvCell(p.status),
        csvCell(p.tentativas || 0),
        csvCell(p.motivo),
        csvCell(p.executadoEm ? new Date(p.executadoEm).toLocaleString('pt-BR') : '')
      ].join(';'));
    }

    const csv = '\uFEFF' + linhas.join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="postador-historico-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.get('/api/campaigns', access, async (req, res) => {
  try {
    const result = await campaigns
      .find({ userId: req.user._id })
      .sort({ dataExecucao: -1 });

    res.json({ campaigns: result });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/campaigns', access, async (req, res) => {
  try {
    const nome = String(req.body.nome || '').trim();
    const accountId = String(req.body.accountId || '').trim();

    const { destinos, invalidos } = normalizarDestinos(
      Array.isArray(req.body.destinos) ? req.body.destinos : []
    );

    const textos = Array.isArray(req.body.textos)
      ? req.body.textos.map(value => String(value).trim()).filter(Boolean)
      : [];

    const imagens = Array.isArray(req.body.imagens)
      ? req.body.imagens.map(value => String(value).trim()).filter(Boolean)
      : [];

    const dataExecucao = new Date(req.body.dataExecucao);

    if (!nome) {
      return res.status(400).json({ erro: 'Informe o nome da campanha.' });
    }

    if (!accountId) {
      return res.status(400).json({ erro: 'Escolha uma conta Facebook.' });
    }

    if (invalidos.length) {
      return res.status(400).json({ erro: mensagemDestinosInvalidos(invalidos) });
    }

    if (!destinos.length) {
      return res.status(400).json({ erro: 'Adicione pelo menos um destino válido.' });
    }

    const limite = limitesDePlano(req.user);

    if (destinos.length > limite.destinosPorCampanha) {
      return res.status(403).json({
        erro: `Seu plano permite até ${limite.destinosPorCampanha} destinos por campanha. Ajuste o plano para publicar mais.`
      });
    }

    const ativas = await campaigns.count({
      userId: req.user._id,
      status: { $in: ['pendente', 'processando'] }
    });

    if (ativas >= limite.campanhasAtivas) {
      return res.status(403).json({
        erro: `Seu plano permite até ${limite.campanhasAtivas} campanha(s) ativa(s). Conclua, cancele ou exclua campanhas antes de criar novas.`
      });
    }

    if (!textos.length) {
      return res.status(400).json({ erro: 'Adicione pelo menos um texto.' });
    }

    if (Number.isNaN(dataExecucao.getTime())) {
      return res.status(400).json({
        erro: 'Data e hora inválidas.'
      });
    }

    const account = await accounts.findOne({
      _id: accountId,
      userId: req.user._id
    });

    if (!account) {
      return res.status(404).json({
        erro: 'Conta Facebook não encontrada.'
      });
    }

    const campanhaId = makeId();

    await campaigns.insert({
      _id: campanhaId,
      userId: req.user._id,
      nome,
      perfilId: account.nome,
      accountId,
      destinos,
      textos,
      imagens,
      dataExecucao,
      totalDestinos: destinos.length,
      status: 'pendente',
      criadoEm: now()
    });

    for (const grupoUrl of destinos) {
      await posts.insert({
        _id: makeId(),
        userId: req.user._id,
        campanhaId,
        campanhaNome: nome,
        perfilId: account.nome,
        accountId,
        profileDir: profileDir(req.user._id, accountId),
        grupoUrl,
        textos,
        imagens,
        dataExecucao,
        status: 'pendente',
        tentativas: 0,
        criadoEm: now()
      });
    }

    res.status(201).json({
      ok: true,
      id: campanhaId
    });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/campaigns/:id/retry', access, async (req, res) => {
  try {
    const campaign = await campaigns.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!campaign) {
      return res.status(404).json({
        erro: 'Campanha não encontrada.'
      });
    }

    await posts.update(
      {
        userId: req.user._id,
        campanhaId: campaign._id,
        status: 'falhou'
      },
      {
        $set: {
          status: 'pendente',
          motivo: null,
          dataExecucao: now()
        }
      },
      { multi: true }
    );

    await campaigns.update(
      { _id: campaign._id },
      { $set: { status: 'pendente' } }
    );

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.put('/api/campaigns/:id', access, async (req, res) => {
  try {
    const campaign = await campaigns.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!campaign) {
      return res.status(404).json({ erro: 'Campanha não encontrada.' });
    }

    if (campaign.status !== 'pendente') {
      return res.status(400).json({
        erro: 'Só é possível editar campanhas que ainda não foram executadas.'
      });
    }

    const nome = String(req.body.nome || '').trim();
    const accountId = String(req.body.accountId || campaign.accountId || '').trim();

    const { destinos, invalidos } = normalizarDestinos(
      Array.isArray(req.body.destinos) ? req.body.destinos : []
    );

    const textos = Array.isArray(req.body.textos)
      ? req.body.textos.map(value => String(value).trim()).filter(Boolean)
      : [];

    const imagens = Array.isArray(req.body.imagens)
      ? req.body.imagens.map(value => String(value).trim()).filter(Boolean)
      : [];

    const dataExecucao = new Date(req.body.dataExecucao);

    if (!nome) {
      return res.status(400).json({ erro: 'Informe o nome da campanha.' });
    }

    if (!accountId) {
      return res.status(400).json({ erro: 'Escolha uma conta Facebook.' });
    }

    if (invalidos.length) {
      return res.status(400).json({ erro: mensagemDestinosInvalidos(invalidos) });
    }

    if (!destinos.length) {
      return res.status(400).json({ erro: 'Adicione pelo menos um destino válido.' });
    }

    const limite = limitesDePlano(req.user);

    if (destinos.length > limite.destinosPorCampanha) {
      return res.status(403).json({
        erro: `Seu plano permite até ${limite.destinosPorCampanha} destinos por campanha. Ajuste o plano para publicar mais.`
      });
    }

    if (!textos.length) {
      return res.status(400).json({ erro: 'Adicione pelo menos um texto.' });
    }

    if (Number.isNaN(dataExecucao.getTime())) {
      return res.status(400).json({ erro: 'Data e hora inválidas.' });
    }

    const account = await accounts.findOne({
      _id: accountId,
      userId: req.user._id
    });

    if (!account) {
      return res.status(404).json({ erro: 'Conta Facebook não encontrada.' });
    }

    await posts.remove({ campanhaId: campaign._id }, { multi: true });

    for (const grupoUrl of destinos) {
      await posts.insert({
        _id: makeId(),
        userId: req.user._id,
        campanhaId: campaign._id,
        campanhaNome: nome,
        perfilId: account.nome,
        accountId,
        profileDir: profileDir(req.user._id, accountId),
        grupoUrl,
        textos,
        imagens,
        dataExecucao,
        status: 'pendente',
        tentativas: 0,
        criadoEm: now()
      });
    }

    await campaigns.update(
      { _id: campaign._id },
      {
        $set: {
          nome,
          perfilId: account.nome,
          accountId,
          destinos,
          textos,
          imagens,
          dataExecucao,
          totalDestinos: destinos.length,
          status: 'pendente'
        }
      }
    );

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/campaigns/:id/cancel', access, async (req, res) => {
  try {
    const campaign = await campaigns.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!campaign) {
      return res.status(404).json({ erro: 'Campanha não encontrada.' });
    }

    if (['concluido', 'cancelado'].includes(campaign.status)) {
      return res.status(400).json({
        erro: 'Esta campanha não pode mais ser cancelada.'
      });
    }

    await posts.update(
      {
        campanhaId: campaign._id,
        status: { $in: ['pendente', 'processando'] }
      },
      {
        $set: {
          status: 'cancelado',
          motivo: 'Cancelada pelo usuário'
        }
      },
      { multi: true }
    );

    await campaigns.update(
      { _id: campaign._id },
      { $set: { status: 'cancelado' } }
    );

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.delete('/api/campaigns/:id', access, async (req, res) => {
  try {
    const campaign = await campaigns.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!campaign) {
      return res.status(404).json({ erro: 'Campanha não encontrada.' });
    }

    await posts.remove({ campanhaId: campaign._id }, { multi: true });
    await campaigns.remove({ _id: campaign._id }, {});

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.get('/api/facebook/accounts', access, async (req, res) => {
  try {
    const result = await accounts
      .find({ userId: req.user._id })
      .sort({ criadoEm: 1 });

    res.json({ accounts: result });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/facebook/connect', access, async (req, res) => {
  try {
    const limite = limitesDePlano(req.user);
    const totalContas = await accounts.count({ userId: req.user._id });

    if (totalContas >= limite.contas) {
      return res.status(403).json({
        erro: `Seu plano permite até ${limite.contas} conta(s) Facebook conectada(s). Desconecte uma conta ou faça upgrade para conectar mais.`
      });
    }

    const account = await accounts.insert({
      _id: makeId(),
      userId: req.user._id,
      nome: `Facebook ${Date.now().toString().slice(-4)}`,
      status: 'conectando',
      criadoEm: now()
    });

    try {
      await abrirNavegadorFacebook(account._id, req.user._id);

      await accounts.update(
        { _id: account._id },
        {
          $set: {
            status: 'login_necessario'
          }
        }
      );

      res.json({
        ok: true,
        id: account._id,
        mensagem:
          'A janela do Facebook foi aberta. Faça o login nela e depois volte ao Postador.'
      });
    } catch (error) {
      await accounts.update(
        { _id: account._id },
        {
          $set: {
            status: 'erro',
            motivo: error.message
          }
        }
      );

      res.status(500).json({
        erro: error.message
      });
    }
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.delete('/api/facebook/accounts/:id', access, async (req, res) => {
  try {
    const account = await accounts.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!account) {
      return res.status(404).json({ erro: 'Conta Facebook não encontrada.' });
    }

    const ativas = await campaigns.count({
      userId: req.user._id,
      accountId: account._id,
      status: { $in: ['pendente', 'processando'] }
    });

    if (ativas > 0) {
      return res.status(400).json({
        erro: `Esta conta tem ${ativas} campanha(s) ativa(s). Cancele ou exclua essas campanhas antes de desconectar.`
      });
    }

    try {
      await fecharNavegadorFacebook(account._id, req.user._id);
    } catch (erro) {
      log('warn', 'desconectar_fechar_navegador', { accountId: account._id, erro: erro.message });
    }

    const dir = profileDir(req.user._id, account._id);
    fs.rmSync(dir, { recursive: true, force: true });

    await accounts.remove({ _id: account._id }, {});

    log('info', 'conta_desconectada', { accountId: account._id, conta: account.nome });
    res.json({ ok: true });
  } catch (error) {
    log('error', 'desconectar_conta', { erro: String(error.message || error) });
    res.status(500).json({ erro: error.message });
  }
});

app.get('/api/facebook/accounts/status', access, async (req, res) => {
  try {
    const list = await accounts.find({ userId: req.user._id });

    const result = await Promise.all(
      list.map(async account => {
        const state = await statusFacebook(account._id, req.user._id);
        return { ...account, ...state };
      })
    );

    res.json({ accounts: result });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/uploads', access, jsonUploads, async (req, res) => {
  try {
    const data = String(req.body.data || '');
    const match = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(data);

    if (!match) {
      return res.status(400).json({
        erro: 'Envie uma imagem válida (png, jpg, gif ou webp) em base64.'
      });
    }

    const buffer = Buffer.from(match[2], 'base64');

    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
      return res.status(400).json({
        erro: 'Imagem inválida ou maior que 8 MB.'
      });
    }

    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const nomeArquivo = `${makeId()}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, nomeArquivo), buffer);

    res.status(201).json({
      ok: true,
      url: `/uploads/${nomeArquivo}`,
      path: path.join(UPLOADS_DIR, nomeArquivo),
      nome: nomeArquivo
    });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/billing/create-checkout', access, async (req, res) => {
  try {
    if (!INFINITEPAY_HANDLE) {
      return res.status(500).json({
        erro: 'Configure INFINITEPAY_HANDLE no ambiente do servidor.'
      });
    }

    const plan = PLANS[req.body.plan];

    if (!plan) {
      return res.status(400).json({
        erro: 'Plano inválido.'
      });
    }

    const order_nsu = `postador-${req.user._id}-${Date.now()}`;

    await payments.insert({
      _id: makeId(),
      order_nsu,
      userId: req.user._id,
      plan: req.body.plan,
      amount: plan.price,
      status: 'pending',
      criadoEm: now()
    });

    const payload = {
      handle: INFINITEPAY_HANDLE,
      redirect_url: `${PUBLIC_BASE_URL}/?payment=return`,
      webhook_url: `${PUBLIC_BASE_URL}/api/webhooks/infinitepay`,
      order_nsu,
      items: [
        {
          quantity: 1,
          price: plan.price,
          description: plan.name
        }
      ]
    };

    const response = await fetch(
      'https://api.checkout.infinitepay.io/links',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );

    const data = await response.json();

    if (!response.ok || !data.url) {
      throw new Error(
        data.message || 'Não foi possível criar o checkout InfinitePay.'
      );
    }

    await payments.update(
      { order_nsu },
      {
        $set: {
          checkoutUrl: data.url
        }
      }
    );

    res.json({
      url: data.url
    });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

async function confirmarPagamento({ order_nsu, transaction_nsu, invoice_slug, expectedAmount }) {
  if (!INFINITEPAY_HANDLE) {
    throw new Error('INFINITEPAY_HANDLE não configurado.');
  }

  const response = await fetch('https://api.checkout.infinitepay.io/payment_check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handle: INFINITEPAY_HANDLE,
      order_nsu,
      transaction_nsu,
      slug: invoice_slug
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.success !== true) {
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

app.post('/api/webhooks/infinitepay', limiteWebhook, async (req, res) => {
  try {
    const data = req.body || {};
    const order_nsu = String(data.order_nsu || '');
    const transaction_nsu = String(data.transaction_nsu || '');
    const invoice_slug = String(data.invoice_slug || '');

    if (!order_nsu) {
      return res.status(400).json({
        success: false,
        message: 'order_nsu ausente'
      });
    }

    const payment = await payments.findOne({ order_nsu });

    if (!payment) {
      return res.status(400).json({
        success: false,
        message: 'Pedido não encontrado'
      });
    }

    if (payment.status === 'paid') {
      return res.status(200).json({
        success: true,
        message: null
      });
    }

    if (!transaction_nsu || !invoice_slug) {
      return res.status(400).json({
        success: false,
        message: 'Dados da transação ausentes'
      });
    }

    const expectedAmount = PLANS[payment.plan]?.price;

    if (!expectedAmount) {
      return res.status(400).json({
        success: false,
        message: 'Plano do pedido inválido'
      });
    }

    if (Number(data.amount) !== Number(expectedAmount)) {
      return res.status(400).json({
        success: false,
        message: 'Valor do pedido não confere'
      });
    }

    let confirmacao;
    try {
      confirmacao = await confirmarPagamento({
        order_nsu,
        transaction_nsu,
        invoice_slug,
        expectedAmount
      });
    } catch (erro) {
      log('error', 'infinitepay_confirmacao', { erro: erro.message });
      return res.status(400).json({
        success: false,
        message: erro.message
      });
    }

    await payments.update(
      { order_nsu },
      {
        $set: {
          status: 'paid',
          transaction_nsu: transaction_nsu || null,
          invoice_slug: invoice_slug || null,
          receipt_url: data.receipt_url || null,
          pagoEm: now()
        }
      }
    );

    const user = await users.findOne({ _id: payment.userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuário não encontrado'
      });
    }

    const duration = PLANS[payment.plan].days;
    const currentExpiration =
      user.dataExpiracao && new Date(user.dataExpiracao) > now()
        ? new Date(user.dataExpiracao)
        : now();

    await users.update(
      { _id: user._id },
      {
        $set: {
          plano: 'pro',
          tipoPlano: payment.plan,
          statusPagamento: 'paid',
          dataInicio: now(),
          dataExpiracao: addDays(currentExpiration, duration)
        }
      }
    );

    res.status(200).json({
      success: true,
      message: null
    });
  } catch (error) {
    log('error', 'infinitepay_webhook', { erro: String(error.message || error) });
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get('/pagamento-concluido', (req, res) => {
  res.send(`
    <!doctype html>
    <html lang="pt-BR">
      <head><meta charset="utf-8"><title>Pagamento</title></head>
      <body style="font-family:Arial;padding:40px">
        <h2>Pagamento recebido</h2>
        <p>Estamos confirmando sua assinatura. Volte ao Postador em alguns instantes.</p>
      </body>
    </html>
  `);
});

app.use((err, req, res, next) => {
  log('error', 'erro_interno', { erro: String(err?.message || err), pilha: err?.stack });

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    erro: 'Erro interno do servidor.'
  });
});

resetarProcessandoNoBoot()
  .then(() => {
    log('info', 'fila_pronta', { mensagem: 'fila pronta. Verificando publicações pendentes...' });
    processarFila();
    cron.schedule('*/30 * * * * *', () => {
      processarFila().catch(erro =>
        log('error', 'fila_cron', { erro: String(erro.message || erro) })
      );
    });
  })
  .catch(erro => log('error', 'fila_inicio', { erro: String(erro.message || erro) }));

app.listen(PORT, HOST, () => {
  log('info', 'servidor_iniciado', {
    porta: PORT,
    url: PUBLIC_BASE_URL,
    segura: Boolean(COOKIE_SECURE),
    planos: {
      trial: PLAN_LIMITS.trial,
      pro: PLAN_LIMITS.pro
    }
  });
});