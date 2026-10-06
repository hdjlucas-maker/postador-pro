'use strict';

import { CONFIG } from '../lib/config.js';
import * as armazenamento from '../lib/armazenamento.js';
import * as campanhas from '../lib/campanhas.js';
import * as licenca from '../lib/licenca.js';

const $ = id => document.getElementById(id);

let imagemSelecionada = null; // { id, blob }
let campanhaEditando = null;
let salvandoCampanha = false;
let ritmoAtual = { minMs: CONFIG.DELAY_ENTRE_POSTS_MIN * 1000, maxMs: CONFIG.DELAY_ENTRE_POSTS_MAX * 1000 };

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
  const nomes = { parado: 'Parado', preparando: 'Preparando', abrindo_grupo: 'Abrindo grupo', compositor_encontrado: 'Compositor encontrado', inserindo_mensagem: 'Inserindo mensagem', anexando_imagem: 'Anexando imagem', publicando: 'Publicando', aguardando: 'Aguardando intervalo', concluida: 'Concluída', erro: 'Erro' };
  const rotuloStatus = execucao.fase === 'encerrada' ? 'Encerrada'
    : execucao.fase === 'erro' && execucao.pausada ? 'Pausada por erro'
      : execucao.pausada ? 'Pausada'
        : nomes[execucao.fase] || execucao.fase || 'Parado';
  $('status-execucao').textContent = rotuloStatus;
  $('detalhe-execucao').textContent = execucao.mensagem || 'Nenhuma execução em andamento.';
  $('botao-pausar').classList.toggle('oculta', Boolean(execucao.pausada) || execucao.fase === 'parado' || execucao.fase === 'concluida' || execucao.fase === 'encerrada');
  $('botao-retomar').classList.toggle('oculta', !execucao.pausada || execucao.fase === 'encerrada');
  const campanha = (estado.campanhas || []).find(c => c.id === execucao.campanhaId) || (estado.campanhas || []).find(c => c.status === 'ativa');
  const historico = (estado.historico || []).filter(h => !campanha || h.campanhaId === campanha.id);
  const publicados = historico.filter(h => h.resultado === 'publicado').length;
  const falhas = historico.filter(h => h.resultado === 'falhou').length;
  const restantes = campanha ? (campanha.destinos || []).length : 0;
  const total = campanha ? (campanha.destinosOriginais || campanha.destinos || []).length : 0;
  const concluidos = publicados + falhas;
  $('status-campanha').textContent = campanha ? `Campanha: ${campanha.nome}` : 'Status da campanha';
  $('status-concluidos').textContent = publicados;
  $('status-falhas').textContent = falhas;
  $('status-restantes').textContent = restantes;
  $('status-progresso').textContent = `${publicados} / ${total} grupos publicados${falhas ? ` · ${falhas} falha(s)` : ''}`;
  $('status-barra').max = Math.max(1, total);
  $('status-barra').value = Math.min(total, concluidos);
  if (execucao.proximaEm) {
    const segundos = Math.max(0, Math.ceil((execucao.proximaEm - Date.now()) / 1000));
    const relogio = new Date(execucao.proximaEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    $('status-proxima').textContent = `${relogio} (em ${String(Math.floor(segundos / 60)).padStart(2, '0')}:${String(segundos % 60).padStart(2, '0')})`;
  } else $('status-proxima').textContent = '—';
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

async function carregarRitmo() {
  const estado = await armazenamento.carregarEstado();
  const ritmo = estado.config?.ritmo || {};
  ritmoAtual = {
    minMs: ritmo.minMs || CONFIG.DELAY_ENTRE_POSTS_MIN * 1000,
    maxMs: ritmo.maxMs || CONFIG.DELAY_ENTRE_POSTS_MAX * 1000
  };
  $('campo-delay-min').value = Math.round(ritmoAtual.minMs / 1000);
  $('campo-delay-max').value = Math.round(ritmoAtual.maxMs / 1000);
  atualizarResumoRitmo();
}

function atualizarResumoRitmo() {
  const minimo = Number($('campo-delay-min').value || 600);
  const maximo = Number($('campo-delay-max').value || 1200);
  $('resumo-ritmo').textContent = `${minimo} a ${maximo} segundos`;
}

$('atalho-ritmo').addEventListener('click', async () => { await carregarRitmo(); mostrar('ritmo'); });
$('atalho-faq').addEventListener('click', () => mostrar('ajuda'));
$('botao-voltar-ajuda').addEventListener('click', () => mostrar('campanhas'));
$('campo-delay-min').addEventListener('input', atualizarResumoRitmo);
$('campo-delay-max').addEventListener('input', atualizarResumoRitmo);
$('botao-cancelar-ritmo').addEventListener('click', () => mostrar('campanhas'));
$('botao-salvar-ritmo').addEventListener('click', async () => {
  const estado = await armazenamento.carregarEstado();
  const minimo = Number($('campo-delay-min').value);
  const maximo = Number($('campo-delay-max').value);
  if (!Number.isInteger(minimo) || !Number.isInteger(maximo) || minimo < 600 || maximo > 7200 || minimo > maximo) {
    $('ritmo-salvo').textContent = 'Informe valores inteiros entre 600 e 7200, com o mínimo menor ou igual ao máximo.';
    $('ritmo-salvo').classList.remove('oculta');
    return;
  }
  estado.config = { ...(estado.config || {}), ritmo: { minMs: minimo * 1000, maxMs: maximo * 1000 } };
  await armazenamento.salvarEstado(estado);
  $('ritmo-salvo').classList.remove('oculta');
  $('ritmo-salvo').textContent = 'Ritmo atualizado.';
  atualizarResumoRitmo();
});

async function abrirForm(nova) {
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
  await carregarRitmo();
  atualizarPreview();
  mostrar('form');
}

async function editarCampanha(id) {
  const campanha = await campanhas.obterCampanha(id);
  if (!campanha) return;
  if (campanha.status === 'ativa' || campanha.publicado > 0 || campanha.falhou > 0) {
    alert('Esta campanha já foi iniciada. Use “Usar novamente” para revisar e iniciar uma nova execução.');
    return;
  }
  campanhaEditando = campanha;
  await abrirForm(false);
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
  atualizarPreview();
  mostrar('form');
}

async function reutilizarCampanha(id) {
  const original = await campanhas.obterCampanha(id);
  if (!original) return;
  campanhaEditando = null;
  await abrirForm(true);
  $('campo-nome').value = `${original.nome} (cópia)`;
  $('campo-texto').value = (original.textos || []).join('\n');
  $('campo-destinos').value = (original.destinosOriginais || original.destinos || []).join('\n');
  $('campo-responsabilidade').checked = false;
  if (original.imagemId) {
    const blob = await armazenamento.buscarImagem(original.imagemId).catch(() => null);
    if (blob) {
      imagemSelecionada = { id: original.imagemId, blob };
      $('miniatura').src = URL.createObjectURL(blob);
      $('preview-imagem').classList.remove('oculta');
    }
  }
  $('contador-destinos').textContent = `${(original.destinosOriginais || original.destinos || []).length} destino(s)`;
  $('contador-texto').textContent = `${$('campo-texto').value.length} / ${CONFIG.MAX_TEXT_LENGTH}`;
  atualizarPreview();
  mostrar('form');
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

$('campo-nome').addEventListener('input', atualizarPreview);
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
  // A imagem pode pertencer a outra campanha reutilizada; só retiramos esta
  // referência. A limpeza de imagens sem uso fica a cargo da exclusão da campanha.
  imagemSelecionada = null;
  $('campo-imagem').value = '';
  $('preview-imagem').classList.add('oculta');
  atualizarPreview();
});

