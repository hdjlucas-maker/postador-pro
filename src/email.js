'use strict';

const config = require('./config');
const log = require('./log');

let transporter = null;

function obterTransporter() {
  if (!config.SMTP_ENABLED) return null;
  if (transporter) return transporter;

  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: config.SMTP.host,
      port: config.SMTP.port,
      secure: config.SMTP.secure,
      auth: { user: config.SMTP.user, pass: config.SMTP.pass }
    });
    return transporter;
  } catch (erro) {
    log.warn('smtp_indisponivel', { erro: erro.message });
    return null;
  }
}

function texto(assunto, corpo) {
  return { from: config.SMTP.from, subject: assunto, text: corpo };
}

async function enviarRecuperacao({ email, link }) {
  const envio = texto(
    'Recuperação de senha — Postador Pro',
    [
      'Recebemos um pedido para redefinir a senha da sua conta no Postador Pro.',
      '',
      `Link (válido por ${config.RESET_TOKEN_MINUTES} minutos):`,
      link,
      '',
      'Se não foi você, ignore esta mensagem. Sua senha atual continua valendo.'
    ].join('\n')
  );

  const smtp = obterTransporter();
  if (!smtp) {
    log.warn('email_recuperacao_sem_smtp', { email, link });
    return { enviado: false, link };
  }

  try {
    await smtp.sendMail({ ...envio, to: email });
    log.info('email_recuperacao_enviado', { email });
    return { enviado: true };
  } catch (erro) {
    log.error('email_recuperacao_falhou', { email, erro: erro.message });
    return { enviado: false, erro: erro.message };
  }
}

async function avisarPagamento({ email, nome, plano, expiraEm }) {
  const smtp = obterTransporter();
  if (!smtp) {
    log.info('email_pagamento_sem_smtp', { email, plano });
    return { enviado: false };
  }

  try {
    await smtp.sendMail({
      ...texto(
        'Pagamento confirmado — Postador Pro',
        [
          `Olá, ${nome}!`,
          '',
          `Seu plano ${plano} está ativo até ${new Date(expiraEm).toLocaleDateString('pt-BR')}.`,
          '',
          `Acesso: ${config.PUBLIC_BASE_URL}`
        ].join('\n')
      ),
      to: email
    });
    return { enviado: true };
  } catch (erro) {
    log.error('email_pagamento_falhou', { email, erro: erro.message });
    return { enviado: false };
  }
}

module.exports = { enviarRecuperacao, avisarPagamento, smtpDisponivel: () => Boolean(obterTransporter()) };
