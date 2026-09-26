'use strict';

// Ajudantes das rotas.
//
// A versão do servidor ainda tinha `normalizarDestinos`, `listaTextos` e
// `parseData`, que existiam para validar campanhas e agendar publicações. Como
// nada disso é gravado no servidor anymore — a extensão cuida no navegador —,
// essas funções foram removidas em vez de portadas.

const MAX_TEXT_LENGTH = 5000;

function erroDeValidacao(mensagem) {
  return Object.assign(new Error(mensagem), { status: 400 });
}

function naoEncontrado(mensagem) {
  return Object.assign(new Error(mensagem || 'Recurso não encontrado.'), { status: 404 });
}

function texto(valor, campo, { obrigatorio = true, min = 1, max = MAX_TEXT_LENGTH } = {}) {
  const limpo = String(valor ?? '').trim();
  if (!limpo) {
    if (obrigatorio) throw erroDeValidacao(`Informe ${campo}.`);
    return '';
  }
  if (limpo.length < min) throw erroDeValidacao(`${campo} precisa ter pelo menos ${min} caracteres.`);
  if (limpo.length > max) throw erroDeValidacao(`${campo} deve ter no máximo ${max} caracteres.`);
  return limpo;
}

function paginacao(query) {
  const page = Math.max(1, Number.parseInt(query?.page, 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query?.perPage, 10) || 25));
  return { page, perPage, skip: (page - 1) * perPage };
}

module.exports = { erroDeValidacao, naoEncontrado, texto, paginacao };
