'use strict';

import { CONFIG } from '../lib/config.js';
import * as armazenamento from '../lib/armazenamento.js';
import * as campanhas from '../lib/campanhas.js';
import * as licenca from '../lib/licenca.js';

const $ = id => document.getElementById(id);

let imagemSelecionada = null; // { id, blob }
let campanhaEditando = null;

function mostrar(section) {
  $('secao-boas-vindas').classList.toggle('oculta', section !== 'boas-vindas');
  $('secao-campanhas').classList.toggle('oculta', section !== 'campanhas');
  $('secao-form').classList.toggle('oculta', section !== 'form');
  $('secao-ritmo').classList.toggle('oculta', section !== 'ritmo');
  $('secao-ajuda').classList.toggle('oculta', section !== 'ajuda');
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
    const plano = lic.plano === 'pro' ? 'Pro' : 'Lite';
    $('resumo-licenca').textContent = `Plano ${plano}`;
    mostrar('campanhas');
    await renderizarCampanhas();
  } catch (_) {
    $('resumo-licenca').textContent = 'Sem conexão';
    mostrar('boas-vindas');
  }
}

function renderizarStatus(estado) {
  const execucao = estado.execucao || { fase: 'parado', mensagem: 'Nenhuma execução em andamento.' };
  const nomes = { parado: 'Parado', preparando: 'Preparando', abrindo_grupo: 'Abrindo grupo', publicando: 'Publicando', aguardando: 'Aguardando intervalo', concluida: 'Concluída', erro: 'Erro' };
  $('status-execucao').textContent = nomes[execucao.fase] || execucao.fase || 'Parado';
  $('detalhe-execucao').textContent = execucao.mensagem || 'Nenhuma execução em andamento.';
  $('botao-pausar').classList.toggle('oculta', Boolean(execucao.pausada) || execucao.fase === 'parado' || execucao.fase === 'concluida');
  $('botao-retomar').classList.toggle('oculta', !execucao.pausada);
  const campanha = (estado.campanhas || []).find(c => c.id === execucao.campanhaId) || (estado.campanhas || []).find(c => c.status === 'ativa');
  const historico = (estado.historico || []).filter(h => !campanha || h.campanhaId === campanha.id);
  const publicados = historico.filter(h => h.resultado === 'publicado').length;
  const falhas = historico.filter(h => h.resultado === 'falhou').length;
  const restantes = campanha ? (campanha.destinos || []).length : 0;
  $('status-concluidos').textContent = publicados;
  $('status-falhas').textContent = falhas;
  $('status-restantes').textContent = restantes;
  $('status-proxima').textContent = execucao.proximaEm ? new Date(execucao.proximaEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—';
  const fila = $('fila-visual');
  if (!campanha) { fila.innerHTML = ''; return; }
  const originais = campanha.destinosOriginais || campanha.destinos || [];
  fila.innerHTML = originais.map(destino => {
    const item = historico.filter(h => h.destino === destino).slice(-1)[0];
    if (item?.resultado === 'publicado') return `<div class="fila-item ok">✓ ${escapar(destino)} — publicado às ${formatarData(item.quando)}</div>`;
    if (item?.resultado === 'falhou') return `<div class="fila-item erro">✕ ${escapar(destino)} — falhou: ${escapar(item.erro || 'erro não confirmado')}</div>`;
    if (campanha.destinos[0] === destino && !execucao.pausada && execucao.fase !== 'parado') return `<div class="fila-item preparando">● ${escapar(destino)} — preparando...</div>`;
    return `<div class="fila-item">○ ${escapar(destino)}</div>`;
  }).join('');
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
        <button class="botao-link" data-acao="editar" data-id="${c.id}">Editar</button>
        <button class="botao-link" data-acao="reutilizar" data-id="${c.id}">Usar novamente</button>
        <button class="botao-link perigo" data-acao="excluir" data-id="${c.id}">Excluir</button>
      </div>
    </div>`).join('');

  document.querySelectorAll('[data-acao]').forEach(botao => {
    botao.addEventListener('click', () => {
      const acao = botao.dataset.acao;
      if (acao === 'excluir') excluirCampanha(botao.dataset.id);
      if (acao === 'editar') editarCampanha(botao.dataset.id);
      if (acao === 'reutilizar') reutilizarCampanha(botao.dataset.id);
    });
  });
}

async function excluirCampanha(id) {
  if (!confirm('Excluir esta campanha?')) return;
  await campanhas.excluirCampanha(id);
  await renderizarCampanhas();
}

const RITMOS = {
  controlado: { texto: '10 a 15 minutos', minMs: 600000, maxMs: 900000 },
  calmo: { texto: '15 a 20 minutos', minMs: 900000, maxMs: 1200000 },
  seguro: { texto: '20 a 30 minutos', minMs: 1200000, maxMs: 1800000 }
};

async function carregarRitmo() {
  const estado = await armazenamento.carregarEstado();
  const chave = estado.config && estado.config.ritmo && estado.config.ritmo.nome ? estado.config.ritmo.nome : 'controlado';
  $('campo-ritmo').value = RITMOS[chave] || chave === 'manual' ? chave : 'controlado';
  if (chave === 'manual' && estado.config.ritmo.minMs) $('campo-delay-manual').value = Math.round(estado.config.ritmo.minMs / 1000);
  $('resumo-ritmo').textContent = chave === 'manual' ? `${$('campo-delay-manual').value} segundos` : RITMOS[$('campo-ritmo').value].texto;
}

$('atalho-ritmo').addEventListener('click', async () => { await carregarRitmo(); mostrar('ritmo'); });
$('atalho-faq').addEventListener('click', () => mostrar('ajuda'));
$('botao-voltar-ajuda').addEventListener('click', () => mostrar('campanhas'));
$('campo-ritmo').addEventListener('change', () => { const chave = $('campo-ritmo').value; $('resumo-ritmo').textContent = chave === 'manual' ? `${$('campo-delay-manual').value} segundos` : RITMOS[chave].texto; });
$('campo-delay-manual').addEventListener('input', () => { if ($('campo-ritmo').value === 'manual') $('resumo-ritmo').textContent = `${$('campo-delay-manual').value} segundos`; });
$('botao-cancelar-ritmo').addEventListener('click', () => mostrar('campanhas'));
$('botao-salvar-ritmo').addEventListener('click', async () => {
  const estado = await armazenamento.carregarEstado();
  const chave = $('campo-ritmo').value;
  const ritmo = RITMOS[chave] || RITMOS.controlado;
  const manualMs = Math.max(600000, Math.min(7200000, Number($('campo-delay-manual').value || 900) * 1000));
  estado.config = { ...(estado.config || {}), ritmo: { nome: chave, minMs: chave === 'manual' ? manualMs : ritmo.minMs, maxMs: chave === 'manual' ? manualMs : ritmo.maxMs } };
  await armazenamento.salvarEstado(estado);
  $('ritmo-salvo').classList.remove('oculta');
  $('resumo-ritmo').textContent = ritmo.texto;
});

function abrirForm(nova) {
  $('titulo-form').textContent = nova ? 'Nova campanha' : 'Editar campanha';
  if (nova) {
    campanhaEditando = null;
    $('campo-nome').value = '';
    $('campo-texto').value = '';
    $('campo-destinos').value = '';
    $('campo-agendar').checked = false;
    $('campo-responsabilidade').checked = false;
    $('campo-horario').classList.add('oculta');
    $('preview-imagem').classList.add('oculta');
    imagemSelecionada = null;
    $('campo-imagem').value = '';
    $('erro-form').classList.add('oculta');
  }
  mostrar('form');
}

async function editarCampanha(id) {
  const campanha = await campanhas.obterCampanha(id);
  if (!campanha) return;
  campanhaEditando = campanha;
  abrirForm(false);
  $('campo-nome').value = campanha.nome || '';
  $('campo-texto').value = (campanha.textos || []).join('\n');
  $('campo-destinos').value = (campanha.destinosOriginais || campanha.destinos || []).join('\n');
  $('contador-destinos').textContent = `${(campanha.destinosOriginais || campanha.destinos || []).length} destino(s)`;
  $('campo-agendar').checked = Boolean(campanha.agendadoPara);
  $('campo-responsabilidade').checked = true;
  $('campo-horario').classList.toggle('oculta', !$('campo-agendar').checked);
  if (campanha.agendadoPara) $('campo-horario').value = new Date(campanha.agendadoPara).toISOString().slice(0, 16);
  imagemSelecionada = null;
  $('preview-imagem').classList.add('oculta');
  if (campanha.imagemId) {
    const blob = await armazenamento.buscarImagem(campanha.imagemId).catch(() => null);
    if (blob) {
      imagemSelecionada = { id: campanha.imagemId, blob };
      $('miniatura').src = URL.createObjectURL(blob);
      $('preview-imagem').classList.remove('oculta');
  atualizarPreview();
    }
  }
  mostrar('form');
}

async function reutilizarCampanha(id) {
  const original = await campanhas.obterCampanha(id);
  if (!original) return;
  const destinos = original.destinosOriginais || original.destinos || [];
  const estado = await armazenamento.carregarEstado();
  const limites = estado.licenca && estado.licenca.limites ? estado.licenca.limites : null;
  try {
    await campanhas.criarCampanha({ nome: `${original.nome} (cópia)`, textos: original.textos || [], destinos, imagemId: original.imagemId || null, agendadoPara: null }, limites);
    await renderizarCampanhas();
  } catch (erro) {
    $('erro-form').textContent = erro.message || 'Não foi possível reutilizar a campanha.';
    $('erro-form').classList.remove('oculta');
  }
}
$('botao-nova').addEventListener('click', () => abrirForm(true));
$('atalho-nova').addEventListener('click', () => abrirForm(true));
$('atalho-feedback').addEventListener('click', () => chrome.tabs.create({ url: `${CONFIG.API_BASE}/?origem=extensao#avaliar` }));
document.querySelectorAll('[data-emoji]').forEach(botao => {
  botao.addEventListener('click', () => {
    const campo = $('campo-texto');
    const emoji = botao.dataset.emoji;
    const inicio = campo.selectionStart ?? campo.value.length;
    const fim = campo.selectionEnd ?? campo.value.length;
    campo.value = `${campo.value.slice(0, inicio)}${emoji}${campo.value.slice(fim)}`;
    campo.focus();
    campo.selectionStart = campo.selectionEnd = inicio + emoji.length;
    campo.dispatchEvent(new Event('input'));
  });
});
$('botao-cancelar').addEventListener('click', () => mostrar('campanhas'));

$('campo-agendar').addEventListener('change', () => { $('campo-horario').classList.toggle('oculta', !$('campo-agendar').checked); atualizarPreview(); });
$('campo-horario').addEventListener('input', atualizarPreview);

$('campo-texto').addEventListener('input', () => {
  $('contador-texto').textContent = `${$('campo-texto').value.length} / ${CONFIG.MAX_TEXT_LENGTH}`; atualizarPreview();
});

$('campo-destinos').addEventListener('input', () => {
  const n = $('campo-destinos').value.split('\n').filter(d => d.trim()).length;
  $('contador-destinos').textContent = `${n} destino(s)`; atualizarPreview();
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
  atualizarPreview();
  $('erro-form').classList.add('oculta');
});

$('remover-imagem').addEventListener('click', () => {
  if (imagemSelecionada) armazenamento.apagarImagem(imagemSelecionada.id).catch(() => {});
  imagemSelecionada = null;
  $('campo-imagem').value = '';
  $('preview-imagem').classList.add('oculta');
});

function atualizarPreview() {
  const destinos = $('campo-destinos').value.split('\n').map(d => d.trim()).filter(Boolean);
  $('preview-nome').textContent = $('campo-nome').value || '—';
  $('preview-grupos').textContent = destinos.length;
  $('preview-imagem-texto').textContent = imagemSelecionada ? 'configurada' : 'não configurada';
  $('preview-texto').textContent = $('campo-texto').value.trim() ? 'configurado' : 'não configurado';
  $('preview-inicio').textContent = $('campo-agendar').checked ? ($('campo-horario').value || 'horário não definido') : 'agora';
}

async function salvarCampanha(modo = 'salvar') {
  $('erro-form').classList.add('oculta');
  const postarAgora = modo === 'agora';
  if (!$('campo-responsabilidade').checked) {
    $('erro-form').textContent = 'Confirme que você pode publicar nesses grupos e que a mensagem respeita as regras do grupo.';
    $('erro-form').classList.remove('oculta');
    return;
  }
  const destinos = $('campo-destinos').value.split('\n').map(d => d.trim()).filter(Boolean);
  const agendadoPara = !postarAgora && $('campo-agendar').checked ? new Date($('campo-horario').value).toISOString() : null;
  const estado = await armazenamento.carregarEstado();
  const limites = estado.licenca && estado.licenca.limites ? estado.licenca.limites : null;

  try {
    const dadosCampanha = {
      nome: $('campo-nome').value,
      textos: [$('campo-texto').value],
      destinos,
      destinosOriginais: destinos,
      imagemId: imagemSelecionada ? imagemSelecionada.id : null,
      agendadoPara,
      status: 'ativa'
    };
    const campanha = campanhaEditando
      ? await campanhas.atualizarCampanha(campanhaEditando.id, dadosCampanha)
      : await campanhas.criarCampanha(dadosCampanha, limites);

    if (agendadoPara) {
      await chrome.runtime.sendMessage({ tipo: 'agendar-campanha', campanhaId: campanha.id });
    } else {
      const resposta = await chrome.runtime.sendMessage({ tipo: 'processar-agora' });
      if (resposta && !resposta.ok) throw new Error(resposta.erro || 'A publicação não foi iniciada.');
    }
    mostrar('campanhas');
    await renderizarCampanhas();
  } catch (erro) {
    $('erro-form').textContent = erro.message || 'Não deu para iniciar a campanha.';
    $('erro-form').classList.remove('oculta');
  }
}

$('botao-postar-agora').addEventListener('click', () => salvarCampanha('agora'));
$('botao-salvar').addEventListener('click', () => salvarCampanha('salvar'));
$('botao-pausar').addEventListener('click', async () => { await chrome.runtime.sendMessage({ tipo: 'pausar-campanha' }); renderizarStatus(await armazenamento.carregarEstado()); });
$('botao-retomar').addEventListener('click', async () => { if (!confirm('Retomar a campanha e iniciar novos grupos?')) return; await chrome.runtime.sendMessage({ tipo: 'retomar-campanha' }); renderizarStatus(await armazenamento.carregarEstado()); });
$('botao-encerrar').addEventListener('click', async () => { if (!confirm('Encerrar esta campanha? Nenhum novo grupo será publicado.')) return; await chrome.runtime.sendMessage({ tipo: 'encerrar-campanha' }); renderizarStatus(await armazenamento.carregarEstado()); });

carregarResumoLicenca();

setInterval(async () => { try { renderizarStatus(await armazenamento.carregarEstado()); } catch (_) {} }, 3000);
