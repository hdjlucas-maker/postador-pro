'use strict';

import { CONFIG } from '../lib/config.js';
import * as licenca from '../lib/licenca.js';
import * as armazenamento from '../lib/armazenamento.js';

const $ = id => document.getElementById(id);

const telas = {
  login: $('tela-login'),
  cadastro: $('tela-cadastro'),
  principal: $('tela-principal')
};

function mostrar(tela) {
  for (const chave of Object.keys(telas)) {
    telas[chave].classList.toggle('oculta', chave !== tela);
  }
}

function formatarData(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('pt-BR');
}

function nomePlano(plano) {
  if (plano === 'pro') return 'Pro';
  return 'Avaliação';
}

async function atualizarTelaPrincipal() {
  const estado = await armazenamento.carregarEstado();

  if (!estado.token) {
    mostrar('login');
    return;
  }

  mostrar('principal');

  try {
    const resultado = await licenca.verificarLicenca(true);

    if (!resultado.permitido) {
      $('status-licenca').textContent = 'Licença expirada';
      $('status-licenca').style.color = 'var(--vermelho)';
      $('detalhes-licenca').textContent = 'Assine para voltar a publicar.';
      $('botao-assinar').classList.remove('oculta');
      return;
    }

    const lic = estado.licenca || {};
    const plano = lic.plano === 'pro' ? 'Pro' : 'Avaliação';
    $('status-licenca').textContent = `Plano ${plano}`;
    $('status-licenca').style.color = 'var(--verde)';

    let detalhes = '';
    if (lic.expiraEm) {
      detalhes += `Expira em ${formatarData(lic.expiraEm)}`;
    } else if (lic.avaliacaoAte) {
      detalhes += `Avaliação até ${formatarData(lic.avaliacaoAte)}`;
    }
    if (lic.limites) {
      detalhes += ` · ${lic.limites.gruposPorDia} grupos/dia`;
    }
    $('detalhes-licenca').textContent = detalhes;

    // O botão fica visível para qualquer conta logada: na avaliação ele
    // antecipa a assinatura, no Pro permite renovar e no expirado libera o
    // acesso. Antes ele sumia no plano Pro e não havia como renovar.
    $('botao-assinar').classList.remove('oculta');
  } catch (erro) {
    $('status-licenca').textContent = 'Sem conexão';
    $('status-licenca').style.color = 'var(--texto-suave)';
    $('detalhes-licenca').textContent = 'Verifique sua internet e tente de novo.';
  }
}

$('form-login').addEventListener('submit', async evento => {
  evento.preventDefault();
  $('erro-login').classList.add('oculta');
  try {
    await licenca.login($('login-email').value.trim(), $('login-senha').value);
    await atualizarTelaPrincipal();
    await chrome.runtime.openOptionsPage();
  } catch (erro) {
    $('erro-login').textContent = erro.message || 'Falha no login.';
    $('erro-login').classList.remove('oculta');
  }
});

$('link-cadastro').addEventListener('click', evento => {
  evento.preventDefault();
  mostrar('cadastro');
});

$('link-voltar-login').addEventListener('click', evento => {
  evento.preventDefault();
  mostrar('login');
});

$('form-cadastro').addEventListener('submit', async evento => {
  evento.preventDefault();
  $('erro-cadastro').classList.add('oculta');
  if (!$('cad-consentimento').checked) {
    $('erro-cadastro').textContent = 'Você precisa aceitar os termos de uso.';
    $('erro-cadastro').classList.remove('oculta');
    return;
  }
  try {
    await licenca.cadastro({
      nome: $('cad-nome').value.trim(),
      email: $('cad-email').value.trim(),
      senha: $('cad-senha').value
    });
    await atualizarTelaPrincipal();
    await chrome.runtime.openOptionsPage();
  } catch (erro) {
    $('erro-cadastro').textContent = erro.message || 'Falha ao criar conta.';
    $('erro-cadastro').classList.remove('oculta');
  }
});

$('link-termos').addEventListener('click', evento => {
  evento.preventDefault();
  chrome.tabs.create({ url: `${CONFIG.API_BASE}/termos.html` });
});

$('botao-sair').addEventListener('click', async () => {
  await licenca.sair();
  mostrar('login');
});

// Assinar / Renovar abre a janela da assinatura (planos mensal e anual,
// verificação de pagamento) sem disparar cobrança direto do popup.
$('botao-assinar').addEventListener('click', () => {
  chrome.windows.create({ url: chrome.runtime.getURL('assinar/assinar.html'), type: 'popup', width: 480, height: 760 });
});

$('botao-campanhas').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Ao abrir o popup, mostra o estado atual.
atualizarTelaPrincipal();

// A versão do cabeçalho vem do manifesto; antes era um texto fixo no HTML e
// ficava desatualizado a cada versão publicada.
$('versao').textContent = `v${chrome.runtime.getManifest().version}`;

// Avaliar abre a janela própria da extensão, sem sair da página atual.
$('botao-feedback').addEventListener('click', () => {
  chrome.windows.create({ url: chrome.runtime.getURL('avaliar/avaliar.html'), type: 'popup', width: 480, height: 680 });
});
