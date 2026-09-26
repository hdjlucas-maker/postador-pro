'use strict';

// E-mail transacional pela binding `EMAIL` do Cloudflare Email Service.
//
// ## O que mudou em relação ao servidor
//
// O servidor falava SMTP com `nodemailer`. Worker não abre socket de saída, e
// SMTP na porta 25/587 está bloqueado por definição: a Cloudflare corta
// conexões TCP arbitrárias. A binding resolve isso no mesmo plano, sem chave de
// API.
//
// ## A dependência de domínio
//
// A binding só existe depois de `npx wrangler email sending enable SEUDOMINIO`,
// e o remetente precisa ser desse domínio. Este é o único lugar do projeto que
// ainda pede um domínio.
//
// Consequência prática: o webhook da InfinitePay e a venda **não** dependem de
// domínio nenhum — `workers.dev` resolve. Dá para começar a vender sem ter
// comprado nada. O que fica pendente sem domínio é só o e-mail de recuperação
// de senha, que cai no modo de desenvolvimento: o link vai para o log em vez de
// sair por e-mail. Para uma base de clientes pequena isso é aceitável por um
// tempo, e o administrador pode redefinir a senha pelo painel.

const configMod = require('./config');
const log = require('./log');

function remetente(env, nome = 'Postador Pro') {
  const cfg = configMod.config(env);
  return { email: cfg.EMAIL_FROM, name: nome };
}

async function enviar(env, { para, assunto, texto, html }) {
  const cfg = configMod.config(env);

  if (!cfg.EMAIL_ENABLED) {
    log.warn('email_sem_binding', { para, assunto });
    return { enviado: false, motivo: 'email_nao_configurado' };
  }

  try {
    const resposta = await env.EMAIL.send({
      to: para,
      from: remetente(env),
      subject: assunto,
      // Sempre os dois corpos. Cliente que só mostra HTML perde a mensagem em
      // texto puro, e a entrega cai em pasta de spam.
      text: texto,
      html: html
    });
    return { enviado: true, messageId: resposta?.messageId };
  } catch (erro) {
    log.error('email_falhou', { para, assunto, erro: erro.message });
    return { enviado: false, motivo: erro.message };
  }
}

function paragrafos(linhas) {
  const escape = valor =>
    String(valor)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#1c1e21">${linhas
    .map(linha => (linha === '' ? '<br>' : `<p style="margin:0 0 12px">${escape(linha)}</p>`))
    .join('')}</div>`;
}

async function enviarRecuperacao(env, { email, link }) {
  const cfg = configMod.config(env);

  const texto = [
    'Recebemos um pedido para redefinir a senha da sua conta no Postador Pro.',
    '',
    `Link (válido por ${cfg.RESET_TOKEN_MINUTES} minutos):`,
    link,
    '',
    'Se não foi você, ignore esta mensagem. Sua senha atual continua valendo.'
  ].join('\n');

  const html = paragrafos([
    'Recebemos um pedido para redefinir a senha da sua conta no Postador Pro.',
    `Link (válido por ${cfg.RESET_TOKEN_MINUTES} minutos):`,
    link,
    'Se não foi você, ignore esta mensagem. Sua senha atual continua valendo.'
  ]);

  const resultado = await enviar(env, {
    para: email,
    assunto: 'Recuperação de senha — Postador Pro',
    texto,
    html
  });

  if (!resultado.enviado) {
    // Sem envio, o link volta para o chamador, que só o expõe quando
    // EXPOSIR_LINK_REDEFINICAO está ligado e fora de produção.
    log.warn('email_recuperacao_sem_envio', { email, link, motivo: resultado.motivo });
    return { enviado: false, link };
  }

  log.info('email_recuperacao_enviado', { email });
  return { enviado: true };
}

async function avisarPagamento(env, { email, nome, plano, expiraEm }) {
  const data = new Date(expiraEm).toLocaleDateString('pt-BR');

  const texto = [
    `Olá, ${nome}!`,
    '',
    `Seu plano ${plano} está ativo até ${data}.`,
    '',
    configMod.config(env).PUBLIC_BASE_URL || 'Abra a extensão do Postador Pro para usar.'
  ].join('\n');

  const html = paragrafos([
    `Olá, ${nome}!`,
    `Seu plano ${plano} está ativo até ${data}.`,
    configMod.config(env).PUBLIC_BASE_URL || 'Abra a extensão do Postador Pro para usar.'
  ]);

  return enviar(env, {
    para: email,
    assunto: 'Pagamento confirmado — Postador Pro',
    texto,
    html
  });
}

module.exports = { enviar, enviarRecuperacao, avisarPagamento };
