'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { db } = require('./../db');
const auth = require('./../auth');
const config = require('./../config');
const queue = require('./../queue');
const facebook = require('./../facebook');
const log = require('./../log');
const {
  envolver,
  naoEncontrado,
  texto,
  listaTextos,
  normalizarDestinos,
  mensagemDestinosInvalidos,
  parseData,
  paginacao,
  resumoCampanha,
  isAtiva
} = require('./helpers');

function limiteDoPlano(limite, mensagem) {
  return Object.assign(new Error(mensagem), { status: 403, codigo: 'limite_do_plano' });
}

function validarDestinos(user, destinos) {
  const limite = auth.limitesDoPlano(user);
  if (destinos.length > limite.destinosPorCampanha) {
    throw limiteDoPlano(
      limite,
      `Seu plano permite até ${limite.destinosPorCampanha} destinos por campanha. Ajuste o plano para publicar mais.`
    );
  }
}

async function garantirEspacoAtivo(user, ignorarCampanhaId) {
  const limite = auth.limitesDoPlano(user);
  const filtro = { userId: user._id, status: { $in: [queue.STATUS.PENDENTE, queue.STATUS.PROCESSANDO] } };
  if (ignorarCampanhaId) filtro._id = { $ne: ignorarCampanhaId };

  const ativas = await db.campaigns.count(filtro);
  if (ativas >= limite.campanhasAtivas) {
    throw Object.assign(
      new Error(
        `Seu plano permite até ${limite.campanhasAtivas} campanha(s) ativa(s). Conclua, cancele ou exclua campanhas antes de criar novas.`
      ),
      { status: 403, codigo: 'limite_do_plano' }
    );
  }
}

async function validarConta(user, accountId) {
  const account = await db.accounts.findOne({ _id: accountId, userId: user._id });
  if (!account) {
    throw Object.assign(new Error('Conta Facebook não encontrada.'), { status: 404 });
  }
  return account;
}

