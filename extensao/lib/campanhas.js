'use strict';

import * as armazenamento from './armazenamento.js';
import { CONFIG, aleatorio } from './config.js';

function validarCampanha(campanha, limites) {
  const erros = [];
  if (!campanha.nome?.trim()) erros.push('Dê um nome à campanha.');
  else if (String(campanha.nome).length > CONFIG.MAX_CAMPANHA_NOME) erros.push(`O nome pode ter no máximo ${CONFIG.MAX_CAMPANHA_NOME} caracteres.`);
  const textos = (campanha.textos || []).filter(t => String(t).trim());
  if (!textos.length) erros.push('Escreva pelo menos um texto.');
  else if (textos.some(t => String(t).length > CONFIG.MAX_TEXT_LENGTH)) erros.push(`Cada texto pode ter no máximo ${CONFIG.MAX_TEXT_LENGTH} caracteres.`);
  const destinos = (campanha.destinos || []).filter(d => String(d).trim());
  if (!destinos.length) erros.push('Adicione pelo menos um grupo de destino.');
  else if (limites && destinos.length > limites.destinosPorCampanha) erros.push(`Seu plano permite no máximo ${limites.destinosPorCampanha} destinos por campanha.`);
  if (campanha.agendadoPara) {
    const quando = new Date(campanha.agendadoPara);
    if (Number.isNaN(quando.getTime())) erros.push('Data de agendamento inválida.');
  }
  return { ok: !erros.length, erros };
}

async function criarCampanha(dados, limites) {
  const validacao = validarCampanha(dados, limites);
  if (!validacao.ok) { const erro = new Error(validacao.erros.join(' ')); erro.validacao = validacao.erros; throw erro; }
  const estado = await armazenamento.carregarEstado();
  const ativas = estado.campanhas.filter(c => c.status === 'ativa' || c.status === 'pausada').length;
  if (limites && ativas >= limites.campanhasAtivas) throw new Error(`Seu plano permite no máximo ${limites.campanhasAtivas} campanhas ativas.`);

  const destinos = (dados.destinos || []).filter(d => String(d).trim());
  const agendado = dados.agendadoPara || null;
  const campanha = {
    id: `c_${Date.now()}_${aleatorio(1000, 9999)}`,
    nome: String(dados.nome).trim(), textos: (dados.textos || []).filter(t => String(t).trim()),
    destinos, imagemId: dados.imagemId || null, agendadoPara: agendado,
    criadoEm: Date.now(), status: 'preparacao', publicado: 0, falhou: 0, naoConfirmado: 0,
    pulado: 0, atual: null, proximaPublicacaoEm: agendado ? new Date(agendado).getTime() : null,
    fila: destinos.map(destino => ({ destino, status: 'pendente', erro: null, iniciadoEm: null, finalizadoEm: null, confirmadoEm: null }))
  };
  estado.campanhas.push(campanha);
  await armazenamento.salvarEstado(estado);
  return campanha;
}

async function listarCampanhas() { return (await armazenamento.carregarEstado()).campanhas; }
async function obterCampanha(id) { return (await armazenamento.carregarEstado()).campanhas.find(c => c.id === id) || null; }
async function atualizarCampanha(id, mudancas) {
  const estado = await armazenamento.carregarEstado(); const idx = estado.campanhas.findIndex(c => c.id === id); if (idx < 0) return null;
  estado.campanhas[idx] = { ...estado.campanhas[idx], ...mudancas }; await armazenamento.salvarEstado(estado); return estado.campanhas[idx];
}
async function excluirCampanha(id) {
  const estado = await armazenamento.carregarEstado(); const campanha = estado.campanhas.find(c => c.id === id);
  if (campanha?.imagemId) await armazenamento.apagarImagem(campanha.imagemId).catch(() => {});
  estado.campanhas = estado.campanhas.filter(c => c.id !== id); await armazenamento.salvarEstado(estado);
}
async function registrarResultado(campanhaId, destino, resultado, erro = null) {
  const estado = await armazenamento.carregarEstado(); const campanha = estado.campanhas.find(c => c.id === campanhaId); if (!campanha) return;
  estado.historico.push({ campanhaId, campanhaNome: campanha.nome, destino, resultado, erro, quando: Date.now() });
  if (estado.historico.length > 500) estado.historico = estado.historico.slice(-500);
  await armazenamento.salvarEstado(estado);
}

export { validarCampanha, validarCampo: validarCampanha, criarCampanha, listarCampanhas, obterCampanha, atualizarCampanha, excluirCampanha, registrarResultado };
