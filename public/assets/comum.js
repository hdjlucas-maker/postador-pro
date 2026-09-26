'use strict';

// Utilidades compartilhadas pelas páginas do servidor. O token de CSRF é
// double-submit: o cookie `postador_csrf` é legível por JavaScript (ao
// contrário do cookie de sessão) e precisa voltar no cabeçalho.

function lerCookie(nome) {
  const alvo = `${nome}=`;
  const item = document.cookie.split('; ').find(p => p.startsWith(alvo));
  return item ? decodeURIComponent(item.slice(alvo.length)) : '';
}

async function chamar(rota, corpo, metodo = 'POST') {
  const cabecalhos = { 'x-csrf-token': lerCookie('postador_csrf') };

  if (corpo !== undefined) cabecalhos['Content-Type'] = 'application/json';

  const resposta = await fetch(rota, {
    method: metodo,
    headers: cabecalhos,
    credentials: 'same-origin',
    body: corpo === undefined ? undefined : JSON.stringify(corpo)
  });

  const texto = await resposta.text();
  let dados = {};

  try {
    dados = texto ? JSON.parse(texto) : {};
  } catch {
    dados = { erro: 'Resposta inesperada do servidor.' };
  }

  if (!resposta.ok) {
    throw Object.assign(new Error(dados.erro || `Falha na requisição (${resposta.status}).`), {
      status: resposta.status,
      codigo: dados.codigo
    });
  }

  return dados;
}

function mostrar(elemento, texto, tipo = 'erro') {
  if (!elemento) return;
  elemento.textContent = texto;
  elemento.className = `mensagem ${tipo}`;
}

function esconder(elemento) {
  if (elemento) elemento.className = 'mensagem';
}

function moeda(centavos) {
  return (Number(centavos || 0) / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

function data(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
}

function dataHora(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR');
}

function limitar(campo, maximo) {
  if (!campo) return;
  campo.addEventListener('input', () => {
    if (campo.value.length > maximo) campo.value = campo.value.slice(0, maximo);
  });
}

window.Postador = { lerCookie, chamar, mostrar, esconder, moeda, data, dataHora, limitar };
