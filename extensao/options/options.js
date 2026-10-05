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
  const campanhasLista = estado.campanhas || [];

  const ativas = campanhasLista.filter(c => c.status === 'ativa').length;
  $('contagem').textContent = `${ativas} campanha(s) ativa(s) de ${campanhasLista.length} no total.`;

  const limite = estado.licenca && estado.licenca.limites ? estado.licenca.limites.campanhasAtivas : 3;

  if (!campanhasLista.length) {
    $('lista-campanhas').innerHTML = '<p class="suave">Nenhuma campanha ainda. Crie a primeira!</p>';
    return;
  }

  $('lista-campanhas').innerHTML = campanhasLista.map(c => `
    <div class="cartao-campanha">
      <h3>${escapar(c.nome)} <span class="status ${c.status}">${c.status}</span></h3>
      <div class="meta">
        ${c.destinos.length} destino(s) · ${c.textos.length} texto(s) ·
        ${c.agendadoPara ? 'agendada para ' + formatarData(c.agendadoPara) : 'sem agendamento'} ·
        publicado ${c.publicado} · falhou ${c.falhou}
      </div>
      <div class="acoes">
        <button class="botao-link" data-acao="excluir" data-id="${c.id}">Excluir</button>
      </div>
    </div>`).join('');

  document.querySelectorAll('[data-acao="excluir"]').forEach(botao => {
    botao.addEventListener('click', () => excluirCampanha(botao.dataset.id));
  });
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

    if (agendadoPara && agendadoPara !== null) {
      chrome.runtime.sendMessage({ tipo: 'agendar-campanha', campanhaId: campanha.id }).catch(() => {});
    } else {
      // Publica já, sem agendamento.
      chrome.runtime.sendMessage({ tipo: 'processar-agora' }).catch(() => {});
    }

    mostrar('campanhas');
    await renderizarCampanhas();
  } catch (erro) {
    $('erro-form').textContent = erro.message || 'Não deu para salvar a campanha.';
    $('erro-form').classList.remove('oculta');
  }
});

carregarResumoLicenca();
