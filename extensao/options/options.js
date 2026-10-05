'use strict';

import { CONFIG } from '../lib/config.js';
import * as armazenamento from '../lib/armazenamento.js';
import * as campanhas from '../lib/campanhas.js';
import * as licenca from '../lib/licenca.js';

const $ = id => document.getElementById(id);

let imagemSelecionada = null; // { id, blob }

function mostrar(section) {
  $('secao-boas-vindas').classList.toggle('oculta', section !== 'boas-vindas');
  $('secao-campanhas').classList.toggle('oculta', section !== 'campanhas');
  $('secao-form').classList.toggle('oculta', section !== 'form');
}

function formatarData(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('pt-BR');
}

function escapar(html) {
  return String(html).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function carregarResumoLicenca() {
  const estado = await armazenamento.carregarEstado();
  if (!estado.token) {
    $('resumo-licenca').textContent = 'Não conectado';
    mostrar('boas-vindas');
    return;
  }
  try {
    const resultado = await licenca.verificarLicenca(true);
    if (!resultado.permitido) {
      $('resumo-licenca').textContent = 'Licença expirada — assine para publicar.';
      mostrar('boas-vindas');
      return;
    }
    const lic = estado.licenca || {};
    const plano = lic.plano === 'pro' ? 'Pro' : 'Avaliação';
    $('resumo-licenca').textContent = `Plano ${plano}`;
    mostrar('campanhas');
    await renderizarCampanhas();
  } catch (_) {
    $('resumo-licenca').textContent = 'Sem conexão';
    mostrar('boas-vindas');
  }
}

async function renderizarCampanhas() {
  const estado = await armazenamento.carregarEstado();
  const lista = estado.campanhas || [];
  const ativas = lista.filter(c => ['ativa', 'pausada', 'preparacao'].includes(c.status)).length;
  $('contagem').textContent = `${ativas} campanha(s) em andamento de ${lista.length} no total.`;

  if (!lista.length) {
    $('lista-campanhas').innerHTML = '<p class="suave">Nenhuma campanha ainda. Crie a primeira!</p>';
    return;
  }

  const statusTexto = { preparacao: 'Preparação', ativa: 'Publicando', pausada: 'Pausada', concluida: 'Concluída' };
  const itemTexto = { pendente: 'Aguardando', preparando: 'Preparando…', publicando: 'Publicando…', publicado: 'Publicado', falhou: 'Falha', nao_confirmado: 'Não confirmado' };

  $('lista-campanhas').innerHTML = lista.map(c => {
    const fila = c.fila || (c.destinos || []).map(destino => ({ destino, status: 'pendente' }));
    const total = fila.length;
    const publicados = fila.filter(i => i.status === 'publicado').length;
    const falhas = fila.filter(i => i.status === 'falhou').length;
    const incertos = fila.filter(i => i.status === 'nao_confirmado').length;
    const restantes = fila.filter(i => i.status === 'pendente').length;
    const progresso = total ? Math.round((publicados / total) * 100) : 0;
    const podeIniciar = c.status === 'preparacao';
    const pausada = c.status === 'pausada';
    const ativa = c.status === 'ativa';
    const proxima = c.proximaPublicacaoEm ? new Date(c.proximaPublicacaoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    const linhas = fila.map(i => `<div class="item-fila"><span class="bolinha ${i.status}">${i.status === 'publicado' ? '✓' : i.status === 'falhou' ? '✕' : i.status === 'nao_confirmado' ? '⚠' : i.status === 'publicando' || i.status === 'preparando' ? '●' : '○'}</span><span><strong>${escapar(i.destino)}</strong><small>${itemTexto[i.status] || i.status}${i.erro ? ' — ' + escapar(i.erro) : ''}</small></span></div>`).join('');
    return `<div class="cartao-campanha">
      <div class="cabecalho-campanha"><h3>${escapar(c.nome)}</h3><span class="status ${c.status}">${statusTexto[c.status] || c.status}</span></div>
      <div class="barra"><span style="width:${progresso}%"></span></div>
      <div class="numeros"><b>${publicados}</b> publicados · <b>${falhas}</b> falhas · <b>${incertos}</b> não confirmados · <b>${restantes}</b> restantes</div>
      <div class="meta">${total} grupos · ${c.textos?.length || 0} texto(s) · Próxima publicação: ${proxima}</div>
      <div class="fila">${linhas}</div>
      <div class="acoes">
        ${podeIniciar ? '<button class="botao" data-acao="iniciar" data-id="' + c.id + '">INICIAR PUBLICAÇÃO</button>' : ''}
        ${ativa ? '<button class="botao secundario" data-acao="pausar" data-id="' + c.id + '">PAUSAR</button>' : ''}
        ${pausada ? '<button class="botao" data-acao="retomar" data-id="' + c.id + '">RETOMAR CAMPANHA</button>' : ''}
        <button class="botao-link" data-acao="excluir" data-id="${c.id}">Excluir</button>
      </div>
      ${ativa ? '<p class="status-live">Status: ' + (c.atual ? 'Publicando ' + escapar(c.atual) : (c.proximaPublicacaoEm ? 'Aguardando intervalo' : 'Preparando')) + '</p>' : ''}
    </div>`;
  }).join('');

  document.querySelectorAll('[data-acao]').forEach(botao => botao.addEventListener('click', async () => {
    const id = botao.dataset.id;
    const acao = botao.dataset.acao;
    if (acao === 'excluir') return excluirCampanha(id);
    if (acao === 'iniciar') {
      if (!confirm('Iniciar esta campanha agora? A primeira publicação será iniciada imediatamente.')) return;
      await chrome.runtime.sendMessage({ tipo: 'iniciar-campanha', campanhaId: id });
    }
    if (acao === 'pausar') {
      await chrome.runtime.sendMessage({ tipo: 'pausar-campanha', campanhaId: id });
    }
    if (acao === 'retomar') {
      if (!confirm('Retomar a campanha? Uma nova publicação poderá ser iniciada imediatamente.')) return;
      await chrome.runtime.sendMessage({ tipo: 'retomar-campanha', campanhaId: id });
    }
    await renderizarCampanhas();
  }));
}

async function excluirCampanha(id) {
  if (!confirm('Excluir esta campanha?')) return;
  await campanhas.excluirCampanha(id);
  await renderizarCampanhas();
}

function abrirForm(nova) {
  $('titulo-form').textContent = nova ? 'Nova campanha' : 'Editar campanha';
  if (nova) {
    $('campo-nome').value = '';
    $('campo-texto').value = '';
    $('campo-destinos').value = '';
    $('campo-agendar').checked = false;
    $('campo-horario').classList.add('oculta');
    $('preview-imagem').classList.add('oculta');
    imagemSelecionada = null;
    $('campo-imagem').value = '';
    $('erro-form').classList.add('oculta');
  }
  mostrar('form');
}

$('botao-nova').addEventListener('click', () => abrirForm(true));
$('botao-cancelar').addEventListener('click', () => mostrar('campanhas'));

$('campo-agendar').addEventListener('change', () => {
  $('campo-horario').classList.toggle('oculta', !$('campo-agendar').checked);
});

$('campo-texto').addEventListener('input', () => {
  $('contador-texto').textContent = `${$('campo-texto').value.length} / ${CONFIG.MAX_TEXT_LENGTH}`;
});

$('campo-destinos').addEventListener('input', () => {
  const n = $('campo-destinos').value.split('\n').filter(d => d.trim()).length;
  $('contador-destinos').textContent = `${n} destino(s)`;
});

$('campo-imagem').addEventListener('change', async () => {
  const arquivo = $('campo-imagem').files[0];
  if (!arquivo) return;
  if (arquivo.size > CONFIG.MAX_IMAGE_BYTES) {
    $('erro-form').textContent = `A imagem precisa ter no máximo ${Math.round(CONFIG.MAX_IMAGE_BYTES / 1024 / 1024)} MB.`;
    $('erro-form').classList.remove('oculta');
    return;
  }
  const id = `img_${Date.now()}`;
  await armazenamento.salvarImagem(id, arquivo);
  imagemSelecionada = { id, blob: arquivo };
  $('miniatura').src = URL.createObjectURL(arquivo);
  $('preview-imagem').classList.remove('oculta');
  $('erro-form').classList.add('oculta');
});

$('remover-imagem').addEventListener('click', () => {
  if (imagemSelecionada) armazenamento.apagarImagem(imagemSelecionada.id).catch(() => {});
  imagemSelecionada = null;
  $('campo-imagem').value = '';
  $('preview-imagem').classList.add('oculta');
});

$('botao-salvar').addEventListener('click', async () => {
  $('erro-form').classList.add('oculta');

  const destinos = $('campo-destinos').value.split('\n').map(d => d.trim()).filter(Boolean);
  const agendadoPara = $('campo-agendar').checked ? new Date($('campo-horario').value).toISOString() : null;

  const estado = await armazenamento.carregarEstado();
  const limites = estado.licenca && estado.licenca.limites ? estado.licenca.limites : null;

  try {
    const campanha = await campanhas.criarCampanha({
      nome: $('campo-nome').value,
      textos: [$('campo-texto').value],
      destinos,
      imagemId: imagemSelecionada ? imagemSelecionada.id : null,
      agendadoPara
    }, limites);

    mostrar('campanhas');
    await renderizarCampanhas();
  } catch (erro) {
    $('erro-form').textContent = erro.message || 'Não deu para salvar a campanha.';
    $('erro-form').classList.remove('oculta');
  }
});

carregarResumoLicenca();

setInterval(() => { if (!$('secao-campanhas').classList.contains('oculta')) renderizarCampanhas().catch(() => {}); }, 2000);
