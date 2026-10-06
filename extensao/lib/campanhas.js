'use strict';

// Campanhas: criação, validação, fila e histórico. Tudo vive no navegador do
// cliente, nunca no servidor.

import * as armazenamento from './armazenamento.js';
import { CONFIG, aleatorio } from './config.js';

function validarCampanha(campanha, limites) {
  const erros = [];

  if (!campanha.nome || !String(campanha.nome).trim()) {
    erros.push('Dê um nome à campanha.');
  } else if (String(campanha.nome).length > CONFIG.MAX_CAMPANHA_NOME) {
    erros.push(`O nome pode ter no máximo ${CONFIG.MAX_CAMPANHA_NOME} caracteres.`);
  }

  const textos = (campanha.textos || []).filter(t => String(t).trim());
  if (!textos.length) {
    erros.push('Escreva pelo menos um texto.');
  } else if (textos.length > CONFIG.MAX_TEXTOS) {
    erros.push(`No máximo ${CONFIG.MAX_TEXTOS} textos por campanha.`);
  }
  for (const t of textos) {
    if (String(t).length > CONFIG.MAX_TEXT_LENGTH) {
      erros.push(`Cada texto pode ter no máximo ${CONFIG.MAX_TEXT_LENGTH} caracteres.`);
      break;
    }
    let nivelChaves = 0;
    for (const caractere of String(t)) {
      if (caractere === '{') nivelChaves += 1;
      if (caractere === '}') nivelChaves -= 1;
      if (nivelChaves < 0) break;
    }
    if (nivelChaves !== 0) {
      erros.push('Há chaves Spintax sem par. Corrija os trechos entre { } ou remova as chaves.');
      break;
    }
    if (/\{[^{}]*\}/.test(String(t)) && /(?:\{\s*(?:\||\})|\|\s*\})/.test(String(t))) {
      erros.push('Cada bloco Spintax precisa ter opções de texto separadas por |.');
      break;
    }
  }

  const destinos = (campanha.destinos || []).filter(d => String(d).trim());
  if (!destinos.length) {
    erros.push('Adicione pelo menos um grupo de destino.');
  } else if (limites && destinos.length > limites.destinosPorCampanha) {
    erros.push(`Seu plano permite no máximo ${limites.destinosPorCampanha} destinos por campanha.`);
  }
  const vistos = new Set();
  for (const destino of destinos) {
    const valor = String(destino).trim();
    let chave = valor.toLowerCase();
    if (/^https?:\/\//i.test(valor)) {
      try {
        const url = new URL(valor);
        if (url.protocol !== 'https:' || !['www.facebook.com', 'facebook.com', 'web.facebook.com', 'm.facebook.com'].includes(url.hostname.toLowerCase()) || !/^\/groups\/[^/]+\/?$/.test(url.pathname)) {
          erros.push(`Destino inválido: “${valor}” não é um link direto de grupo do Facebook.`);
          continue;
        }
        chave = url.pathname.replace(/\/$/, '').toLowerCase();
      } catch (_) {
        erros.push(`Link de grupo inválido: “${valor}”.`);
        continue;
      }
    } else if (!/^[\p{L}\p{N}._-]+$/u.test(valor)) {
      erros.push(`Destino inválido: use o link do grupo ou seu ID/identificador, sem espaços.`);
      continue;
    }
    if (vistos.has(chave)) erros.push(`O grupo “${valor}” aparece mais de uma vez na fila.`);
    vistos.add(chave);
  }

  if (campanha.agendadoPara) {
    const quando = new Date(campanha.agendadoPara);
    if (Number.isNaN(quando.getTime())) {
      erros.push('Data de agendamento inválida.');
    } else {
      const agora = Date.now();
      const minLead = CONFIG.MIN_LEAD_MINUTES * 60000;
      const maxFuturo = CONFIG.MAX_DIAS_AGENDAMENTO * 86400000;
      if (quando.getTime() < agora + minLead) {
        erros.push(`Agende para pelo menos ${CONFIG.MIN_LEAD_MINUTES} minutos à frente.`);
      } else if (quando.getTime() > agora + maxFuturo) {
        erros.push(`O agendamento pode ser de no máximo ${CONFIG.MAX_DIAS_AGENDAMENTO} dias.`);
      }
    }
  }

  return { ok: erros.length === 0, erros };
}

