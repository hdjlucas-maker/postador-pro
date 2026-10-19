'use strict';

// Gerador de textos com a IA da Cloudflare (Workers AI).
//
// Não usa chave externa: o Worker recebe a binding `AI` do Workers AI, que tem
// cota diária gratuita. Sem a binding (ambiente local sem IA ou deploy antigo),
// a rota responde 503 e a extensão orienta o cliente a escrever manualmente.
//
// A resposta do modelo é texto livre. Para não depender de JSON perfeito (que
// modelos menores erram com frequência), pedimos três blocos separados por uma
// linha `---` e a leitura tolera sobras, numeração e aspas.

const MODELO_PADRAO = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_TEXTO = 5000;

const TONS = {
  amigavel: 'amigável e próxima, como uma conversa entre conhecidos',
  direto: 'direta e objetiva, sem rodeios',
  entusiasmado: 'entusiasmada e cheia de energia',
  elegante: 'elegante e sofisticada, sem exageros'
};

const OBJETIVOS = {
  link: 'convidar a pessoa a conhecer a oferta pelo link informado',
  seguir: 'convidar a pessoa a seguir a página ou o perfil',
  curtir: 'pedir para a pessoa curtir a publicação se tiver interesse',
  mensagem: 'pedir para a pessoa enviar uma mensagem para saber mais'
};

function limpar(valor, max) {
  return String(valor ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function montarMensagens(entrada = {}) {
  const produto = limpar(entrada.produto, 120);
  const beneficios = limpar(entrada.beneficios, 500);
  const publico = limpar(entrada.publico, 160);
  const link = limpar(entrada.link, 300);
  const tom = TONS[entrada.tom] || TONS.amigavel;
  const objetivo = OBJETIVOS[entrada.objetivo] || OBJETIVOS.link;

  const sistema = [
    'Você é um redator brasileiro especialista em anúncios para grupos de Facebook.',
    'Escreva em português do Brasil, com emojis com moderação.',
    'Use somente os fatos fornecidos; nunca invente preço, prazo, garantia ou qualquer dado que não foi informado.',
    'Não prometa resultados garantidos e evite exageros que possam enganar.',
    'Produza exatamente três variações de mensagem, cada uma completa e pronta para publicar.',
    'Separe as três variações com uma linha contendo apenas três hífens (---).',
    'Não numere as mensagens e não escreva comentários antes ou depois.'
  ].join(' ');

  const linhas = [`Produto ou serviço: ${produto}`];
  if (beneficios) linhas.push(`Benefícios e fatos reais: ${beneficios}`);
  if (publico) linhas.push(`Público: ${publico}`);
  if (link) linhas.push(`Link da oferta (inclua na mensagem): ${link}`);
  linhas.push(`Tom: ${tom}.`);
  linhas.push(`Chamada para ação: ${objetivo}.`);
  linhas.push('Escreva as três mensagens agora, separadas por ---.');

  return [
    { role: 'system', content: sistema },
    { role: 'user', content: linhas.join('\n') }
  ];
}

function limparBloco(bloco) {
  return String(bloco || '')
    // Separação que sobrou dentro do bloco (quando o modelo repete `---`).
    .replace(/^\s*(?:-{3,}|#{3,})\s*\n?/, '')
    // "Mensagem 1:", "Variação 2 -", "1)" e afins.
    .replace(/^\s*(?:mensagem|variação|variacao|opção|opcao)\s*\d+\s*[:.)\-–]\s*/i, '')
    .replace(/^\s*\d+\s*[:.)\-–]\s*/, '')
    // Aspas em volta do bloco inteiro.
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
}

function interpretarResposta(bruto) {
  const texto = typeof bruto === 'string' ? bruto : String(bruto?.response || '');
  const normalizado = texto.replace(/\r\n/g, '\n').trim();
  if (!normalizado) return [];

  const partes = normalizado
    .split(/\n\s*(?:-{3,}|#{3,})\s*\n/)
    .map(limparBloco)
    .filter(bloco => bloco.length >= 10);

  return partes.slice(0, 3);
}

async function gerarTextos(env, entrada) {
  if (!env.AI || typeof env.AI.run !== 'function') {
    throw Object.assign(
      new Error('O gerador de textos com IA está indisponível no momento. Escreva as mensagens manualmente.'),
      { status: 503 }
    );
  }

  const modelo = String(env.IA_MODEL || '').trim() || MODELO_PADRAO;
  let resposta;
  try {
    resposta = await env.AI.run(modelo, {
      messages: montarMensagens(entrada),
      max_tokens: 1400,
      temperature: 0.8
    });
  } catch (erro) {
    throw Object.assign(
      new Error('O gerador de textos com IA não respondeu agora. Tente novamente em instantes ou escreva as mensagens manualmente.'),
      { status: 502, causa: String(erro?.message || erro) }
    );
  }

  const textos = interpretarResposta(resposta);
  if (textos.length < 3) {
    throw Object.assign(
      new Error('A IA não devolveu as três variações completas. Tente novamente.'),
      { status: 502 }
    );
  }

  return textos.map(texto => texto.slice(0, MAX_TEXTO));
}

export { gerarTextos, montarMensagens, interpretarResposta, TONS, OBJETIVOS, MODELO_PADRAO, MAX_TEXTO };
