'use strict';

// Janela "Assinar / Renovar": aberta pelo popup e pela página de opções.
// Mostra o estado da licença e os planos atuais (preços vindos do servidor,
// nunca fixos aqui), encaminha para o checkout da InfinitePay e oferece a
// verificação da liberação (reconciliação) para quando o webhook atrasa.

import * as licenca from '../lib/licenca.js';
import * as armazenamento from '../lib/armazenamento.js';

const $ = id => document.getElementById(id);

let licencaAtual = null;

function formatarData(iso) {
  if (!iso) return '';
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? '' : data.toLocaleDateString('pt-BR');
}

function formatarPreco(centavos) {
  return (Number(centavos || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function periodoDoPlano(plano) {
  return plano.id === 'annual' ? 'ano' : 'mês';
}

// Estado da licença no topo da janela. Devolve false quando não há login,
// para a lista de planos avisar em vez de criar checkout sem conta.
async function pintarLicenca() {
  const estado = await armazenamento.carregarEstado();

  if (!estado.token) {
    licencaAtual = null;
    $('status-assinatura').textContent = 'Você ainda não entrou no Postador Pro.';
    $('detalhes-assinatura').textContent = 'Faça login pelo ícone da extensão no Chrome e abra esta janela de novo para assinar ou renovar.';
    return false;
  }

  try {
    const resultado = await licenca.verificarLicenca(true);
    const estadoAtual = await armazenamento.carregarEstado();
    const lic = estadoAtual.licenca || {};
    licencaAtual = lic;

    if (!resultado.permitido) {
      $('status-assinatura').textContent = 'Licença vencida — assine um plano abaixo para voltar a publicar.';
    } else if (lic.plano === 'pro' && !lic.expiraEm) {
      // Só o administrador tem Pro sem data de fim (o servidor nunca devolve
      // expiraEm para ele); para as demais contas o Pro sempre tem vencimento.
      $('status-assinatura').textContent = 'Conta de administrador: acesso Pro permanente.';
    } else if (lic.plano === 'pro') {
      $('status-assinatura').textContent = `Plano Pro ativo até ${formatarData(lic.expiraEm)}.`;
    } else {
      $('status-assinatura').textContent = `Avaliação gratuita até ${formatarData(lic.avaliacaoAte)}.`;
    }

    if (lic.limites) {
      const ia = Number(lic.limites.iaGeracoesDia) ? ` Gerações de texto com IA: ${lic.limites.iaGeracoesDia} por dia.` : '';
      $('detalhes-assinatura').textContent = `Limites do plano: ${lic.limites.gruposPorDia} grupos por dia, ${lic.limites.campanhasAtivas} campanhas ativas e ${lic.limites.destinosPorCampanha} destinos por campanha.${ia}`;
    }
    return true;
  } catch (_) {
    licencaAtual = null;
    $('status-assinatura').textContent = 'Sem conexão com o servidor.';
    $('detalhes-assinatura').textContent = 'Confira sua internet e abra esta janela de novo.';
    return true;
  }
}

function criarCartaoPlano(plano, limites) {
  const cartao = document.createElement('div');
  cartao.className = 'plano';

  const topo = document.createElement('div');
  topo.className = 'plano-topo';

  const nome = document.createElement('strong');
  nome.textContent = plano.id === 'annual' ? 'Plano anual' : 'Plano mensal';
  topo.appendChild(nome);

  const preco = document.createElement('span');
  preco.className = 'preco';
  preco.textContent = `${formatarPreco(plano.preco)} / ${periodoDoPlano(plano)}`;
  topo.appendChild(preco);

  cartao.appendChild(topo);

  const renovacao = Boolean(licencaAtual && licencaAtual.plano === 'pro' && licencaAtual.expiraEm);
  // O plano do servidor traz os dias de validade; se a API estiver numa versão
  // que ainda não devolve esse campo, usa o valor conhecido do plano.
  const dias = Number(plano.dias) || (plano.id === 'annual' ? 365 : 30);

  const suave = document.createElement('p');
  suave.className = 'suave';
  let detalhe = `${dias} dias de publicação. `;
  if (plano.id === 'annual') {
    const porMes = Math.round((Number(plano.preco) / dias) * 30);
    detalhe += `Equivale a ${formatarPreco(porMes)} por mês. `;
  }
  detalhe += renovacao
    ? 'Os dias são somados ao vencimento atual.'
    : 'A contagem começa com a confirmação do pagamento.';
  suave.textContent = detalhe;
  cartao.appendChild(suave);

  // Os dois planos são do Postador Pro: o cartão mostra a cota de IA do plano
  // pago, que é maior que a da avaliação.
  const iaPro = limites && limites.pro ? Number(limites.pro.iaGeracoesDia) : 0;
  if (iaPro) {
    const linhaIa = document.createElement('p');
    linhaIa.className = 'suave';
    linhaIa.textContent = `Inclui ${iaPro} gerações de texto com IA por dia.`;
    cartao.appendChild(linhaIa);
  }

  const botao = document.createElement('button');
  botao.type = 'button';
  botao.className = 'botao';
  botao.dataset.plano = plano.id;
  botao.textContent = `${renovacao ? 'Renovar' : 'Assinar'} ${plano.id === 'annual' ? 'anual' : 'mensal'}`;
  cartao.appendChild(botao);

  return cartao;
}

async function carregarPlanos() {
  try {
    const dados = await licenca.carregarPlanos();
    const lista = $('lista-planos');
    lista.textContent = '';

    for (const plano of dados.planos || []) {
      lista.appendChild(criarCartaoPlano(plano, dados.limites));
    }

    if (dados.pago === false) {
      $('carregando-planos').textContent = 'Pagamento indisponível no momento. Fale com o suporte pelo WhatsApp.';
    } else if (!(dados.planos || []).length) {
      $('carregando-planos').textContent = 'Nenhum plano disponível no momento.';
    } else {
      $('carregando-planos').classList.add('oculta');
    }
  } catch (_) {
    $('carregando-planos').textContent = 'Não foi possível carregar os planos agora. Confira sua internet e abra a janela de novo.';
  }
}

document.getElementById('lista-planos').addEventListener('click', async evento => {
  const botao = evento.target.closest('button[data-plano]');
  if (!botao || botao.disabled) return;

  botao.disabled = true;
  $('status-checkout').textContent = 'Gerando o link de pagamento…';

  try {
    const url = await licenca.criarCheckout(botao.dataset.plano);
    $('status-checkout').textContent = 'A página de pagamento abriu em outra aba. Depois de pagar, volte aqui e clique em "Já paguei — verificar liberação".';
    await chrome.tabs.create({ url });
  } catch (erro) {
    $('status-checkout').textContent = erro && erro.status === 401
      ? 'Entre na sua conta pela extensão antes de assinar.'
      : (erro && erro.message) || 'Não consegui gerar o pagamento agora. Tente de novo em instantes.';
  } finally {
    botao.disabled = false;
  }
});

$('botao-verificar').addEventListener('click', async () => {
  $('botao-verificar').disabled = true;
  $('status-verificar').textContent = 'Consultando o servidor…';

  try {
    const dados = await licenca.reconciliar();
    const permitido = Boolean(dados.acesso && dados.acesso.permitido);

    if (permitido) {
      await pintarLicenca();
      $('status-verificar').textContent = dados.aplicados
        ? 'Pagamento identificado e licença liberada!'
        : 'Tudo certo: sua licença está ativa.';
    } else {
      $('status-verificar').textContent = 'Ainda não há um pagamento confirmado para esta conta. Se acabou de pagar, aguarde alguns instantes e tente de novo.';
    }
  } catch (erro) {
    $('status-verificar').textContent = erro && erro.status === 401
      ? 'Entre na sua conta pela extensão antes de verificar.'
      : 'Não consegui falar com o servidor agora. Confira sua internet e tente de novo.';
  } finally {
    $('botao-verificar').disabled = false;
  }
});

$('botao-fechar').addEventListener('click', () => window.close());

async function iniciar() {
  const logado = await pintarLicenca();
  await carregarPlanos();

  if (!logado) {
    for (const botao of document.querySelectorAll('button[data-plano]')) {
      botao.disabled = true;
    }
    $('status-checkout').textContent = 'Entre na sua conta pela extensão para assinar ou renovar.';
  }
}

iniciar();