function atualizarPreview() {
  const destinos = $('campo-destinos').value.split('\n').map(d => d.trim()).filter(Boolean);
  $('preview-nome').textContent = $('campo-nome').value || '—';
  $('preview-grupos').textContent = destinos.length;
  const nomeImagem = imagemSelecionada?.blob?.name || '';
  $('preview-imagem-texto').textContent = imagemSelecionada ? (nomeImagem || 'configurada') : 'não configurada';
  $('preview-texto').textContent = $('campo-texto').value.trim() ? 'configurado' : 'não configurado';
  const min = Math.round(ritmoAtual.minMs / 60000);
  const max = Math.round(ritmoAtual.maxMs / 60000);
  $('preview-intervalo').textContent = `${min}–${max} minutos`;
  $('preview-inicio').textContent = $('campo-agendar').checked
    ? ($('campo-horario').value ? new Date($('campo-horario').value).toLocaleString('pt-BR') : 'horário não definido')
    : 'agora';
  $('botao-postar-agora').disabled = $('campo-agendar').checked || salvandoCampanha;
  $('botao-salvar').disabled = !$('campo-agendar').checked || salvandoCampanha;
}

async function salvarCampanha(modo = 'salvar') {
  if (salvandoCampanha) return;
  salvandoCampanha = true;
  atualizarPreview();
  $('erro-form').classList.add('oculta');
  try {
    const postarAgora = modo === 'agora';
    if (!$('campo-responsabilidade').checked) throw new Error('Confirme que você pode publicar nesses grupos e que a mensagem respeita as regras do grupo.');
    if (postarAgora && $('campo-agendar').checked) throw new Error('Desmarque o agendamento para iniciar agora.');
    if (!postarAgora && !$('campo-agendar').checked) throw new Error('Marque “Agendar publicação” antes de agendar a campanha.');

    const destinos = $('campo-destinos').value.split('\n').map(d => d.trim()).filter(Boolean);
    let agendadoPara = null;
    if (!postarAgora) {
      const data = new Date($('campo-horario').value);
      if (Number.isNaN(data.getTime())) throw new Error('Escolha uma data e um horário válidos para o agendamento.');
      agendadoPara = data.toISOString();
    }
    const estado = await armazenamento.carregarEstado();
    const limites = estado.licenca?.limites || null;
    const dadosCampanha = {
      nome: $('campo-nome').value,
      textos: [$('campo-texto').value],
      destinos,
      destinosOriginais: destinos,
      imagemId: imagemSelecionada ? imagemSelecionada.id : null,
      agendadoPara,
      status: 'ativa'
    };
    const validacao = campanhas.validarCampo(dadosCampanha, limites);
    if (!validacao.ok) throw new Error(validacao.erros.join(' '));
    if (campanhaEditando && (campanhaEditando.status === 'ativa' || campanhaEditando.publicado > 0 || campanhaEditando.falhou > 0)) {
      throw new Error('Esta campanha já foi iniciada. Use “Usar novamente” para criar outra execução sem repetir grupos publicados.');
    }
    const campanha = campanhaEditando
      ? await campanhas.atualizarCampanha(campanhaEditando.id, dadosCampanha)
      : await campanhas.criarCampanha(dadosCampanha, limites);

    if (agendadoPara) {
      await chrome.runtime.sendMessage({ tipo: 'agendar-campanha', campanhaId: campanha.id });
      mostrar('campanhas');
      await renderizarCampanhas();
    } else {
      const inicio = chrome.runtime.sendMessage({ tipo: 'processar-agora' });
      mostrar('campanhas');
      await renderizarCampanhas();
      renderizarStatus(await armazenamento.carregarEstado());
      const resposta = await inicio;
      if (resposta && !resposta.ok) {
        renderizarStatus(await armazenamento.carregarEstado());
        $('detalhe-execucao').textContent = resposta.erro || 'A publicação não foi iniciada.';
      }
    }
  } catch (erro) {
    $('erro-form').textContent = erro.message || 'Não deu para iniciar a campanha.';
    $('erro-form').classList.remove('oculta');
  } finally {
    salvandoCampanha = false;
    atualizarPreview();
  }
}

