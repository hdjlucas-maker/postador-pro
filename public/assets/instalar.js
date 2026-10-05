'use strict';

const { chamar, moeda, limitar } = window.Postador;

async function carregarPlanos() {
  const alvo = document.getElementById('lista-planos');

  try {
    const { planos, avaliacaoDias, limites } = await chamar('/api/extensao/planos', undefined, 'GET');
    const pro = limites && limites.pro ? limites.pro : { gruposPorDia: 300, campanhasAtivas: 50, destinosPorCampanha: 100 };
    const trial = limites && limites.trial ? limites.trial : { gruposPorDia: 10, campanhasAtivas: 3, destinosPorCampanha: 5 };
    const limiteTrial = document.getElementById('limite-trial');
    if (limiteTrial) limiteTrial.textContent = `${trial.gruposPorDia} grupos por dia`;

    document.getElementById('dias-avaliacao').textContent = avaliacaoDias;

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
            <a class="botao largo${anual ? '' : ' secundario'}" href="#como-instalar">Escolher ${plano.nome.replace('Postador Pro ', '')}</a>
          </div>`;
      })
      .join('');
  } catch (erro) {
    alvo.innerHTML = `<div class="cartao"><p>Não deu para carregar os planos agora. Recarregue a página em instantes.</p></div>`;
    throw erro;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  limitar(document.getElementById('email'), 254);
  carregarPlanos().catch(() => {});
});