function registrar(router) {
  router.get(
    '/dashboard',
    auth.exigirAcesso,
    envolver(async (req, res) => {
      const userId = req.user._id;
      const [userCampaigns, userPosts] = await Promise.all([
        db.campaigns.find({ userId }),
        db.posts.find({ userId })
      ]);

      const proximas = userCampaigns
        .filter(c => isAtiva(c.status) && new Date(c.dataExecucao) >= new Date())
        .sort((a, b) => new Date(a.dataExecucao) - new Date(b.dataExecucao))
        .slice(0, 5)
        .map(c => ({ id: c._id, nome: c.nome, destinos: c.totalDestinos, dataExecucao: c.dataExecucao }));

      const contas = await db.accounts.find({ userId });

      res.json({
        totalCampanhas: userCampaigns.length,
        ativas: userCampaigns.filter(c => isAtiva(c.status)).length,
        agendadas: userCampaigns.filter(c => c.status === queue.STATUS.PENDENTE).length,
        concluidas: userPosts.filter(p => p.status === queue.STATUS.CONCLUIDO).length,
        falhas: userPosts.filter(p => p.status === queue.STATUS.FALHOU).length,
        interrompidas: userPosts.filter(p => p.status === queue.STATUS.INTERROMPIDO).length,
        totalDestinos: userPosts.length,
        contas: contas.length,
        contasConectadas: contas.filter(c => c.conectada).length,
        limiteContas: auth.limitesDoPlano(req.user).contas,
        limiteCampanhas: auth.limitesDoPlano(req.user).campanhasAtivas,
        limiteDestinos: auth.limitesDoPlano(req.user).destinosPorCampanha,
        proximas
      });
    })
  );

  router.get(
    '/campaigns',
    auth.exigirAcesso,
    envolver(async (req, res) => {
      const { page, perPage, skip } = paginacao(req.query);
      const filtro = { userId: req.user._id };
      if (req.query.status) filtro.status = String(req.query.status);

      const [total, lista] = await Promise.all([
        db.campaigns.count(filtro),
        db.campaigns.find(filtro).sort({ dataExecucao: -1 }).skip(skip).limit(perPage)
      ]);

      res.json({
        campanhas: lista.map(resumoCampanha),
        page,
        perPage,
        total,
        totalPages: Math.ceil(total / perPage)
      });
    })
  );

  router.post(
    '/campaigns',
    auth.exigirAcesso,
    envolver(async (req, res) => {
      const nome = texto(req.body.nome, 'o nome da campanha', { min: 2, max: config.MAX_CAMPANHA_NOME });
      const accountId = String(req.body.accountId || '').trim();
      const { destinos, invalidos } = normalizarDestinos(req.body.destinos);
      const textos = listaTextos(req.body.textos);
      const imagens = Array.isArray(req.body.imagens)
        ? req.body.imagens.map(v => String(v).trim()).filter(Boolean).slice(0, 20)
        : [];
      const dataExecucao = parseData(req.body.dataExecucao);

      if (!accountId) throw Object.assign(new Error('Escolha uma conta Facebook.'), { status: 400 });
      if (invalidos.length) throw Object.assign(new Error(mensagemDestinosInvalidos(invalidos)), { status: 400 });
      if (!destinos.length) throw Object.assign(new Error('Adicione pelo menos um destino válido.'), { status: 400 });
      if (!textos.length) throw Object.assign(new Error('Adicione pelo menos um texto.'), { status: 400 });

      await validarDestinos(req.user, destinos);
      await garantirEspacoAtivo(req.user);
      const conta = await validarConta(req.user, accountId);

      const campanhaId = crypto.randomUUID();
      const agora = new Date();
      const perfil = facebook.profileDir(req.user._id, accountId);

      await db.campaigns.insert({
        _id: campanhaId,
        userId: req.user._id,
        nome,
        perfilId: conta.nome,
        accountId,
        destinos,
        textos,
        imagens,
        dataExecucao,
        totalDestinos: destinos.length,
        status: queue.STATUS.PENDENTE,
        criadoEm: agora
      });

      for (const grupoUrl of destinos) {
        await db.posts.insert({
          _id: crypto.randomUUID(),
          userId: req.user._id,
          campanhaId,
          campanhaNome: nome,
          perfilId: conta.nome,
          accountId,
          profileDir: perfil,
          grupoUrl,
          textos,
          imagens,
          dataExecucao,
          status: queue.STATUS.PENDENTE,
          tentativas: 0,
          criadoEm: agora
        });
      }

      log.info('campanha_criada', { campanhaId, destinos: destinos.length, userId: req.user._id });
      res.status(201).json({ ok: true, id: campanhaId, destinos: destinos.length });
    })
  );

  router.put(
    '/campaigns/:id',
    auth.exigirAcesso,
    envolver(async (req, res) => {
      const campanha = await db.campaigns.findOne({ _id: req.params.id, userId: req.user._id });
      if (!campanha) return naoEncontrado(res, 'Campanha não encontrada.');

      if (campanha.status !== queue.STATUS.PENDENTE) {
        throw Object.assign(
          new Error('Só é possível editar campanhas que ainda não foram executadas.'),
          { status: 400 }
        );
      }

      const nome = texto(req.body.nome, 'o nome da campanha', { min: 2, max: config.MAX_CAMPANHA_NOME });
      const accountId = String(req.body.accountId || campanha.accountId || '').trim();
      const { destinos, invalidos } = normalizarDestinos(req.body.destinos);
      const textos = listaTextos(req.body.textos);
      const imagens = Array.isArray(req.body.imagens)
        ? req.body.imagens.map(v => String(v).trim()).filter(Boolean).slice(0, 20)
        : [];
      const dataExecucao = parseData(req.body.dataExecucao);

      if (!accountId) throw Object.assign(new Error('Escolha uma conta Facebook.'), { status: 400 });
      if (invalidos.length) throw Object.assign(new Error(mensagemDestinosInvalidos(invalidos)), { status: 400 });
      if (!destinos.length) throw Object.assign(new Error('Adicione pelo menos um destino válido.'), { status: 400 });
      if (!textos.length) throw Object.assign(new Error('Adicione pelo menos um texto.'), { status: 400 });

      await validarDestinos(req.user, destinos);
      const conta = await validarConta(req.user, accountId);

      await db.posts.remove({ campanhaId: campanha._id, status: { $ne: queue.STATUS.PROCESSANDO } }, { multi: true });

      const perfil = facebook.profileDir(req.user._id, accountId);
      const agora = new Date();

      for (const grupoUrl of destinos) {
        await db.posts.insert({
          _id: crypto.randomUUID(),
          userId: req.user._id,
          campanhaId: campanha._id,
          campanhaNome: nome,
          perfilId: conta.nome,
          accountId,
          profileDir: perfil,
          grupoUrl,
          textos,
          imagens,
          dataExecucao,
          status: queue.STATUS.PENDENTE,
          tentativas: 0,
          criadoEm: agora
        });
      }

      await db.campaigns.update(
        { _id: campanha._id },
        {
          $set: {
            nome,
            perfilId: conta.nome,
            accountId,
            destinos,
            textos,
            imagens,
            dataExecucao,
            totalDestinos: destinos.length,
            status: queue.STATUS.PENDENTE,
            atualizadoEm: agora
          }
        }
      );

      res.json({ ok: true, id: campanha._id });
    })
  );

  router.post(
    '/campaigns/:id/retry',
    auth.exigirAcesso,
    envolver(async (req, res) => {
      const campanha = await db.campaigns.findOne({ _id: req.params.id, userId: req.user._id });
      if (!campanha) return naoEncontrado(res, 'Campanha não encontrada.');

      if (campanha.status === queue.STATUS.PROCESSANDO) {
        throw Object.assign(new Error('Esta campanha está sendo executada agora.'), { status: 400 });
      }

      const dadosExecucao = new Date(Date.now() + config.MIN_LEAD_MINUTES * 60000);

      const filtro = {
        userId: req.user._id,
        campanhaId: campanha._id,
        status: { $in: [queue.STATUS.FALHOU, queue.STATUS.INTERROMPIDO] }
      };
      if (Array.isArray(req.body.destinos) && req.body.destinos.length) {
        filtro.grupoUrl = { $in: req.body.destinos.map(String) };
      }

      const atualizados = await db.posts.update(
        filtro,
        {
          $set: {
            status: queue.STATUS.PENDENTE,
            motivo: null,
            tentativas: 0,
            proximaTentativaEm: null,
            dataExecucao: dadosExecucao
          }
        },
        { multi: true }
      );

      await db.campaigns.update(
        { _id: campanha._id },
        { $set: { status: queue.STATUS.PENDENTE, dataExecucao: dadosExecucao, atualizadoEm: new Date() } }
      );

      log.info('campanha_reprocessada', { campanhaId: campanha._id, destinos: atualizados || 0 });
      res.json({ ok: true, reenviados: atualizados || 0, dataExecucao: dadosExecucao });
    })
  );

  router.post(
    '/campaigns/:id/cancel',
    auth.exigirAcesso,
    envolver(async (req, res) => {
      const campanha = await db.campaigns.findOne({ _id: req.params.id, userId: req.user._id });
      if (!campanha) return naoEncontrado(res, 'Campanha não encontrada.');

      if ([queue.STATUS.CONCLUIDO, queue.STATUS.CANCELADO].includes(campanha.status)) {
        throw Object.assign(new Error('Esta campanha não pode mais ser cancelada.'), { status: 400 });
      }

      const atualizados = await db.posts.update(
        { campanhaId: campanha._id, status: queue.STATUS.PENDENTE },
        { $set: { status: queue.STATUS.CANCELADO, motivo: 'Cancelada pelo usuário', proximaTentativaEm: null } },
        { multi: true }
      );

      await db.campaigns.update(
        { _id: campanha._id },
        { $set: { status: queue.STATUS.CANCELADO, atualizadoEm: new Date() } }
      );

      await queue.atualizarStatusCampanha(campanha._id);
      res.json({ ok: true, cancelados: atualizados || 0 });
    })
  );

  router.delete(
    '/campaigns/:id',
    auth.exigirAcesso,
    envolver(async (req, res) => {
      const campanha = await db.campaigns.findOne({ _id: req.params.id, userId: req.user._id });
      if (!campanha) return naoEncontrado(res, 'Campanha não encontrada.');

      await db.posts.remove({ campanhaId: campanha._id, status: { $ne: queue.STATUS.PROCESSANDO } }, { multi: true });
      await db.campaigns.remove({ _id: campanha._id }, {});

      for (const imagem of campanha.imagens || []) {
        try {
          fs.rmSync(imagem, { force: true });
        } catch (erro) {
          log.warn('campanha_imagem_remover', { erro: erro.message });
        }
      }

      res.json({ ok: true });
    })
  );

  router.get(
    '/history',
    auth.exigirAcesso,
    envolver(async (req, res) => {
      const { page, perPage, skip } = paginacao(req.query);
      const filtro = { userId: req.user._id };

      if (req.query.accountId) filtro.accountId = String(req.query.accountId);
      if (req.query.campanhaId) filtro.campanhaId = String(req.query.campanhaId);
      if (req.query.status) filtro.status = String(req.query.status);

      const [total, posts] = await Promise.all([
        db.posts.count(filtro),
        db.posts.find(filtro).sort({ criadoEm: -1 }).skip(skip).limit(perPage)
      ]);

      res.json({
        posts: posts.map(p => ({
          id: p._id,
          campanhaId: p.campanhaId,
          campanha: p.campanhaNome,
          conta: p.perfilId,
          destino: p.grupoUrl,
          status: p.status,
          motivo: p.motivo || null,
          tentativas: p.tentativas || 0,
          criadoEm: p.criadoEm,
          executadoEm: p.executadoEm || null,
          dataExecucao: p.dataExecucao
        })),
        page,
        perPage,
        total,
        totalPages: Math.ceil(total / perPage)
      });
    })
  );

  function celula(valor) {
    const texto = String(valor ?? '');
    return /[";\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
  }

  router.get(
    '/history/export.csv',
    auth.exigirLogin,
    envolver(async (req, res) => {
      const filtro = { userId: req.user._id };
      if (req.query.accountId) filtro.accountId = String(req.query.accountId);
      if (req.query.campanhaId) filtro.campanhaId = String(req.query.campanhaId);
      if (req.query.status) filtro.status = String(req.query.status);

      const posts = await db.posts.find(filtro).sort({ criadoEm: -1 });

      const linhas = [
        ['Data', 'Campanha', 'Conta', 'Destino', 'Status', 'Tentativas', 'Observação', 'Agendado para', 'Executado em'].join(';')
      ];

      for (const p of posts) {
        linhas.push(
          [
            celula(p.criadoEm ? new Date(p.criadoEm).toLocaleString('pt-BR') : ''),
            celula(p.campanhaNome),
            celula(p.perfilId),
            celula(p.grupoUrl),
            celula(p.status),
            celula(p.tentativas || 0),
            celula(p.motivo),
            celula(new Date(p.dataExecucao).toLocaleString('pt-BR')),
            celula(p.executadoEm ? new Date(p.executadoEm).toLocaleString('pt-BR') : '')
          ].join(';')
        );
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="postador-historico-${new Date().toISOString().slice(0, 10)}.csv"`
      );
      res.send('\uFEFF' + linhas.join('\r\n'));
    })
  );
}

module.exports = { registrar };
