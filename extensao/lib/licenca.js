'use strict';

// Licença: o servidor é a fonte da verdade. A publicação exige uma consulta
// atual ao servidor e falha fechada sem conexão; a carência offline serve só
// para exibir o estado no popup, nunca para iniciar uma publicação.

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

function validadeLocal(estado) {
  const licenca = estado.licenca || {};
  const data = licenca.plano === 'pro' ? licenca.expiraEm : licenca.avaliacaoAte;
  const instante = Date.parse(data || '');
  return Number.isFinite(instante) && instante > Date.now();
}

// O relógio do computador pode ser atrasado de propósito para "esticar" a
// avaliação: a última verificação aparece no futuro. Sem relógio confiável, o
// cache e a carência offline deixam de valer — só a resposta do servidor agora.
function relogioVoltou(estado) {
  return Boolean(estado.ultimaVerificacao) && Date.now() < Number(estado.ultimaVerificacao);
}

async function verificarLicenca(forcar = false, exigirServidor = false) {
  const estado = await armazenamento.carregarEstado();

  // Sem token, não há o que verificar.
  if (!estado.token) {
    return { permitido: false, status: 'nao_autenticado', motivo: 'sem_token' };
  }

  const agora = Date.now();
  const passou = agora - (estado.ultimaVerificacao || 0) > CONFIG.VERIFICAR_LICENCA_MINUTOS * 60000;
  const relogioSuspeito = relogioVoltou(estado);

  if (!forcar && !passou && !relogioSuspeito && estado.acesso && validadeLocal(estado)) {
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
    // Respostas de autenticação/acesso negado são decisões do servidor, não
    // falhas de rede. Nunca as converte em permissão offline.
    if (erro.status === 401 || erro.status === 402) {
      const status = erro.codigo === 'acesso_expirado' ? 'expirado' : 'nao_autenticado';
      estado.acesso = { permitido: false, status };
      estado.ultimaVerificacao = Date.now();
      await armazenamento.salvarEstado(estado);
      return { acesso: estado.acesso, permitido: false, status };
    }
    // Sem rede ou servidor fora: vale a carência se o acesso era válido.
    if (!exigirServidor && permaneceCarencia(estado)) {
      return { acesso: estado.acesso, permitido: true, status: estado.acesso.status, carencia: true };
    }
    throw erro;
  }
}

// Carência offline: se a última verificação foi há menos de CARENCIA_OFFLINE_MS
// e o acesso estava permitido, continua valendo mesmo sem conseguir falar com o
// servidor agora. Com o relógio atrasado (verificação no futuro), não vale.
function permaneceCarencia(estado) {
  if (!estado.acesso || !acessoPermitido(estado.acesso)) return false;
  if (!validadeLocal(estado)) return false;
  if (!estado.ultimaVerificacao) return false;
  if (relogioVoltou(estado)) return false;
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

// Limite diário do servidor: consulta se o usuário ainda pode publicar hoje e
// registra a publicação após confirmação. O servidor é a fonte da verdade — a
// extensão não se autolimita sozinha.

async function verificarPublicacaoHoje() {
  const dados = await chamarApi('/api/extensao/publicacao/hoje');
  return {
    pode: Boolean(dados?.pode),
    limite: Number(dados?.limite) || 0,
    contador: Number(dados?.contador) || 0,
    restante: Number(dados?.restante) || 0
  };
}

async function registrarPublicacaoHoje() {
  const dados = await chamarApi('/api/extensao/publicacao', { metodo: 'POST' });
  return {
    ok: Boolean(dados?.ok),
    limite: Number(dados?.limite) || 0,
    contador: Number(dados?.contador) || 0,
    restante: Number(dados?.restante) || 0,
    erro: dados?.erro || null
  };
}

async function gerarTextos(dados) {
  return chamarApi('/api/extensao/gerar-textos', { metodo: 'POST', corpo: dados });
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
  gerarTextos,
  acessoPermitido,
  permaneceCarencia,
  verificarPublicacaoHoje,
  registrarPublicacaoHoje
};
