'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('./../db');
const auth = require('./../auth');
const config = require('./../config');
const facebook = require('./../facebook');
const log = require('./../log');
const { envolver, naoEncontrado, naoAutorizado, texto } = require('./helpers');

function limiteDeContas(user, total) {
  const limite = auth.limitesDoPlano(user).contas;
  if (total >= limite) {
    throw Object.assign(
      new Error(
        `Seu plano permite até ${limite} conta(s) Facebook conectada(s). Desconecte uma conta ou faça upgrade para conectar mais.`
      ),
      { status: 403, codigo: 'limite_do_plano' }
    );
  }
}

function registrar(router) {
  router.get(
    '/facebook/accounts',
    auth.exigirAcesso,
    envolver(async (req, res) => {
      const contas = await db.accounts.find({ userId: req.user._id }).sort({ criadoEm: 1 });

      const statuses = await Promise.all(
        contas.map(async conta => {
          const estado = await facebook.statusFacebook(conta._id, req.user._id);
          return { conta, estado };
        })
      );

      for (const { conta, estado } of statuses) {
        if (Boolean(conta.conectada) !== estado.connected) {
          await db.accounts.update(
            { _id: conta._id },
            { $set: { conectada: estado.connected, verificadoEm: new Date() } }
          );
        }
      }

      res.json({
        accounts: statuses.map(({ conta, estado }) => ({
          id: conta._id,
          nome: conta.nome,
          conectada: estado.connected,
          browserOpen: estado.browserOpen,
          criadaEm: conta.criadoEm
        })),
        limite: auth.limitesDoPlano(req.user).contas
      });
    })
  );

  router.post(
    '/facebook/accounts',
    auth.exigirAcesso,
    envolver(async (req, res) => {
      const nome = texto(req.body.nome, 'o nome da conta', { min: 2, max: 40 });
      const total = await db.accounts.count({ userId: req.user._id });
      limiteDeContas(req.user, total);

      const account = await db.accounts.insert({
        _id: crypto.randomUUID(),
        userId: req.user._id,
        nome,
        conectada: false,
        criadoEm: new Date()
      });

      try {
        await facebook.abrirNavegadorFacebook(account._id, req.user._id);
      } catch (erro) {
        await db.accounts.remove({ _id: account._id }, {});
        throw Object.assign(
          new Error('Não foi possível abrir a janela do Facebook no servidor. Verifique o suporte a navegador gráfico (Xvfb) do servidor.'),
          { status: 500 }
        );
      }

      log.info('conta_criada', { accountId: account._id, userId: req.user._id });
      res.status(201).json({
        ok: true,
        id: account._id,
        mensagem: 'Janela do Facebook aberta. Faça o login nela; o status muda para "Conectada" automaticamente.'
      });
    })
  );

  router.patch(
    '/facebook/accounts/:id',
    auth.exigirAcesso,
    envolver(async (req, res) => {
      const conta = await db.accounts.findOne({ _id: req.params.id, userId: req.user._id });
      if (!conta) return naoEncontrado(res, 'Conta Facebook não encontrada.');

      const nome = texto(req.body.nome, 'o nome da conta', { min: 2, max: 40 });
      await db.accounts.update({ _id: conta._id }, { $set: { nome } });

      await db.campaigns.update({ accountId: conta._id, userId: req.user._id }, { $set: { perfilId: nome } }, { multi: true });
      await db.posts.update({ accountId: conta._id, userId: req.user._id }, { $set: { perfilId: nome } }, { multi: true });

      res.json({ ok: true });
    })
  );

  router.post(
    '/facebook/accounts/:id/reabrir',
    auth.exigirAcesso,
    envolver(async (req, res) => {
      const conta = await db.accounts.findOne({ _id: req.params.id, userId: req.user._id });
      if (!conta) return naoEncontrado(res, 'Conta Facebook não encontrada.');

      const ativas = await db.campaigns.count({
        userId: req.user._id,
        accountId: conta._id,
        status: { $in: ['pendente', 'processando'] }
      });
      if (ativas > 0) {
        throw Object.assign(
          new Error(`Esta conta tem ${ativas} campanha(s) ativa(s). Aguarde ou cancele antes de reabrir a janela.`),
          { status: 400 }
        );
      }

      await facebook.abrirNavegadorFacebook(conta._id, req.user._id);
      res.json({ ok: true, mensagem: 'Janela reaberta com o perfil salvo.' });
    })
  );

  router.delete(
    '/facebook/accounts/:id',
    auth.exigirAcesso,
    envolver(async (req, res) => {
      const conta = await db.accounts.findOne({ _id: req.params.id, userId: req.user._id });
      if (!conta) return naoEncontrado(res, 'Conta Facebook não encontrada.');

      const ativas = await db.campaigns.count({
        userId: req.user._id,
        accountId: conta._id,
        status: { $in: ['pendente', 'processando'] }
      });
      if (ativas > 0) {
        throw Object.assign(
          new Error(`Esta conta tem ${ativas} campanha(s) ativa(s). Cancele ou exclua essas campanhas antes de desconectar.`),
          { status: 400 }
        );
      }

      await facebook.fecharNavegadorFacebook(conta._id, req.user._id);
      fs.rmSync(facebook.profileDir(req.user._id, conta._id), { recursive: true, force: true });
      await db.accounts.remove({ _id: conta._id }, {});

      log.info('conta_desconectada', { accountId: conta._id, userId: req.user._id });
      res.json({ ok: true });
    })
  );

  router.get(
    '/uploads/:arquivo',
    auth.exigirLogin,
    envolver(async (req, res) => {
      const nome = path.basename(String(req.params.arquivo));
      const arquivo = path.join(config.UPLOADS_DIR, nome);

      if (path.dirname(arquivo) !== config.UPLOADS_DIR || !fs.existsSync(arquivo)) {
        return naoEncontrado(res, 'Imagem não encontrada.');
      }

      const dono = await db.posts.findOne({ userId: req.user._id, imagens: nome });
      const emCampanha = await db.campaigns.findOne({ userId: req.user._id, imagens: arquivo });
      const orfa = await db.uploads.findOne({ nome, userId: req.user._id });

      if (!dono && !emCampanha && !orfa) return naoAutorizado(res, 'Esta imagem não pertence à sua conta.');

      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.sendFile(arquivo);
    })
  );
}

module.exports = { registrar };
