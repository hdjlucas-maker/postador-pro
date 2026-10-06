import test from 'node:test';
import assert from 'node:assert/strict';
import { validarCampo } from '../extensao/lib/campanhas.js';

const limitesLite = { campanhasAtivas: 3, destinosPorCampanha: 5 };
const base = {
  nome: 'Campanha de revisão',
  textos: ['Oferta válida'],
  destinos: ['123456789'],
  agendadoPara: null
};

test('aceita IDs e links diretos de grupos do Facebook', () => {
  assert.equal(validarCampo({ ...base, destinos: ['123456789', 'https://www.facebook.com/groups/ofertas.rj/'] }, limitesLite).ok, true);
});

test('rejeita links que não apontam diretamente para um grupo', () => {
  const resultado = validarCampo({ ...base, destinos: ['https://example.com/groups/123'] }, limitesLite);
  assert.equal(resultado.ok, false);
  assert.match(resultado.erros.join(' '), /link direto de grupo/i);
});

test('rejeita grupos duplicados na mesma fila', () => {
  const resultado = validarCampo({ ...base, destinos: ['123456789', '123456789'] }, limitesLite);
  assert.equal(resultado.ok, false);
  assert.match(resultado.erros.join(' '), /mais de uma vez/i);
});

test('bloqueia campanhas acima do limite de destinos do plano', () => {
  const destinos = Array.from({ length: 6 }, (_, i) => String(100000000 + i));
  const resultado = validarCampo({ ...base, destinos }, limitesLite);
  assert.equal(resultado.ok, false);
  assert.match(resultado.erros.join(' '), /no máximo 5 destinos/i);
});

test('aceita Spintax com acentos, emoji e várias opções', () => {
  const resultado = validarCampo({ ...base, textos: ['{Promoção|Oferta} válida 🎉 em {São Paulo|Duque de Caxias}'] }, limitesLite);
  assert.equal(resultado.ok, true);
});

test('avisa sobre chaves Spintax incompletas ou opções vazias', () => {
  for (const texto of ['{Oferta|Promoção', '{|Promoção}', '{Oferta|}']) {
    const resultado = validarCampo({ ...base, textos: [texto] }, limitesLite);
    assert.equal(resultado.ok, false, `Esperava rejeitar: ${texto}`);
    assert.match(resultado.erros.join(' '), /Spintax|chaves/i);
  }
});

test('mantém texto fixo como conteúdo válido', () => {
  assert.equal(validarCampo({ ...base, textos: ['Mensagem fixa, sem variações.'] }, limitesLite).ok, true);
});
