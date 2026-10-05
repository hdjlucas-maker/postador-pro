'use strict';

// Licença: consulta o servidor, guarda o estado e tem carência offline para
// não cobrar o cliente por falha nossa. Ao vencer, a extensão para de publicar.

import { CONFIG } from './config.js';
import * as armazenamento from './armazenamento.js';

async function baseApi() {
  const estado = await armazenamento.carregarEstado();
  return (estado.config && estado.config.apiBase) || CONFIG.API_BASE;
}

async function chamarApi(caminho, opcoes = {}) {
  const estado = await armazenamento.carregarEstado();
  const cabecalhos = { 'Content-Type': 'application/json' };
  if (estado.token) cabecalhos.Authorization = `Bearer ${estado.token}`;

  const resposta = await fetch(`${await baseApi()}${caminho}`, {
    method: opcoes.metodo || 'GET',
    headers: cabecalhos,
    body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined
  });

  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    const erro = new Error(dados.erro || 'Falha ao falar com o servidor.');
    erro.status = resposta.status;
    erro.codigo = dados.codigo;
    throw erro;
  }
  return dados;
}

function acessoPermitido(acesso) {
  return Boolean(acesso && acesso.permitido);
}

// Carência offline: se a última verificação foi há menos de CARENCIA_OFFLINE_MS
// e o acesso estava permitido, continua valendo mesmo sem conseguir falar com o
// servidor agora.
function temCarencia(estado) {
  if (!estado.acesso || !acessoPermitido(estado.acesso)) return false;
  if (!estado.ultimaVerificacao) return false;
  return Date.now() - estado.ultimaVerificacao < CONFIG.CARENCIA_OFFLINE_MS;
}

async function verificarLicenca(forcar = false) {
  const estado = await armazenamento.carregarEstado();

  // Sem token, não há o que verificar.
  if (!estado.token) {
    return { permitido: false, status: 'nao_autenticado', motivo: 'sem_token' };
  }

  const agora = Date.now();
  const passou = agora - (estado.ultimaVerificacao || 0) > CONFIG.VERIFICAR_LICENCA_MINUTOS * 60000;

  if (!forcar && !passou && estado.acesso) {
    return { acesso: estado.acesso, permitido: acessoPermitido(estado.acesso), status: estado.acesso.status };
  }

  try {
    const dados = await chamarApi('/api/extensao/licenca');
    estado.acesso = dados.acesso;
    estado.licenca = dados.licenca;
    estado.ultimaVerificacao = Date.now();
    await armazenamento.salvarEstado(estado);
    return { acesso: dados.acesso, permitido: acessoPermitido(dados.acesso), status: dados.acesso.status, licenca: dados.licenca };
  } catch (erro) {
    // Sem rede ou servidor fora: vale a carência se o acesso era válido.
    if (permaneceCarencia(estado)) {
      return { acesso: estado.acesso, permitido: true, status: estado.acesso.status, carencia: true };
    }
    throw erro;
  }
}

function permaneceCarencia(estado) {
  if (!estado.acesso || !acessoPermitido(estado.acesso)) return false;
  if (!estado.ultimaVerificacao) return false;
  return Date.now() - estado.ultimaVerificacao < CONFIG.CARENCIA_OFFLINE_MS;
}

async function login(email, senha) {
  const dados = await chamarApi('/api/extensao/login', {
    metodo: 'POST',
    corpo: { email, senha }
  });
  const estado = await armazenamento.carregarEstado();
  estado.token = dados.token;
  estado.acesso = dados.acesso;
  estado.licenca = dados.licenca;
  estado.ultimaVerificacao = Date.now();
  await armazenamento.salvarEstado(estado);
  return dados;
}

async function cadastro(dados) {
  const resposta = await chamarApi('/api/extensao/cadastro', {
    metodo: 'POST',
    corpo: dados
  });
  const estado = await armazenamento.carregarEstado();
  estado.token = resposta.token;
  estado.acesso = resposta.acesso;
  estado.licenca = resposta.licenca;
  estado.ultimaVerificacao = Date.now();
  await armazenamento.salvarEstado(estado);
  return resposta;
}

async function sair() {
  const estado = await armazenamento.carregarEstado();
  if (estado.token) {
    try {
      await chamarApi('/api/extensao/sair', { metodo: 'POST' });
    } catch (_) {
      // Mesmo sem rede, o token local é apagado.
    }
  }
  estado.token = null;
  estado.acesso = null;
  estado.licenca = null;
  estado.ultimaVerificacao = 0;
  await armazenamento.salvarEstado(estado);
}

async function criarCheckout(plano) {
  const dados = await chamarApi('/api/extensao/checkout', {
    metodo: 'POST',
    corpo: { plano }
  });
  return dados.url;
}

async function reconciliar() {
  const dados = await chamarApi('/api/extensao/reconciliar', { metodo: 'POST' });
  const estado = await armazenamento.carregarEstado();
  estado.acesso = dados.acesso;
  estado.licenca = dados.licenca;
  estado.ultimaVerificacao = Date.now();
  await armazenamento.salvarEstado(estado);
  return dados;
}

async function carregarPlanos() {
  return chamarApi('/api/extensao/planos');
}

export {
  chamarApi,
  verificarLicenca,
  login,
  cadastro,
  sair,
  criarCheckout,
  reconciliar,
  carregarPlanos,
  acessoPermitido,
  permaneceCarencia
};
