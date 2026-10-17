'use strict';

const { chamar, mostrar, esconder, moeda, data, dataHora, limitar, escapar } = window.Postador;

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
      ['Avaliações pendentes', Number(dados.avaliacoes?.pendentes || 0)],
      ['Pagamentos pendentes', Number(p.pendentes || 0)]
    ];

    document.getElementById('metricas').innerHTML = linhas
      .map(
        ([rotulo, valor]) =>
          `<div class="cartao"><div class="metrica">${valor}</div><div class="metrica-rotulo">${rotulo}</div></div>`
      )
      .join('');

    const alertas = [];
    if (!dados.sistema?.email) alertas.push('E-mail não configurado: use o WhatsApp para suporte e redefinição manual.');
    if (!dados.sistema?.pagamento) alertas.push('INFINITEPAY_HANDLE vazio: o checkout não funciona.');
    if (Number(u.bloqueados || 0) > 0) alertas.push(`${u.bloqueados} conta(s) bloqueada(s).`);
    const pendentes = Number(dados.avaliacoes?.pendentes || 0);
    if (pendentes > 0) alertas.push(`${pendentes} avaliação(ões) aguardando aprovação.`);

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
          // A data mostrada é a do vencimento que vale para a conta: plano
          // pago vence em dataExpiracao; avaliação vence em trialFim (inclusive
          // quando já venceu, para não ficar um traço sem informação).
          const dataExpira = user.dataExpiracao || user.trialFim;
          // Administrador nunca expira: mostra "Permanente" e não oferece a
          // renovação de 30 dias (o botão só faz sentido para quem vence).
          const expira = user.admin ? 'Permanente' : data(dataExpira);
          const acoes = [];
          if (!user.admin) acoes.push(`<button class="botao secundario" type="button" data-reiniciar="${user.id}" style="padding:5px 11px;font-size:13px">Renovar 30 dias</button>`);
          acoes.push(`<button class="botao secundario" type="button" data-reset="${user.id}" style="padding:5px 11px;font-size:13px">Gerar senha</button>`);
          return `<tr>
            <td>${escapar(user.email)}${user.admin ? ' <span class="etiqueta pro">admin</span>' : ''}${user.bloqueado ? ' <span class="etiqueta expirado">bloqueado</span>' : ''}</td>
            <td>${escapar(user.nome || '—')}</td>
            <td>${etiqueta(rotulo)}</td>
            <td>${expira}</td>
            <td>${data(user.criadoEm)}</td>
            <td>${acoes.join(' ')}</td>
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
          <td style="font-family:monospace;font-size:12px">${escapar(p.order_nsu || '—')}</td>
          <td>${p.plano || '—'}</td>
          <td>${p.origem === 'admin' ? 'manual' : moeda(p.valor)}</td>
          <td>${p.status || '—'}</td>
          <td>${dataHora(p.criadoEm)}</td>
        </tr>`)
        .join('')
    : '<tr><td colspan="5">Nenhum pagamento registrado.</td></tr>';
}

let avaliacoesPorId = new Map();

function estrelasTxt(nota) {
  const valor = Math.max(0, Math.min(5, Number(nota) || 0));
  return '★'.repeat(valor) + '☆'.repeat(5 - valor);
}

function situacaoAvaliacao(a) {
  if (a.aprovada) return '<span class="etiqueta pro">publicada</span>';
  if (a.nota >= 4) return '<span class="etiqueta expirado">oculta</span>';
  return '<span class="etiqueta trial">pendente</span>';
}

