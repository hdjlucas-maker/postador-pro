'use strict';

const config = require('./../config');

function envolver(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function naoEncontrado(res, mensagem) {
  return res.status(404).json({ erro: mensagem || 'Recurso não encontrado.' });
}

function naoAutorizado(res, mensagem) {
  return res.status(403).json({ erro: mensagem || 'Operação não permitida.', codigo: 'sem_permissao' });
}

function semAcesso(res) {
  return res.status(402).json({ erro: 'Seu acesso expirou. Escolha um plano para continuar.', codigo: 'acesso_expirado' });
}

function limiteExcedido(res, mensagem) {
  return res.status(403).json({ erro: mensagem, codigo: 'limite_do_plano' });
}

function erroDeValidacao(mensagem) {
  return Object.assign(new Error(mensagem), { status: 400 });
}

function texto(valor, campo, { obrigatorio = true, min = 1, max = config.MAX_TEXT_LENGTH } = {}) {
  const limpo = String(valor ?? '').trim();
  if (!limpo) {
    if (obrigatorio) throw erroDeValidacao(`Informe ${campo}.`);
    return '';
  }
  if (limpo.length < min) throw erroDeValidacao(`${campo} precisa ter pelo menos ${min} caracteres.`);
  if (limpo.length > max) throw erroDeValidacao(`${campo} deve ter no máximo ${max} caracteres.`);
  return limpo;
}

function listaTextos(valores) {
  if (!Array.isArray(valores)) return [];
  return valores
    .map(valor => String(valor ?? '').trim())
    .filter(Boolean)
    .slice(0, config.MAX_TEXTOS)
    .map(item => {
      if (item.length > config.MAX_TEXT_LENGTH) {
        throw erroDeValidacao(`Cada texto deve ter no máximo ${config.MAX_TEXT_LENGTH} caracteres.`);
      }
      return item;
    });
}

// Só grupos/páginas do Facebook. Qualquer outra URL é rejeitada no servidor.
function normalizarDestinos(valores) {
  const vistos = new Set();
  const destinos = [];
  const invalidos = [];

  for (const bruto of Array.isArray(valores) ? valores : []) {
    const url = String(bruto || '').trim();
    if (!url) continue;

    if (!/^https?:\/\//i.test(url)) {
      invalidos.push(url);
      continue;
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      invalidos.push(url);
      continue;
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      invalidos.push(url);
      continue;
    }

    if (!/(^|\.)facebook\.com$/i.test(parsed.hostname)) {
      invalidos.push(url);
      continue;
    }

    const chave = parsed.hostname.toLowerCase() + url.replace(/\/+$/, '');
    if (vistos.has(chave)) continue;

    vistos.add(chave);
    destinos.push(url);
  }

  return { destinos, invalidos };
}

function mensagemDestinosInvalidos(invalidos) {
  const lista = invalidos.slice(0, 3).join(', ');
  const resto = invalidos.length > 3 ? ` (e mais ${invalidos.length - 3})` : '';
  return `URL(s) de destino inválida(s): ${lista}${resto}. Use links https://facebook.com de grupos.`;
}

// O cliente envia ISO 8601 com offset (ex.: 2026-09-25T14:30:00-03:00), o que
// evita o erro clássico de agendar 3 horas fora do horário do usuário.
function parseData(valor) {
  if (!valor) throw erroDeValidacao('Informe a data e a hora da publicação.');

  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) {
    throw erroDeValidacao('Data e hora inválidas.');
  }

  const limiteMinimo = Date.now() + config.MIN_LEAD_MINUTES * 60000;
  const limiteMaximo = Date.now() + config.MAX_DIAS_AGENDAMENTO * 86400000;

  if (data.getTime() < limiteMinimo) {
    throw erroDeValidacao(
      `Agende pelo menos ${config.MIN_LEAD_MINUTES} minutos à frente (horário do seu navegador).`
    );
  }

  if (data.getTime() > limiteMaximo) {
    throw erroDeValidacao(`A data deve ser em até ${config.MAX_DIAS_AGENDAMENTO} dias.`);
  }

  return data;
}

function paginacao(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.perPage, 10) || 25));
  return { page, perPage, skip: (page - 1) * perPage };
}

module.exports = {
  envolver,
  naoEncontrado,
  naoAutorizado,
  semAcesso,
  limiteExcedido,
  erroDeValidacao,
  texto,
  listaTextos,
  normalizarDestinos,
  mensagemDestinosInvalidos,
  parseData,
  paginacao
};