$('botao-postar-agora').addEventListener('click', () => salvarCampanha('agora'));
$('botao-salvar').addEventListener('click', () => salvarCampanha('salvar'));
$('botao-pausar').addEventListener('click', async () => { await chrome.runtime.sendMessage({ tipo: 'pausar-campanha' }); renderizarStatus(await armazenamento.carregarEstado()); });
$('botao-retomar').addEventListener('click', async () => {
  const estado = await armazenamento.carregarEstado();
  const texto = estado.execucao?.confirmacaoPendente
    ? 'Confira no Facebook se a postagem foi publicada. Ao retomar, este grupo será marcado como não confirmado e ignorado para evitar duplicação. Deseja continuar com os próximos grupos?'
    : 'Retomar a campanha e iniciar os próximos grupos?';
  if (!confirm(texto)) return;
  await chrome.runtime.sendMessage({ tipo: 'retomar-campanha' });
  renderizarStatus(await armazenamento.carregarEstado());
});
$('botao-encerrar').addEventListener('click', async () => { if (!confirm('Encerrar esta campanha? Nenhum novo grupo será publicado.')) return; await chrome.runtime.sendMessage({ tipo: 'encerrar-campanha' }); renderizarStatus(await armazenamento.carregarEstado()); });

carregarResumoLicenca();

setInterval(async () => { try { renderizarStatus(await armazenamento.carregarEstado()); } catch (_) {} }, 3000);