async function carregarAvaliacoes() {
  const dados = await chamar('/api/admin/avaliacoes', undefined, 'GET');
  const lista = Array.isArray(dados.avaliacoes) ? dados.avaliacoes : [];
  avaliacoesPorId = new Map(lista.map(a => [String(a.id), a]));

  document.getElementById('linhas-avaliacoes').innerHTML = lista.length
    ? lista
        .map(a => {
          const cliente = `${escapar(a.nome || '—')}${a.exemplo ? ' <span class="etiqueta trial">exemplo</span>' : ''}` +
            `<br><span style="color:var(--texto-suave);font-size:12px">${escapar(a.email || 'sem conta')}</span>`;

          const acoes = [];
          acoes.push(a.aprovada
            ? `<button class="botao secundario" type="button" data-ocultar="${a.id}" style="padding:5px 11px;font-size:13px">Ocultar</button>`
            : `<button class="botao" type="button" data-aprovar="${a.id}" style="padding:5px 11px;font-size:13px">Aprovar</button>`);
          acoes.push(`<button class="botao secundario" type="button" data-editar="${a.id}" style="padding:5px 11px;font-size:13px">Editar</button>`);
          acoes.push(`<button class="botao secundario" type="button" data-excluir="${a.id}" style="padding:5px 11px;font-size:13px">Excluir</button>`);

          return `<tr>
            <td>${data(a.criadoEm)}</td>
            <td>${cliente}</td>
            <td><span class="nota-avaliacao" title="${a.nota} de 5">${estrelasTxt(a.nota)}</span></td>
            <td data-comentario="${a.id}" style="max-width:340px">${escapar(a.comentario || '—')}</td>
            <td>${situacaoAvaliacao(a)}</td>
            <td>${acoes.join(' ')}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="6">Nenhuma avaliação recebida ainda.</td></tr>';
}

async function recarregar() {
  try {
    await carregarMetricas();
    await carregarUsuarios();
    await carregarAvaliacoes();
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
    await chamar('/api/config', undefined, 'GET');

    const dados = await chamar('/api/login', {
      email: document.getElementById('email').value,
      senha: document.getElementById('senha').value
    });

    // O /api/login devolve o perfil direto (id, nome, email, admin...), sem
    // envelope `usuario`; antes o topo do painel ficava sem o e-mail.
    usuario = dados && dados.email ? dados : null;
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
document.getElementById('recarregar-avaliacoes').addEventListener('click', recarregar);
document.getElementById('recarregar-pagamentos').addEventListener('click', recarregar);

document.getElementById('linhas-usuarios').addEventListener('click', async evento => {
  const botaoReset = evento.target.closest('[data-reset]');
  if (botaoReset) {
    const idReset = botaoReset.getAttribute('data-reset');
    if (!window.confirm('Gerar uma nova senha temporária para este usuário? A senha atual deixará de funcionar.')) return;
    botaoReset.disabled = true;
    try {
      const dados = await chamar(`/api/admin/users/${idReset}/redefinir-senha`, {});
      window.alert(`Senha temporária gerada:\n\n${dados.senhaTemporaria}\n\nEnvie-a ao usuário pelo WhatsApp. Ela não será mostrada novamente.`);
    } catch (erro) {
      mostrar(avisoLogin, erro.message);
    } finally {
      botaoReset.disabled = false;
    }
    return;
  }

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

document.getElementById('linhas-avaliacoes').addEventListener('click', async evento => {
  const aprovar = evento.target.closest('[data-aprovar]');
  const ocultar = evento.target.closest('[data-ocultar]');

  if (aprovar || ocultar) {
    const botao = aprovar || ocultar;
    const id = botao.getAttribute(aprovar ? 'data-aprovar' : 'data-ocultar');
    botao.disabled = true;
    try {
      await chamar(`/api/admin/avaliacoes/${id}/aprovar`, { aprovada: Boolean(aprovar) });
      await recarregar();
    } catch (erro) {
      mostrar(avisoLogin, erro.message);
      botao.disabled = false;
    }
    return;
  }

  const excluir = evento.target.closest('[data-excluir]');
  if (excluir) {
    const id = excluir.getAttribute('data-excluir');
    if (!window.confirm('Excluir esta avaliação de vez?')) return;
    excluir.disabled = true;
    try {
      await chamar(`/api/admin/avaliacoes/${id}`, {}, 'DELETE');
      await recarregar();
    } catch (erro) {
      mostrar(avisoLogin, erro.message);
      excluir.disabled = false;
    }
    return;
  }

  const editar = evento.target.closest('[data-editar]');
  if (editar) {
    const id = editar.getAttribute('data-editar');
    const celula = document.querySelector(`[data-comentario="${id}"]`);
    const atual = avaliacoesPorId.get(String(id))?.comentario || '';
    celula.innerHTML =
      `<textarea id="edicao-avaliacao" maxlength="500" style="width:100%;min-height:70px;font:inherit;padding:8px;border:1px solid var(--borda);border-radius:var(--raio)">${escapar(atual)}</textarea>` +
      `<div style="margin-top:6px"><button class="botao" type="button" data-salvar="${id}" style="padding:5px 11px;font-size:13px">Salvar</button> ` +
      `<button class="botao secundario" type="button" data-cancelar="${id}" style="padding:5px 11px;font-size:13px">Cancelar</button></div>`;
    return;
  }

  const salvar = evento.target.closest('[data-salvar]');
  if (salvar) {
    const id = salvar.getAttribute('data-salvar');
    salvar.disabled = true;
    try {
      await chamar(`/api/admin/avaliacoes/${id}/editar`, { comentario: document.getElementById('edicao-avaliacao').value.trim() });
      await recarregar();
    } catch (erro) {
      mostrar(avisoLogin, erro.message);
      salvar.disabled = false;
    }
    return;
  }

  const cancelar = evento.target.closest('[data-cancelar]');
  if (cancelar) {
    const id = cancelar.getAttribute('data-cancelar');
    const atual = avaliacoesPorId.get(String(id))?.comentario || '';
    document.querySelector(`[data-comentario="${id}"]`).innerHTML = escapar(atual || '—');
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
