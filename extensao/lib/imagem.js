'use strict';

// Preparo da imagem antes de enviar para a página do Facebook.
//
// A imagem fica guardada no IndexedDB como bytes (ArrayBuffer) e aqui é
// validada e convertida para base64. O canal de mensagens do Chrome entre o
// service worker e a página só transporta JSON: Blob/ArrayBuffer chegam vazios
// do outro lado. O base64 preserva os bytes até a página.
//
// Se a cópia guardada no navegador sumir (o Chrome pode liberar armazenamento
// sob pressão, ou uma limpeza de dados apaga), a fila precisa PARAR — não
// queimar todos os destinos restantes. Por isso os erros daqui voltam com
// `interromperFila: true`, o mesmo sinal usado quando o Facebook pede login.

const TIPOS_ACEITOS = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const ERRO_COPIA_SUMIU =
  'A cópia da imagem guardada pela extensão no navegador não foi encontrada ' +
  '(isso pode acontecer quando o navegador libera espaço ou os dados são limpos). ' +
  'O arquivo original no seu computador não foi apagado. Nenhuma publicação foi enviada. ' +
  'Use "Usar novamente" na campanha e selecione a imagem de novo para continuar.';

function bytesParaBase64(bytes) {
  let binario = '';
  const passo = 0x8000;
  for (let i = 0; i < bytes.length; i += passo) {
    binario += String.fromCharCode.apply(null, bytes.subarray(i, i + passo));
  }
  return btoa(binario);
}

// Verifica os "magic bytes" (cabeçalho do arquivo) para confirmar que o tipo
// MIME declarado confere com o conteúdo real. O Facebook rejeita arquivos cujo
// tipo não bate com os bytes iniciais.
function tipoMimePorCabecalho(bytes) {
  const b0 = bytes[0], b1 = bytes[1], b2 = bytes[2], b3 = bytes[3];
  if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return 'image/jpeg';
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return 'image/png';
  if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46) return 'image/webp';
  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) return 'image/gif';
  return null;
}

function validarImagemAntesEnviar(bytes, tipoDeclarado) {
  if (!TIPOS_ACEITOS.includes(tipoDeclarado)) {
    return {
      ok: false,
      erro: `Tipo de imagem não suportado (${tipoDeclarado || 'desconhecido'}). Use PNG, JPEG, WebP ou GIF.`
    };
  }
  const mimeReal = tipoMimePorCabecalho(bytes);
  if (mimeReal && mimeReal !== tipoDeclarado) {
    return {
      ok: false,
      erro: `O arquivo não parece ser uma imagem ${tipoDeclarado} válida. O Facebook pode rejeitá-lo.`
    };
  }
  return { ok: true };
}

function prepararImagemParaEnvio(dados) {
  if (!dados || !dados.bytes || !dados.bytes.byteLength) {
    return { ok: false, pausar: true, interromperFila: true, erro: ERRO_COPIA_SUMIU };
  }

  const bytes = dados.bytes instanceof Uint8Array ? dados.bytes : new Uint8Array(dados.bytes);
  const tipo = String(dados.tipo || '').toLowerCase();
  if (!TIPOS_ACEITOS.includes(tipo)) {
    return {
      ok: false,
      pausar: true,
      interromperFila: true,
      erro: `Formato de imagem não aceito (${tipo || 'desconhecido'}). Use PNG, JPEG, WebP ou GIF. Nenhuma publicação foi enviada.`
    };
  }

  const validacao = validarImagemAntesEnviar(bytes, tipo);
  if (!validacao.ok) {
    return { ok: false, pausar: true, interromperFila: true, erro: `${validacao.erro} Nenhuma publicação foi enviada.` };
  }

  return { ok: true, base64: bytesParaBase64(bytes), tipo, nome: String(dados.nome || '') };
}

export {
  prepararImagemParaEnvio,
  bytesParaBase64,
  tipoMimePorCabecalho,
  validarImagemAntesEnviar,
  TIPOS_ACEITOS,
  ERRO_COPIA_SUMIU
};