async function criarCampanha(dados, limites) {
  const validacao = validarCampanha(dados, limites);
  if (!validacao.ok) {
    const erro = new Error(validacao.erros.join(' '));
    erro.validacao = validacao.erros;
    throw erro;
  }

  const estado = await armazenamento.carregarEstado();
  const ativas = estado.campanhas.filter(c => c.status === 'ativa').length;
  if (limites && ativas >= limites.campanhasAtivas) {
    throw new Error(`Seu plano permite no máximo ${limites.campanhasAtivas} campanhas ativas.`);
  }

  const campanha = {
    id: `c_${Date.now()}_${aleatorio(1000, 9999)}`,
    nome: String(dados.nome).trim(),
    textos: (dados.textos || []).filter(t => String(t).trim()),
    destinos: (dados.destinos || []).filter(d => String(d).trim()),
    destinosOriginais: (dados.destinos || []).filter(d => String(d).trim()),
    imagemId: dados.imagemId || null,
    agendadoPara: dados.agendadoPara || null,
    criadoEm: Date.now(),
    status: 'ativa',
    publicado: 0,
    falhou: 0,
    pulado: 0
  };

  estado.campanhas.push(campanha);
  await armazenamento.salvarEstado(estado);
  return campanha;
}

async function listarCampanhas() {
  const estado = await armazenamento.carregarEstado();
  return estado.campanhas;
}

async function obterCampanha(id) {
  const estado = await armazenamento.carregarEstado();
  return estado.campanhas.find(c => c.id === id) || null;
}

async function atualizarCampanha(id, mudancas) {
  const estado = await armazenamento.carregarEstado();
  const idx = estado.campanhas.findIndex(c => c.id === id);
  if (idx === -1) return null;
  estado.campanhas[idx] = { ...estado.campanhas[idx], ...mudancas };
  await armazenamento.salvarEstado(estado);
  return estado.campanhas[idx];
}

async function excluirCampanha(id) {
  const estado = await armazenamento.carregarEstado();
  const campanha = estado.campanhas.find(c => c.id === id);
  if (campanha && campanha.imagemId) {
    const usadaEmOutra = estado.campanhas.some(c => c.id !== id && c.imagemId === campanha.imagemId);
    if (!usadaEmOutra) await armazenamento.apagarImagem(campanha.imagemId).catch(() => {});
  }
  estado.campanhas = estado.campanhas.filter(c => c.id !== id);
  await armazenamento.salvarEstado(estado);
}

async function registrarResultado(campanhaId, destino, resultado, erroDetalhado = '', textoUsado = '') {
  const estado = await armazenamento.carregarEstado();
  const campanha = estado.campanhas.find(c => c.id === campanhaId);
  if (!campanha) return;

  if (resultado === 'publicado') campanha.publicado += 1;
  else if (resultado === 'falhou') campanha.falhou += 1;
  else if (resultado === 'pulou') campanha.pulado += 1;

  estado.historico.push({
    campanhaId,
    campanhaNome: campanha.nome,
    destino,
    resultado,
    erro: erroDetalhado || '',
    texto: textoUsado || '',
    quando: Date.now()
  });

  // Mantém o histórico limitado.
  if (estado.historico.length > 500) {
    estado.historico = estado.historico.slice(-500);
  }

  await armazenamento.salvarEstado(estado);
}

function agora() {
  return new Date().toISOString();
}

export {
  validarCampanha as validarCampo,
  criarCampanha,
  listarCampanhas,
  obterCampanha,
  atualizarCampanha,
  excluirCampanha,
  registrarResultado
};
