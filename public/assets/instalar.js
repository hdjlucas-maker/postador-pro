'use strict';

const { chamar, moeda, limitar } = window.Postador;

async function carregarPlanos() {
  const alvo = document.getElementById('lista-planos');

  try {
    const { planos, avaliacaoDias } = await chamar('/api/extensao/planos', undefined, 'GET');

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
            <div class="preco">${moeda(plano.preco)} <span>/ ${plano.dias} dias</span></div>
            <ul>
              <li>Até ${plano.dias} dias de acesso</li>
              <li>Todos os grupos que você selecionar</li>
              <li>Agendamento com ritmo controlado</li>
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
