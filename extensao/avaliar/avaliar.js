'use strict';

// Janela "Avaliar ferramenta": aberta pelo popup e pela página de opções em
// uma janela própria (chrome.windows.create), sem sair da página atual.
//
// O envio usa o mesmo `chamarApi` da licença: com token (conta logada) a
// avaliação é registrada; sem token o servidor responde 401 e a janela orienta
// o usuário a entrar. As avaliações exibidas vêm de /api/extensao/avaliacoes e
// só mostram o que o servidor marca como aprovado.

import * as licenca from '../lib/licenca.js';

const $ = id => document.getElementById(id);
const estrelas = [...document.querySelectorAll('.estrela')];

let notaSelecionada = 0;

function pintarEstrelas(ate) {
  for (const botao of estrelas) {
    botao.classList.toggle('ativa', Number(botao.dataset.nota) <= ate);
  }
}

for (const botao of estrelas) {
  botao.addEventListener('click', () => {
    notaSelecionada = Number(botao.dataset.nota);
    pintarEstrelas(notaSelecionada);
    $('status-avaliar').textContent = '';
  });
  botao.addEventListener('mouseenter', () => pintarEstrelas(Number(botao.dataset.nota)));
}

$('estrelas').addEventListener('mouseleave', () => pintarEstrelas(notaSelecionada));

$('botao-enviar').addEventListener('click', async () => {
  if (!notaSelecionada) {
    $('status-avaliar').textContent = 'Escolha uma nota de 1 a 5 antes de enviar.';
    return;
  }

  $('botao-enviar').disabled = true;
  $('status-avaliar').textContent = 'Enviando...';

  try {
    await licenca.chamarApi('/api/extensao/avaliacao', {
      metodo: 'POST',
      corpo: {
        nota: notaSelecionada,
        comentario: $('campo-comentario').value.trim()
      }
    });

    $('texto-obrigado').textContent =
      `Você deu nota ${notaSelecionada} de 5. Sua opinião foi registrada e ajuda a melhorar a ferramenta.`;
    $('bloco-form').classList.add('oculta');
    $('bloco-obrigado').classList.remove('oculta');
  } catch (erro) {
    $('botao-enviar').disabled = false;
    $('status-avaliar').textContent = erro && erro.status === 401
      ? 'Entre na sua conta pela extensão para enviar a avaliação.'
      : 'Não consegui enviar agora. Confira sua internet e tente de novo.';
  }
});

$('botao-fechar').addEventListener('click', () => window.close());
$('botao-fechar-form').addEventListener('click', () => window.close());

function formatarData(iso) {
  if (!iso) return '';
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? '' : data.toLocaleDateString('pt-BR');
}

function criarItem(avaliacao) {
  const item = document.createElement('li');
  item.className = 'item';

  const topo = document.createElement('div');
  topo.className = 'item-topo';

  const nome = document.createElement('strong');
  nome.textContent = avaliacao.nome || 'Cliente';
  topo.appendChild(nome);

  const nota = document.createElement('span');
  nota.className = 'nota';
  nota.textContent = '★'.repeat(avaliacao.nota) + '☆'.repeat(5 - avaliacao.nota);
  nota.setAttribute('aria-label', `Nota ${avaliacao.nota} de 5`);
  topo.appendChild(nota);

  const quando = formatarData(avaliacao.criadoEm);
  if (quando) {
    const data = document.createElement('span');
    data.className = 'suave';
    data.textContent = quando;
    topo.appendChild(data);
  }

  item.appendChild(topo);

  if (avaliacao.comentario) {
    const texto = document.createElement('p');
    texto.className = 'comentario';
    texto.textContent = avaliacao.comentario;
    item.appendChild(texto);
  }

  return item;
}

async function carregarAvaliacoes() {
  try {
    const dados = await licenca.chamarApi('/api/extensao/avaliacoes');
    const avaliacoes = dados.avaliacoes || [];
    const lista = $('lista-avaliacoes');
    lista.textContent = '';

    for (const avaliacao of avaliacoes) {
      lista.appendChild(criarItem(avaliacao));
    }

    const total = Number(dados.total || 0);
    $('resumo-notas').textContent = (total > 0 && dados.media)
      ? `Nota média ${String(dados.media).replace('.', ',')} · ${total} ${total === 1 ? 'avaliação' : 'avaliações'}`
      : '';

    if (avaliacoes.length === 0) {
      $('carregando-avaliacoes').textContent = 'Nenhuma avaliação ainda. Seja a primeira pessoa a avaliar.';
    } else {
      $('carregando-avaliacoes').classList.add('oculta');
    }
  } catch (_) {
    $('carregando-avaliacoes').textContent = 'Não foi possível carregar as avaliações agora.';
  }
}

carregarAvaliacoes();
