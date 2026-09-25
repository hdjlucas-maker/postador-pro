'use strict';

// O campo de minutos do cron só aceita 0-59. Um intervalo de 360 minutos
// viraria `*/360 * * * *`, que nunca casa com nada: o backup simplesmente não
// roda e ninguém percebe até perder os dados. Aqui o intervalo em minutos é
// distribuído pelos dois campos (hora e minuto) do cron, que é onde cabe uma
// expressão de 6 horas.
const MAXIMO_MINUTOS = 24 * 60;

function expressaoACadaMinutos(minutos) {
  const total = Number(minutos);

  if (!Number.isFinite(total) || total < 1) {
    throw new RangeError(`intervalo em minutos inválido: ${minutos}`);
  }

  const inteiro = Math.floor(total);
  if (inteiro > MAXIMO_MINUTOS) {
    throw new RangeError(`intervalo em minutos inválido: ${minutos} (máximo ${MAXIMO_MINUTOS})`);
  }

  // Um dia inteiro não cabe no campo de hora (0-23): vira uma execução diária.
  if (inteiro === MAXIMO_MINUTOS) return '0 0 * * *';

  const horas = Math.floor(inteiro / 60);
  const resto = inteiro % 60;

  // Sem parte de horas, `*/N` no campo de minuto já resolve.
  if (horas === 0) return `*/${resto} * * * *`;

  return `${resto} */${horas} * * *`;
}

module.exports = { expressaoACadaMinutos, MAXIMO_MINUTOS };
