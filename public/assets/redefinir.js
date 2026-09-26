'use strict';

const { chamar, mostrar, esconder, limitar } = window.Postador;

const formPedido = document.getElementById('form-pedido');
const formNova = document.getElementById('form-nova');
const avisoPedido = document.getElementById('aviso');
const avisoNova = document.getElementById('aviso-nova');
const botaoEnviar = document.getElementById('enviar');
const botaoSalvar = document.getElementById('salvar');

formPedido.addEventListener('submit', async evento => {
  evento.preventDefault();
  esconder(avisoPedido);
  botaoEnviar.disabled = true;
  botaoEnviar.textContent = 'Enviando…';

  try {
    const dados = await chamar('/api/recuperar-senha', { email: document.getElementById('email').value });
    mostrar(avisoPedido, dados.mensagem || 'Se este e-mail estiver cadastrado, o link foi enviado.', 'ok');

    // Fora de produção o servidor devolve o link para facilitar o teste. Com a
    // variável ligada, seguimos direto para a tela de criação de senha.
    if (dados.link) {
      const destino = new URL(dados.link, window.location.origin);
      document.getElementById('token').value = destino.searchParams.get('token') || '';
      formPedido.hidden = true;
      formNova.hidden = false;
      document.getElementById('token').focus();
    }
  } catch (erro) {
    mostrar(avisoPedido, erro.message);
  } finally {
    botaoEnviar.disabled = false;
    botaoEnviar.textContent = 'Enviar link';
  }
});

formNova.addEventListener('submit', async evento => {
  evento.preventDefault();
  esconder(avisoNova);

  const senha = document.getElementById('senha').value;
  const confirmar = document.getElementById('confirmar').value;

  if (senha !== confirmar) {
    mostrar(avisoNova, 'As duas senhas não são iguais.');
    return;
  }

  if (senha.length < 8) {
    mostrar(avisoNova, 'A senha precisa ter pelo menos 8 caracteres.');
    return;
  }

  botaoSalvar.disabled = true;
  botaoSalvar.textContent = 'Salvando…';

  try {
    await chamar('/api/redefinir-senha', {
      token: document.getElementById('token').value,
      senha
    });

    mostrar(avisoNova, 'Senha trocada. Já pode entrar na extensão com a nova senha.', 'ok');
    formNova.reset();
    setTimeout(() => window.location.assign('/'), 1500);
  } catch (erro) {
    mostrar(avisoNova, erro.message);
    botaoSalvar.disabled = false;
    botaoSalvar.textContent = 'Salvar nova senha';
  }
});

window.addEventListener('DOMContentLoaded', () => {
  limitar(document.getElementById('email'), 254);
  limitar(document.getElementById('token'), 200);

  // Chegando pelo link do e-mail, o código já vem na URL e a gente abre
  // direto a segunda tela.
  const token = new URLSearchParams(window.location.search).get('token');
  if (token) {
    document.getElementById('token').value = token;
    formPedido.hidden = true;
    formNova.hidden = false;
  }
});
