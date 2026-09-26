'use strict';

const crypto = require('crypto');
const config = require('./../config');
const { db } = require('./../db');
const auth = require('./../auth');
const security = require('./../security');
const email = require('./../email');
const log = require('./../log');
const { envolver, texto } = require('./helpers');

function perfilPublico(user, estado) {
  return {
    id: user._id,
    nome: user.nome,
    email: user.email,
    plano: user.plano || 'trial',
    tipoPlano: user.tipoPlano || null,
    statusPagamento: estado.status,
    admin: auth.eAdmin(user),
    trialInicio: user.trialInicio || null,
    trialFim: user.trialFim || null,
    dataExpiracao: user.dataExpiracao || null,
    limites: auth.limitesDoPlano(user),
    criadoEm: user.criadoEm || null
  };
}

function registrar(router) {
  router.get(
    '/config',
    envolver(async (req, res) => {
      security.assegurarCsrf(req, res);

      res.json({
        planos: Object.values(config.PLANS).map(plano => ({
          id: plano.id,
          nome: plano.name,
          preco: plano.price,
          dias: plano.days
        })),
        trialDias: config.TRIAL_DAYS,
        limites: config.PLAN_LIMITS,
        // Indica que o checkout está disponível, ou seja, que a InfinitePay
        // está configurada. NÃO é o status de pagamento deste usuário: o
        // acesso de cada um vem da sessão.
        pago: Boolean(config.INFINITEPAY_HANDLE)
      });
    })
  );

  router.post(
    '/register',
    security.criarRateLimit({ nome: 'registro', max: config.RATE_LIMITS.registro, janelaMs: 60 * 60 * 1000 }),
    envolver(async (req, res) => {
      const user = await auth.registrar(req.body || {});
      const token = await auth.criarSessao(user._id);
      auth.aplicarSessao(res, token);

      const estado = await auth.estadoDeAcesso(user);
      res.status(201).json(perfilPublico(user, estado));
    })
  );

  router.post(
    '/login',
    security.criarRateLimit({ nome: 'login', max: config.RATE_LIMITS.login, janelaMs: 15 * 60 * 1000 }),
    envolver(async (req, res) => {
      const user = await auth.autenticar(req.body || {});
      const token = await auth.criarSessao(user._id);
      auth.aplicarSessao(res, token);

      const estado = await auth.estadoDeAcesso(user);
      log.info('login', { userId: user._id, ip: req.ip });
      res.json(perfilPublico(user, estado));
    })
  );

  router.post(
    '/logout',
    envolver(async (req, res) => {
      const token = req.cookies?.[config.SESSION_COOKIE];
      if (token) {
        await db.sessions.remove({ tokenHash: security.hashToken(token) }, { multi: true });
      }
      auth.encerrarSessao(res);
      res.json({ ok: true });
    })
  );

  router.get(
    '/me',
    envolver(async (req, res) => {
      const user = await auth.usuarioAtual(req);
      if (!user) {
        return res.status(401).json({ erro: 'Não autenticado.', codigo: 'nao_autenticado' });
      }
      const estado = await auth.estadoDeAcesso(user);
      res.json(perfilPublico(user, estado));
    })
  );

  router.patch(
    '/me',
    auth.exigirLogin,
    envolver(async (req, res) => {
      const nome = texto(req.body.nome, 'seu nome', { min: 2, max: 80 });
      await db.users.update({ _id: req.user._id }, { $set: { nome } });
      const user = await db.users.findOne({ _id: req.user._id });
      const estado = await auth.estadoDeAcesso(user);
      res.json(perfilPublico(user, estado));
    })
  );

  router.post(
    '/me/senha',
    auth.exigirLogin,
    security.criarRateLimit({ nome: 'troca_senha', max: config.RATE_LIMITS.trocaSenha, janelaMs: 60 * 60 * 1000 }),
    envolver(async (req, res) => {
      await auth.trocarSenha(req.user, req.body.senhaAtual, req.body.novaSenha);
      res.json({ ok: true, mensagem: 'Senha alterada. Entre novamente com a nova senha.' });
    })
  );

  router.post(
    '/recuperar-senha',
    security.criarRateLimit({ nome: 'recuperar', max: config.RATE_LIMITS.recuperar, janelaMs: 60 * 60 * 1000 }),
    envolver(async (req, res) => {
      const emailRecebido = auth.normalizarEmail(req.body.email);
      const resposta = {
        ok: true,
        mensagem: 'Se o e-mail estiver cadastrado, você receberá o link de recuperação.'
      };

      if (!auth.emailValido(emailRecebido)) return res.json(resposta);

      const user = await db.users.findOne({ email: emailRecebido });
      if (!user || user.bloqueado) return res.json(resposta);

      const token = security.novoToken(24);
      await db.resets.insert({
        _id: crypto.randomUUID(),
        tokenHash: security.hashToken(token),
        userId: user._id,
        criadoEm: new Date(),
        expiraEm: new Date(Date.now() + config.RESET_TOKEN_MINUTES * 60000),
        usadoEm: null
      });

      const link = `${config.PUBLIC_BASE_URL}/redefinir?token=${token}`;
      const envio = await email.enviarRecuperacao({ email: user.email, link });

      if (!envio.enviado && envio.link && config.EXPOSIR_LINK_REDEFINICAO) {
        resposta.linkDev = envio.link;
        resposta.aviso = 'SMTP não configurado: o link de redefinição foi registrado no log do servidor.';
      }

      res.json(resposta);
    })
  );

  router.post(
    '/redefinir-senha',
    security.criarRateLimit({ nome: 'redefinir', max: config.RATE_LIMITS.redefinir, janelaMs: 60 * 60 * 1000 }),
    envolver(async (req, res) => {
      const token = String(req.body.token || '');
      if (!token) throw Object.assign(new Error('Token inválido.'), { status: 400 });

      const registro = await db.resets.findOne({ tokenHash: security.hashToken(token) });
      if (!registro || registro.usadoEm || new Date(registro.expiraEm) <= new Date()) {
        throw Object.assign(new Error('Link expirado ou já utilizado. Solicite um novo.'), { status: 400 });
      }

      const novaSenha = String(req.body.novaSenha || '');
      if (!auth.forcaSenha(novaSenha)) {
        throw Object.assign(new Error('A senha precisa ter pelo menos 8 caracteres.'), { status: 400 });
      }

      const bcrypt = require('bcryptjs');
      await db.users.update(
        { _id: registro.userId },
        { $set: { senhaHash: await bcrypt.hash(novaSenha, 12), senhaAlteradaEm: new Date() } }
      );

      await db.resets.update({ _id: registro._id }, { $set: { usadoEm: new Date() } });
      await db.sessions.remove({ userId: registro.userId }, { multi: true });

      log.info('senha_redefinida', { userId: registro.userId });
      res.json({ ok: true, mensagem: 'Senha redefinida. Faça login com a nova senha.' });
    })
  );

  // LGPD: portability. O servidor só tem o que é da conta e do pagamento:
  // campanha, publicação e imagem vivem no navegador do cliente, e o cliente
  // as exporta de lá.
  router.get(
    '/me/dados',
    auth.exigirLogin,
    envolver(async (req, res) => {
      const userId = req.user._id;
      const pagamentos = await db.payments.find({ userId });

      res.setHeader('Content-Disposition', `attachment; filename="postador-dados-${userId}.json"`);
      res.json({
        geradoEm: new Date().toISOString(),
        observacao: 'Campanhas, publicações e imagens ficam somente no navegador do cliente e não são enviadas ao servidor.',
        conta: {
          id: req.user._id,
          nome: req.user.nome,
          email: req.user.email,
          criadoEm: req.user.criadoEm,
          trialInicio: req.user.trialInicio,
          trialFim: req.user.trialFim,
          plano: req.user.plano,
          dataExpiracao: req.user.dataExpiracao
        },
        pagamentos
      });
    })
  );

  // LGPD: eliminação
  router.post(
    '/me/excluir',
    auth.exigirLogin,
    security.criarRateLimit({ nome: 'excluir_conta', max: config.RATE_LIMITS.excluirConta, janelaMs: 60 * 60 * 1000 }),
    envolver(async (req, res) => {
      const senha = String(req.body.senha || '');
      const bcrypt = require('bcryptjs');
      const confere = await bcrypt.compare(senha, req.user.senhaHash);

      if (!confere) {
        throw Object.assign(new Error('Senha incorreta.'), { status: 400 });
      }

      const userId = req.user._id;

      await db.payments.remove({ userId }, { multi: true });
      await db.sessions.remove({ userId }, { multi: true });
      await db.resets.remove({ userId }, { multi: true });
      await db.users.remove({ _id: userId }, {});

      auth.encerrarSessao(res);
      log.info('conta_excluida', { userId });
      res.json({
        ok: true,
        mensagem: 'Conta e dados do servidor excluídos. Os dados que estavam no navegador precisam ser apagados pela extensão.'
      });
    })
  );
}

module.exports = { registrar };
