'use strict';

const { chamar, mostrar, esconder, moeda, data, dataHora, limitar } = window.Postador;

const formLogin = document.getElementById('form-login');
const conteudo = document.getElementById('conteudo');
const avisoLogin = document.getElementById('aviso-login');
const botaoEntrar = document.getElementById('entrar');
const busca = document.getElementById('busca');

let usuario = null;

function sessaoMostrada(u) {
  formLogin.hidden = true;
  conteudo.hidden = false;
  document.getElementById('sair').hidden = false;
  document.getElementById('identidade').textContent = u ? u.email : '';
}

function etiqueta(estado) {
  if (estado === 'pro') return '<span class="etiqueta pro">Pro</span>';
  if (estado === 'trial') return '<span class="etiqueta trial">Avaliação</span>';
  return '<span class="etiqueta expirado">Expirado</span>';
}

async function carregarMetricas() {
  try {
    const dados = await chamar('/api/admin/overview', undefined, 'GET');
    const u = dados.usuarios || {};
    const p = dados.pagamentos || {};

    const linhas = [
      ['Usuários', Number(u.total || 0)],
      ['Ativos', Number(u.ativos || 0)],
      ['Plano Pro', Number(u.pro || 0)],
      ['Pagamentos pendentes', Number(p.pendentes || 0)]
    ];

    document.getElementById('metricas').innerHTML = linhas
      .map(
        ([rotulo, valor]) =>
          `<div class="cartao"><div class="metrica">${valor}</div><div class="metrica-rotulo">${rotulo}</div></div>`
      )
      .join('');

    const alertas = [];
    if (!dados.sistema?.smtp) alertas.push('SMTP não configurado: recuperação de senha indisponível.');
    if (!dados.sistema?.pagamento) alertas.push('INFINITEPAY_HANDLE vazio: o checkout não funciona.');
    if (Number(u.bloqueados || 0) > 0) alertas.push(`${u.bloqueados} conta(s) bloqueada(s).`);

    if (alertas.length) {
      const caixa = document.getElementById('alertas');
      caixa.textContent = alertas.join(' ');
      caixa.className = 'aviso';
      caixa.style.marginBottom = '20px';
    } else {
      const caixa = document.getElementById('alertas');
      caixa.className = 'aviso';
      caixa.style.display = 'none';
    }
  } catch (erro) {
    if (erro.status === 401 || erro.status === 403) {
      formLogin.hidden = false;
      conteudo.hidden = true;
      document.getElementById('sair').hidden = true;
      return;
    }
    throw erro;
  }
}

async function carregarUsuarios() {
  const termo = busca.value.trim();
  const dados = await chamar(
    `/api/admin/users?perPage=100${termo ? `&busca=${encodeURIComponent(termo)}` : ''}`,
    undefined,
    'GET'
  );
  const lista = Array.isArray(dados.usuarios) ? dados.usuarios : [];

  document.getElementById('linhas-usuarios').innerHTML = lista.length
    ? lista
        .map(user => {
          const rotulo = user.status === 'pro' ? 'pro' : user.status === 'trial' ? 'trial' : 'expirado';
          const dataExpira = user.status === 'trial' ? user.trialFim : user.dataExpiracao;
          return `<tr>
            <td>${user.email}${user.admin ? ' <span class="etiqueta pro">admin</span>' : ''}${user.bloqueado ? ' <span class="etiqueta expirado">bloqueado</span>' : ''}</td>
            <td>${user.nome || '—'}</td>
            <td>${etiqueta(rotulo)}</td>
            <td>${data(dataExpira)}</td>
            <td>${data(user.criadoEm)}</td>
            <td><button class="botao secundario" type="button" data-reiniciar="${user.id}" style="padding:5px 11px;font-size:13px">Renovar 30 dias</button></td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="6">Nenhum usuário encontrado.</td></tr>';
}

async function carregarPagamentos() {
  const dados = await chamar('/api/admin/payments?perPage=50', undefined, 'GET');
  const lista = Array.isArray(dados.pagamentos) ? dados.pagamentos : [];

  document.getElementById('linhas-pagamentos').innerHTML = lista.length
    ? lista
        .map(p => `<tr>
          <td style="font-family:monospace;font-size:12px">${p.order_nsu || '—'}</td>
          <td>${p.plano || '—'}</td>
          <td>${p.origem === 'admin' ? 'manual' : moeda(p.valor)}</td>
          <td>${p.status || '—'}</td>
          <td>${dataHora(p.criadoEm)}</td>
        </tr>`)
        .join('')
    : '<tr><td colspan="5">Nenhum pagamento registrado.</td></tr>';
}

async function recarregar() {
  try {
    await carregarMetricas();
    await carregarUsuarios();
    await carregarPagamentos();
  } catch (erro) {
    if (erro.status !== 401 && erro.status !== 403) mostrar(avisoLogin, erro.message);
  }
}

formLogin.addEventListener('submit', async evento => {
  evento.preventDefault();
  esconder(avisoLogin);
  botaoEntrar.disabled = true;
  botaoEntrar.textContent = 'Entrando…';

  try {
    const dados = await chamar('/api/login', {
      email: document.getElementById('email').value,
      senha: document.getElementById('senha').value
    });

    usuario = dados.usuario || null;
    sessaoMostrada(usuario);
    await recarregar();
  } catch (erro) {
    mostrar(avisoLogin, erro.message);
  } finally {
    botaoEntrar.disabled = false;
    botaoEntrar.textContent = 'Entrar';
  }
});

document.getElementById('sair').addEventListener('click', async () => {
  try {
    await chamar('/api/logout', {});
  } catch {
    // Encerrar sessão local é o essencial; erro do servidor não impede sair.
  }
  window.location.reload();
});

document.getElementById('atualizar').addEventListener('click', recarregar);
document.getElementById('recarregar-pagamentos').addEventListener('click', recarregar);

document.getElementById('linhas-usuarios').addEventListener('click', async evento => {
  const botao = evento.target.closest('[data-reiniciar]');
  if (!botao) return;

  const id = botao.getAttribute('data-reiniciar');
  if (!window.confirm('Conceder mais 30 dias de acesso a este usuário?')) return;

  botao.disabled = true;

  try {
    await chamar(`/api/admin/users/${id}/acesso`, { dias: 30, plano: 'monthly', motivo: 'Renovação pelo painel' });
    await recarregar();
  } catch (erro) {
    mostrar(avisoLogin, erro.message);
    botao.disabled = false;
  }
});

let atrasoBusca = null;
busca.addEventListener('input', () => {
  clearTimeout(atrasoBusca);
  atrasoBusca = setTimeout(() => carregarUsuarios().catch(() => {}), 300);
});

window.addEventListener('DOMContentLoaded', async () => {
  limitar(document.getElementById('email'), 254);
  limitar(busca, 254);

  // Sessão de cookie já existente: tenta abrir o painel direto.
  try {
    await chamar('/api/admin/overview', undefined, 'GET');
    sessaoMostrada(null);
    await recarregar();
  } catch (erro) {
    if (erro.status === 401 || erro.status === 403) mostrar(avisoLogin, 'Entre com uma conta de administrador.');
  }
});
