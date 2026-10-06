'use strict';

// Configuração da extensão. Os valores de ritmo e limites espelham os do
// servidor (worker/src/config.js e .env.example). A extensão se autolimita com
// os números que o servidor devolve em /api/extensao/planos.

const CONFIG = {
  // URL base da API de licença. Em desenvolvimento local aponte para o
  // workers.dev real ou para o wrangler dev.
  API_BASE: 'https://postador.hdjlucas.workers.dev',

  // Ritmo de digitação por caractere, em milissegundos.
  CADENCIA_MIN_MS: 35,
  CADENCIA_MAX_MS: 95,

  // Intervalo padrão entre novas postagens: 10–20 minutos.
  DELAY_ENTRE_POSTS_MIN: 600,
  DELAY_ENTRE_POSTS_MAX: 1200,

  // Limites de conteúdo.
  MAX_IMAGE_BYTES: 8388608,
  MAX_TEXTOS: 20,
  MAX_TEXT_LENGTH: 5000,
  MAX_CAMPANHA_NOME: 100,
  MIN_LEAD_MINUTES: 2,
  MAX_DIAS_AGENDAMENTO: 90,

  // Carência offline: quanto tempo a extensão continua publicando sem
  // conseguir falar com o servidor, para não cobrar o cliente por falha nossa.
  CARENCIA_OFFLINE_MS: 24 * 60 * 60 * 1000,

  // Intervalo de verificação da licença.
  VERIFICAR_LICENCA_MINUTOS: 60
};

function aleatorio(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delayEntrePosts() {
  return aleatorio(CONFIG.DELAY_ENTRE_POSTS_MIN, CONFIG.DELAY_ENTRE_POSTS_MAX) * 1000;
}

function cadenciaDigito() {
  return aleatorio(CONFIG.CADENCIA_MIN_MS, CONFIG.CADENCIA_MAX_MS);
}

export { CONFIG, aleatorio, delayEntrePosts, cadenciaDigito };
