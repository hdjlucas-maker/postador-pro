'use strict';

// Primitivas de criptografia do Worker.
//
// A versão anterior rodava em Node e usava `bcryptjs` + `crypto` do módulo
// nativo. Worker não tem módulo `crypto` nem bcrypt, então tudo aqui usa a Web
// Crypto API, que é a interface padrão do runtime.
//
// ## Por que PBKDF2 e não bcrypt
//
// Não existe bcrypt nativo em Worker sem um WASM de um pacote grande. PBKDF2
// está em `crypto.subtle`, é o KDF que a OWASP recomenda quando não se tem
// Argon2id, e o formato do hash guarda o custo dentro dele — dá para subir a
// iteração no futuro sem invalidar as senhas já gravadas.
//
// ## O custo disso no plano gratuito
//
// O plano gratuito da Cloudflare dá 10 ms de CPU por invocação. PBKDF2-SHA256
// roda em torno de 1 a 2 milhões de iterações por segundo, então 10 ms equivale
// a algo entre 10 mil e 20 mil iterações. A OWASP recomenda 600 mil para
// segurança contra ataque offline, o que estouritamente não cabe no plano
// gratuito.
//
// Aqui o `PBKDF2_ITERACOES` é configurável e o padrão do `wrangler.jsonc` é
// 100 mil, que é o melhor que cabe no Workers Pago ($5/mês, 10 milhões de
// requisições incluídas) e o valor que o resto do projeto assume. Se o plano
// for gratuito, baixe para 10000 e suba `LOGIN_FALHAS_MAX` e a trava de conta,
// que é onde a proteção real está: o custo por tentativa sobe, mas o número de
// tentativas por conta é curto e persistido.
//
// Vale medir: `npx wrangler tail` mostra quando uma requisição estoura o teto
// de CPU, e a resposta vira 1102 em vez de um hash silenciosamente fraco.

const enc = new TextEncoder();

const ITERACOES_PADRAO = 100000;
const TAMANHO_SALT = 16;
const TAMANHO_HASH = 32;
const TAMANHO_CHAVE_BITS = TAMANHO_HASH * 8;

// Um segredo fixo só para gastar o mesmo tempo de derivada quando o e-mail
// não existe. Sem isso, "e-mail inexistente" responderia em 1 ms e "e-mail
// existe, senha errada" em 60 ms, e a diferença revelaria quem tem conta.
const SALT_FANTASMA = enc.encode('postador-pro-fantasma-v1');

function paraHex(bytes) {
  let saida = '';
  for (const byte of bytes) saida += byte.toString(16).padStart(2, '0');
  return saida;
}

function deHex(hex) {
  const saida = new Uint8Array(hex.length / 2);
  for (let i = 0; i < saida.length; i += 1) saida[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return saida;
}

function paraBase64(bytes) {
  let binario = '';
  for (const byte of bytes) binario += String.fromCharCode(byte);
  return btoa(binario);
}

function deBase64(texto) {
  const binario = atob(texto);
  const saida = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) saida[i] = binario.charCodeAt(i);
  return saida;
}

function bytesAleatorios(tamanho) {
  return crypto.getRandomValues(new Uint8Array(tamanho));
}

// Comparação de tempo constante: sai sempre o mesmo número de iterações,
// permitindo a comparação byte a byte sem ramificar.
function igualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i += 1) diferenca |= a[i] ^ b[i];
  return diferenca === 0;
}

async function derivar(senha, salt, iteracoes) {
  const material = await crypto.subtle.importKey('raw', enc.encode(String(senha)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iteracoes, hash: 'SHA-256' },
    material,
    TAMANHO_CHAVE_BITS
  );
  return new Uint8Array(bits);
}

async function sha256Hex(valor) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(String(valor)));
  return paraHex(new Uint8Array(digest));
}

function novoToken(bytes = 32) {
  return paraHex(bytesAleatorios(bytes));
}

/**
 * Formato: `pbkdf2-sha256$<iteracoes>$<salt base64>$<hash base64>`
 *
 * As iterações ficam dentro do hash, não na configuração. Assim dá para subir o
 * custo no futuro e continuar aceitando as senhas antigas: `confereSenha` lê as
 * iterações do próprio hash em vez de usar o padrão.
 */
async function hasharSenha(senha, iteracoes = ITERACOES_PADRAO) {
  const salt = bytesAleatorios(TAMANHO_SALT);
  const hash = await derivar(senha, salt, iteracoes);
  return `pbkdf2-sha256$${iteracoes}$${paraBase64(salt)}$${paraBase64(hash)}`;
}

async function confereSenha(senha, guardado) {
  const partes = String(guardado || '').split('$');
  if (partes.length !== 4 || partes[0] !== 'pbkdf2-sha256') return false;

  const iteracoes = Number(partes[1]);
  if (!Number.isInteger(iteracoes) || iteracoes < 1) return false;

  let salt;
  let esperado;
  try {
    salt = deBase64(partes[2]);
    esperado = deBase64(partes[3]);
  } catch {
    return false;
  }

  if (esperado.length !== TAMANHO_HASH) return false;

  const calculado = await derivar(senha, salt, iteracoes);
  return igualBytes(calculado, esperado);
}

/**
 * Gasta o mesmo tempo de derivada de um login de verdade, para o e-mail
 * inexistente não responder rápido demais e revelar quem tem conta.
 */
async function gastarTempoDeDerivada(iteracoes = ITERACOES_PADRAO) {
  await derivar('senha-inexistente-que-nunca-existe', SALT_FANTASMA, iteracoes);
}

module.exports = {
  ITERACOES_PADRAO,
  enc,
  paraHex,
  deHex,
  paraBase64,
  deBase64,
  igualBytes,
  bytesAleatorios,
  derivar,
  sha256Hex,
  hashToken: sha256Hex,
  novoToken,
  hasharSenha,
  confereSenha,
  gastarTempoDeDerivada
};
