'use strict';

const { chamar, moeda, limitar } = window.Postador;

async function carregarPlanos() {
  const alvo = document.getElementById('lista-planos');

  try {
    const { planos, avaliacaoDias, limites } = await chamar('/api/extensao/planos', undefined, 'GET');
    const pro = limites && limites.pro ? limites.pro : { gruposPorDia: 10, campanhasAtivas: 50, destinosPorCampanha: 100 };
    const trial = limites && limites.trial ? limites.trial : { gruposPorDia: 5, campanhasAtivas: 3, destinosPorCampanha: 5 };
    const limiteTrial = document.getElementById('limite-trial');
    if (limiteTrial) limiteTrial.textContent = `${trial.gruposPorDia} grupos por dia`;

    // O elemento é opcional: sem a proteção, uma página sem ele derrubava o
    // carregamento dos planos inteiro (o erro caía no catch abaixo).
    const elementoDias = document.getElementById('dias-avaliacao');
    if (elementoDias) elementoDias.textContent = avaliacaoDias;

    if (!planos || !planos.length) {
      alvo.innerHTML = '<div class="cartao"><p>Nenhum plano disponível no momento.</p></div>';
      return;
    }

    alvo.innerHTML = planos
      .map(plano => {
        const anual = plano.id === 'annual';
        return `
          <div class="cartao plano${anual ? ' destaque' : ''}">
            <h3>${plano.nome}</h3>
            <div class="preco">${moeda(plano.preco)} <span>/ ${anual ? 'ano' : 'mês'}</span></div>
            <ul>
              <li>Até ${pro.gruposPorDia} grupos por dia</li>
              <li>Até ${pro.campanhasAtivas} campanhas ativas</li>
              <li>Até ${pro.destinosPorCampanha} destinos por campanha</li>
              <li>Histórico completo no seu navegador</li>
              <li>Atualizações incluídas</li>
            </ul>
            <button class="botao largo${anual ? '' : ' secundario'}" type="button" data-plano-nome="${plano.nome}" data-plano-preco="${moeda(plano.preco)} / ${anual ? 'ano' : 'mês'}">Escolher ${plano.nome.replace('Postador Pro ', '')}</button>
          </div>`;
      })
      .join('');
  } catch (erro) {
    alvo.innerHTML = `<div class="cartao"><p>Não deu para carregar os planos agora. Recarregue a página em instantes.</p></div>`;
    throw erro;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const modalAceite = document.getElementById('aceite-download');
  const checkboxAceite = document.getElementById('aceite-download-checkbox');
  const botaoAceitar = document.getElementById('aceite-download-confirmar');
  const botaoCancelar = document.getElementById('aceite-download-cancelar');
  const chaveAceite = 'postadorProAceiteDownload-v1';
  let linkPendente = null;
  let aceiteNestaPagina = false;
  try { aceiteNestaPagina = localStorage.getItem(chaveAceite) === 'aceito'; } catch (_) {}

  document.querySelectorAll('a[href^="/downloads/postador-pro.zip"]').forEach(link => {
    link.addEventListener('click', event => {
      if (aceiteNestaPagina) return;
      event.preventDefault();
      linkPendente = link;
      modalAceite.hidden = false;
      checkboxAceite.focus();
    });
  });
  checkboxAceite.addEventListener('change', () => { botaoAceitar.disabled = !checkboxAceite.checked; });
  botaoAceitar.addEventListener('click', () => {
    if (!checkboxAceite.checked || !linkPendente) return;
    aceiteNestaPagina = true;
    try { localStorage.setItem(chaveAceite, 'aceito'); } catch (_) {}
    modalAceite.hidden = true;
    const link = linkPendente;
    linkPendente = null;
    link.click();
  });
  botaoCancelar.addEventListener('click', () => {
    checkboxAceite.checked = false;
    botaoAceitar.disabled = true;
    modalAceite.hidden = true;
    linkPendente?.focus();
    linkPendente = null;
  });
  modalAceite.addEventListener('keydown', event => {
    if (event.key === 'Escape') botaoCancelar.click();
  });

  limitar(document.getElementById('email'), 254);

  // Clicou em "Escolher" num plano: a contratação é dentro da extensão, então
  // o aviso explica o caminho e ja oferece o download. Antes o botao so rolava
  // a pagina ate "Como instalar", parecendo que o clique nao fazia nada.
  const avisoPlano = document.getElementById('aviso-plano');
  const tituloAvisoPlano = document.getElementById('aviso-plano-titulo');
  const detalheAvisoPlano = document.getElementById('aviso-plano-detalhe');
  const botaoAvisoBaixar = document.getElementById('aviso-plano-baixar');
  const botaoAvisoFechar = document.getElementById('aviso-plano-fechar');

  document.getElementById('lista-planos').addEventListener('click', evento => {
    const botao = evento.target.closest('button[data-plano-nome]');
    if (!botao) return;
    const curto = botao.dataset.planoNome.replace('Postador Pro ', '');
    tituloAvisoPlano.textContent = `Assinar o plano ${curto}`;
    detalheAvisoPlano.textContent = `${botao.dataset.planoNome}: ${botao.dataset.planoPreco}.`;
    avisoPlano.hidden = false;
    botaoAvisoBaixar.focus();
  });

  botaoAvisoFechar.addEventListener('click', () => {
    avisoPlano.hidden = true;
  });

  avisoPlano.addEventListener('keydown', evento => {
    if (evento.key === 'Escape') botaoAvisoFechar.click();
  });

  botaoAvisoBaixar.addEventListener('click', () => {
    avisoPlano.hidden = true;
    // Reaproveita o fluxo de download que ja existe (aceite dos termos uma vez
    // e baixa o zip): o aviso so explica, o download e o mesmo da pagina.
    const linkDownload = document.querySelector('a[href^="/downloads/postador-pro.zip"]');
    if (linkDownload) linkDownload.click();
  });

  carregarPlanos().catch(() => {});
});
