import { describe, expect, it } from 'vitest';
import { gerarTextos, interpretarResposta, montarMensagens } from '../src/ia.js';

// A resposta do Workers AI é texto livre. O que precisa ser confiável é a
// leitura: três blocos separados por `---`, sem numeração, aspas ou sobras.

describe('gerador de textos com IA', () => {
  it('lê três mensagens separadas por ---, limpando numeração e aspas', () => {
    const bruto = [
      'Mensagem 1: "Primeira oferta completa com link e chamada de ação."',
      '',
      '---',
      '',
      '2) Segunda variação, também pronta para publicar.',
      '',
      '###',
      '',
      'Terceira variação com outro ângulo de venda.'
    ].join('\n');

    const textos = interpretarResposta(bruto);
    expect(textos).toHaveLength(3);
    expect(textos[0]).toBe('Primeira oferta completa com link e chamada de ação.');
    expect(textos[1]).toBe('Segunda variação, também pronta para publicar.');
    expect(textos[2]).toBe('Terceira variação com outro ângulo de venda.');
  });

  it('descarta separadores vazios e limita a três mensagens', () => {
    const bruto = [
      'Primeira mensagem longa o suficiente.',
      '---',
      'Segunda mensagem longa o suficiente.',
      '---',
      '---',
      'Terceira mensagem longa o suficiente.',
      '---',
      'Quarta mensagem que não deve ser usada.'
    ].join('\n');

    const textos = interpretarResposta(bruto);
    expect(textos).toHaveLength(3);
    expect(textos[2]).toBe('Terceira mensagem longa o suficiente.');
  });

  it('resposta vazia não vira mensagem', () => {
    expect(interpretarResposta('')).toEqual([]);
    expect(interpretarResposta({ response: '   ' })).toEqual([]);
    expect(interpretarResposta(undefined)).toEqual([]);
  });

  it('monta o pedido com os fatos, o tom e a chamada para ação escolhidos', () => {
    const mensagens = montarMensagens({
      produto: 'Kit de panelas',
      beneficios: '5 peças e entrega em São Paulo',
      publico: 'quem está montando a primeira cozinha',
      link: 'https://exemplo.com/kit',
      tom: 'elegante',
      objetivo: 'mensagem'
    });

    expect(mensagens[0].role).toBe('system');
    expect(mensagens[0].content).toMatch(/três variações/);
    expect(mensagens[1].role).toBe('user');
    expect(mensagens[1].content).toContain('Kit de panelas');
    expect(mensagens[1].content).toContain('5 peças e entrega em São Paulo');
    expect(mensagens[1].content).toContain('quem está montando a primeira cozinha');
    expect(mensagens[1].content).toContain('https://exemplo.com/kit');
    expect(mensagens[1].content).toMatch(/elegante e sofisticada/);
    expect(mensagens[1].content).toMatch(/enviar uma mensagem/);
  });

  it('chama a binding AI com o modelo configurado e devolve os três textos', async () => {
    const chamadas = [];
    const env = {
      IA_MODEL: 'modelo-de-teste',
      AI: {
        run: async (modelo, opcoes) => {
          chamadas.push({ modelo, opcoes });
          return { response: 'Primeira mensagem completa.\n---\nSegunda mensagem completa.\n---\nTerceira mensagem completa.' };
        }
      }
    };

    const textos = await gerarTextos(env, { produto: 'Curso de violão' });
    expect(textos).toEqual(['Primeira mensagem completa.', 'Segunda mensagem completa.', 'Terceira mensagem completa.']);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].modelo).toBe('modelo-de-teste');
    expect(chamadas[0].opcoes.messages[1].content).toContain('Curso de violão');
  });

  it('sem binding AI responde 503 e com resposta incompleta responde 502', async () => {
    await expect(gerarTextos({}, { produto: 'Curso de violão' })).rejects.toMatchObject({ status: 503 });

    const env = { AI: { run: async () => ({ response: 'Uma única mensagem sem separador.' }) } };
    await expect(gerarTextos(env, { produto: 'Curso de violão' })).rejects.toMatchObject({ status: 502 });
  });
});
