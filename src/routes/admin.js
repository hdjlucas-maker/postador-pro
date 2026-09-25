'use strict';

const fs = require('fs');
const config = require('./../config');
const { db, backup } = require('./../db');
const auth = require('./../auth');
const billing = require('./../billing');
const queue = require('./../queue');
const facebook = require('./../facebook');
const log = require('./../log');
const { envolver, naoEncontrado, paginacao } = require('./helpers');

function resumo(user, estado) {
  return {
    id: user._id,
    nome: user.nome,
    email: user.email,
    plano: user.plano || 'trial',
    tipoPlano: user.tipoPlano || null,
    status: estado,
    trialFim: user.trialFim || null,
    dataExpiracao: user.dataExpiracao || null,
    criadoEm: user.criadoEm,
    ultimoAcessoEm: user.ultimoAcessoEm || null,
    bloqueado: Boolean(user.bloqueado),
    admin: auth.eAdmin(user)
  };
}

function registrar(router) {
  router.get(
    '/admin/overview',
    auth.exigirLogin,
    auth.exigirAdmin,
    envolver(async (req, res) => {
      const [users, campaigns, posts, accounts, payments, pendentes] = await Promise.all([
        db.users.find({}),
        db.campaigns.find({}),
        db.posts.find({}),
        db.accounts.find({}),
        db.payments.find({}).sort({ criadoEm: -1 }).limit(20),
        db.payments.count({ status: { $ne: 'paid' } })
      ]);

      const agora = Date.now();
      const emDia = users.filter(u => {
        if (u.plano === 'pro' && u.dataExpiracao && new Date(u.dataExpiracao).getTime() > agora) return true;
        if (u.trialFim && new Date(u.trialFim).getTime() > agora) return true;
        return false;
      });

      res.json({
        usuarios: {
          total: users.length,
          ativos: emDia.length,
          pro: users.filter(u => u.plano === 'pro').length,
          trial: users.filter(u => (u.plano || 'trial') === 'trial').length,
          bloqueados: users.filter(u => u.bloqueado).length
        },
        campanhas: {
          total: campaigns.length,
          ativas: campaigns.filter(c => [queue.STATUS.PENDENTE, queue.STATUS.PROCESSANDO].includes(c.status)).length
        },
        publicacoes: {
          total: posts.length,
          concluidas: posts.filter(p => p.status === queue.STATUS.CONCLUIDO).length,
          falhas: posts.filter(p => p.status === queue.STATUS.FALHOU).length,
          interrompidas: posts.filter(p => p.status === queue.STATUS.INTERROMPIDO).length,
          pendentes: posts.filter(p => [queue.STATUS.PENDENTE, queue.STATUS.PROCESSANDO].includes(p.status)).length
        },
        contasFacebook: { total: accounts.length, conectadas: accounts.filter(a => a.conectada).length },
        pagamentos: { total: payments.length, pendentes },
        sistema: {
          filaEmExecucao: queue.emAndamento(),
          navegadoresAbertos: facebook.listarAbertos().length,
          limiteNavegadores: config.MAX_NAVEGADORES_CONCORRENTES,
          smtp: config.SMTP_ENABLED,
          pagamento: Boolean(config.INFINITEPAY_HANDLE)
        },
        memoriaMB: Math.round(process.memoryUsage().rss / 1048576),
        tempoAtivoSegundos: Math.round(process.uptime())
      });
    })
  );

  router.get(
    '/admin/users',
    auth.exigirLogin,
    auth.exigirAdmin,
    envolver(async (req, res) => {
      const { page, perPage, skip } = paginacao(req.query);
      const filtro = {};

      if (req.query.busca) {
        const termo = new RegExp(String(req.query.busca).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filtro.$or = [{ nome: termo }, { email: termo }];
      }
      if (req.query.plano) filtro.plano = String(req.query.plano);

      const [total, users] = await Promise.all([
        db.users.count(filtro),
        db.users.find(filtro).sort({ criadoEm: -1 }).skip(skip).limit(perPage)
      ]);

      const contagens = await Promise.all(
        users.map(async user => {
          const [campanhas, contas] = await Promise.all([
            db.campaigns.count({ userId: user._id }),
            db.accounts.count({ userId: user._id })
          ]);
          const estado = await auth.estadoDeAcesso(user);
          return { ...resumo(user, estado.status), campanhas, contas };
        })
      );

      res.json({ usuarios: contagens, page, perPage, total, totalPages: Math.ceil(total / perPage) });
    })
  );

  router.get(
    '/admin/payments',
    auth.exigirLogin,
    auth.exigirAdmin,
    envolver(async (req, res) => {
      const { page, perPage, skip } = paginacao(req.query);
      const filtro = {};
      if (req.query.status) filtro.status = String(req.query.status);

      const [total, lista] = await Promise.all([
        db.payments.count(filtro),
        db.payments.find(filtro).sort({ criadoEm: -1 }).skip(skip).limit(perPage)
      ]);

      res.json({
        pagamentos: lista.map(p => ({
          id: p._id,
          order_nsu: p.order_nsu,
          userId: p.userId,
          plano: p.plan,
          valor: p.amount,
          status: p.status,
          origem: p.origem || 'checkout',
          criadoEm: p.criadoEm,
          pagoEm: p.pagoEm || null
        })),
        page,
        perPage,
        total,
        totalPages: Math.ceil(total / perPage)
      });
    })
  );

  router.post(
    '/admin/users/:id/acesso',
    auth.exigirLogin,
    auth.exigirAdmin,
    envolver(async (req, res) => {
      const user = await db.users.findOne({ _id: req.params.id });
      if (!user) return naoEncontrado(res, 'Usuário não encontrado.');

      const dias = Math.max(1, Math.min(3650, Number(req.body.dias) || 30));
      const plano = config.PLANS[req.body.plano] ? String(req.body.plano) : 'monthly';
      const dataExpiracao = await billing.concessaoManual({
        user,
        dias,
        plano,
        motivo: String(req.body.motivo || 'Concessão manual pelo painel'),
        admin: req.user.email
      });

      res.json({ ok: true, dataExpiracao });
    })
  );

  router.post(
    '/admin/users/:id/bloqueio',
    auth.exigirLogin,
    auth.exigirAdmin,
    envolver(async (req, res) => {
      const user = await db.users.findOne({ _id: req.params.id });
      if (!user) return naoEncontrado(res, 'Usuário não encontrado.');

      const bloqueado = Boolean(req.body.bloqueado);
      if (user._id === req.user._id && bloqueado) {
        throw Object.assign(new Error('Você não pode bloquear a própria conta.'), { status: 400 });
      }

      await db.users.update({ _id: user._id }, { $set: { bloqueado } });
      if (bloqueado) {
        await db.sessions.remove({ userId: user._id }, { multi: true });
      }

      log.info('admin_bloqueio', { admin: req.user.email, userId: user._id, bloqueado });
      res.json({ ok: true, bloqueado });
    })
  );

  router.post(
    '/admin/users/:id/reiniciar-trial',
    auth.exigirLogin,
    auth.exigirAdmin,
    envolver(async (req, res) => {
      const user = await db.users.findOne({ _id: req.params.id });
      if (!user) return naoEncontrado(res, 'Usuário não encontrado.');

      const dias = Math.max(1, Math.min(90, Number(req.body.dias) || config.TRIAL_DAYS));
      const inicio = new Date();
      const fim = auth.addDays(inicio, dias);

      await db.users.update(
        { _id: user._id },
        { $set: { plano: 'trial', statusPagamento: 'trial', trialInicio: inicio, trialFim: fim } }
      );

      log.info('admin_trial_reiniciado', { admin: req.user.email, userId: user._id, dias });
      res.json({ ok: true, trialFim: fim });
    })
  );

  router.delete(
    '/admin/users/:id',
    auth.exigirLogin,
    auth.exigirAdmin,
    envolver(async (req, res) => {
      const user = await db.users.findOne({ _id: req.params.id });
      if (!user) return naoEncontrado(res, 'Usuário não encontrado.');
      if (user._id === req.user._id) {
        throw Object.assign(new Error('Você não pode excluir a própria conta pelo painel.'), { status: 400 });
      }

      const contas = await db.accounts.find({ userId: user._id });
      for (const conta of contas) {
        await facebook.fecharNavegadorFacebook(conta._id, user._id);
        fs.rmSync(facebook.profileDir(user._id, conta._id), { recursive: true, force: true });
      }

      await db.posts.remove({ userId: user._id }, { multi: true });
      await db.campaigns.remove({ userId: user._id }, { multi: true });
      await db.accounts.remove({ userId: user._id }, { multi: true });
      await db.payments.remove({ userId: user._id }, { multi: true });
      await db.sessions.remove({ userId: user._id }, { multi: true });
      await db.resets.remove({ userId: user._id }, { multi: true });
      await db.users.remove({ _id: user._id }, {});

      log.info('admin_usuario_excluido', { admin: req.user.email, userId: user._id, email: user.email });
      res.json({ ok: true });
    })
  );

  router.post(
    '/admin/backup',
    auth.exigirLogin,
    auth.exigirAdmin,
    envolver(async (req, res) => {
      const destino = await backup();
      res.json({ ok: true, destino });
    })
  );
}

module.exports = { registrar };
