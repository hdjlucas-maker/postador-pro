import test from 'node:test';
import assert from 'node:assert/strict';

import {
  prepararImagemParaEnvio,
  tipoMimePorCabecalho,
  ERRO_COPIA_SUMIU
} from '../extensao/lib/imagem.js';

// Regressão da campanha de 18/10/2026: a cópia da imagem guardada no navegador
// sumiu no meio da fila e os 11 destinos restantes falharam um atrás do outro.
// O preparo agora sinaliza `interromperFila` (a fila pausa em vez de queimar o
// resto da campanha) e a mensagem explica que o arquivo original do computador
// não foi apagado.

function bytesPng(extra = 16) {
  const cabecalho = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const bytes = new Uint8Array(cabecalho.length + extra);
  bytes.set(cabecalho, 0);
  for (let i = cabecalho.length; i < bytes.length; i += 1) bytes[i] = i % 256;
  return bytes;
}

test('imagem válida vira base64 com os mesmos bytes e o tipo preservado', () => {
  const bytes = bytesPng();
  const preparo = prepararImagemParaEnvio({ bytes: bytes.buffer, tipo: 'image/png', nome: 'foto.png' });

  assert.equal(preparo.ok, true);
  assert.equal(preparo.tipo, 'image/png');
  assert.equal(preparo.nome, 'foto.png');
  assert.deepEqual([...Buffer.from(preparo.base64, 'base64')], [...bytes]);
});

test('cópia sumida pausa a fila e avisa que o arquivo do computador não foi apagado', () => {
  for (const dados of [null, {}, { bytes: new ArrayBuffer(0) }, { bytes: new Uint8Array(0) }]) {
    const preparo = prepararImagemParaEnvio(dados);
    assert.equal(preparo.ok, false);
    assert.equal(preparo.pausar, true);
    assert.equal(preparo.interromperFila, true);
    assert.equal(preparo.erro, ERRO_COPIA_SUMIU);
    assert.match(preparo.erro, /arquivo original no seu computador não foi apagado/);
  }
});

test('formato de imagem não aceito também pausa a fila', () => {
  const preparo = prepararImagemParaEnvio({ bytes: bytesPng().buffer, tipo: 'image/tiff' });
  assert.equal(preparo.ok, false);
  assert.equal(preparo.interromperFila, true);
  assert.match(preparo.erro, /Formato de imagem não aceito/);
});

test('bytes que não batem com o tipo declarado são recusados antes do envio', () => {
  const preparo = prepararImagemParaEnvio({ bytes: bytesPng().buffer, tipo: 'image/jpeg' });
  assert.equal(preparo.ok, false);
  assert.equal(preparo.interromperFila, true);
  assert.match(preparo.erro, /não parece ser uma imagem image\/jpeg válida/);
});

test('reconhece os cabeçalhos de JPEG, PNG, WebP e GIF', () => {
  assert.equal(tipoMimePorCabecalho(new Uint8Array([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
  assert.equal(tipoMimePorCabecalho(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 'image/png');
  assert.equal(tipoMimePorCabecalho(new Uint8Array([0x52, 0x49, 0x46, 0x46])), 'image/webp');
  assert.equal(tipoMimePorCabecalho(new Uint8Array([0x47, 0x49, 0x46, 0x38])), 'image/gif');
  assert.equal(tipoMimePorCabecalho(new Uint8Array([1, 2, 3, 4])), null);
});
