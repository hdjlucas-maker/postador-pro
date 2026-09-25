'use strict';

const $ = id => document.getElementById(id);

const estado = {
  me: null,
  config: null,
  contas: [],
  campanhas: [],
  pagina: 'dashboard',
  historico: { page: 1, perPage: 25, accountId: '', status: '' },
  imagens: [],
  edicaoCampanha: null,
  grantUserId: null
};

/* ------------------------------------------------------------------ *
 * Utilidades
 * ------------------------------------------------------------------ */

function esc(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Template tag que escapa tudo por padrão. Use raw() só para HTML já confiável.
function html(strings, ...values) {
  return strings.reduce((saida, parte, indice) => {
    const valor = values[indice - 1];
    let texto = '';

    if (valor == null) texto = '';
    else if (Array.isArray(valor)) texto = valor.join('');
    else if (typeof valor === 'object' && valor.__html !== undefined) texto = valor.__html;
    else texto = esc(valor);

    return saida + texto + parte;
  }, '');
}

function raw(valor) {
  return { __html: String(valor ?? '') };
}

function moeda(centavos) {
  return (Number(centavos || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function dataHora(valor) {
  if (!valor) return '-';
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function cookie(nome) {
  const item = document.cookie.split('; ').find(c => c.startsWith(`${nome}=`));
  return item ? decodeURIComponent(item.slice(nome.length + 1)) : '';
}

let toastTimer;
function toast(mensagem, erro = false) {
  const el = $('toast');
  el.textContent = mensagem;
  el.classList.toggle('error', erro);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), erro ? 6000 : 3500);
}

async function api(url, opcoes = {}) {
  const metodo = (opcoes.method || 'GET').toUpperCase();
  const headers = { ...(opcoes.headers || {}) };

  if (opcoes.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(metodo)) {
    headers['x-csrf-token'] = cookie('postador_csrf');
  }

  const resposta = await fetch(url, {
    method: metodo,
    credentials: 'same-origin',
    headers,
    body: opcoes.body === undefined ? undefined : JSON.stringify(opcoes.body)
  });

  if (optoes.blob) {
    if (!resposta.ok) throw new Error('Falha ao gerar o arquivo.');
    return resposta.blob();
  }

  const tipo = resposta.headers.get('content-type') || '';
  const dados = tipo.includes('application/json') ? await resposta.json() : { erro: await resposta.text() };

  if (!resposta.ok) {
    if (resposta.status === 401 && !url.endsWith('/api/me')) {
      mostrarLogin();
      throw new Error(dados.erro || 'Faça login para continuar.');
    }
    throw new Error(dados.erro || 'Não foi possível concluir a operação.');
  }

  return dados;
}

const BADGES = {
  pendente: ['info', 'Agendado'],
  processando: ['warn', 'Processando'],
  concluido: ['good', 'Publicado'],
  falhou: ['bad', 'Falhou'],
  interrompido: ['warn', 'Interrompido'],
  cancelado: ['muted', 'Cancelado'],
  parcial: ['warn', 'Parcial'],
  pro: ['good', 'PRO'],
  trial: ['info', 'Avaliação'],
  expirado: ['bad', 'Expirado'],
  nao_autenticado: ['muted', 'Sem acesso']
};

function badge(status) {
  const [cor, rotulo] = BADGES[status] || ['muted', status || '—'];
  return html`<span class="badge ${raw(cor)}">${rotulo}</span>`;
}

/* ------------------------------------------------------------------ *
 * Autenticação
 * ------------------------------------------------------------------ */

function mostrarLogin() {
  estado.me = null;
  $('app').classList.add('hidden');
  $('authShell').classList.remove('hidden');
}

function mostrarApp() {
  $('authShell').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('userName').textContent = estado.me.nome;
  $('avatar').textContent = (estado.me.nome || 'P').trim().charAt(0).toUpperCase();
  $('planLabel').textContent =
    estado.me.statusPagamento === 'pro' ? 'PRO' : estado.me.statusPagamento === 'trial' ? 'AVALIAÇÃO' : 'EXPIRADO';
  $('sideUser').textContent = estado.me.email;
  $('navAdmin').hidden = !estado.me.admin;
  $('trialInfo').textContent = `Comece com ${estado.config.trialDias} dias de avaliação. Não pedimos documento.`;
  atualizarBarraTrial();
  renderLimites();
}

function atualizarBarraTrial() {
  const barra = $('trialBar');
  const emTrial = estado.me.statusPagamento === 'trial';

  if (!emTrial) {
    barra.classList.add('hidden');
    return;
  }

  barra.classList.remove('hidden');
  barra.classList.toggle('expired', estado.me.statusPagamento === 'expirado');

  const dias = Math.max(0, Math.ceil((new Date(estado.me.trialFim) - Date.now()) / 86400000));
  $('trialText').textContent = dias > 0 ? `Avaliação gratuita — ${dias} dia(s) restantes` : 'Avaliação encerrada';
  $('trialSub').textContent =
    dias > 0 ? 'Você tem acesso aos recursos da avaliação.' : 'Escolha um plano para continuar usando.';
}

function renderLimites() {
  const l = estado.me?.limites;
  $('planLimitsNote').textContent = l
    ? ` Limites do seu plano: ${l.contas} conta(s) Facebook, ${l.campanhasAtivas} campanha(s) ativa(s) e ${l.destinosPorCampanha} destino(s) por campanha.`
    : '';
}

function trocarAba(modo) {
  $('loginForm').classList.toggle('hidden', modo !== 'login');
  $('registerForm').classList.toggle('hidden', modo !== 'register');
  $('forgotForm').classList.toggle('hidden', modo !== 'forgot');
  $('resetForm').classList.toggle('hidden', modo !== 'reset');
  $('tabLogin').classList.toggle('active', modo === 'login');
  $('tabRegister').classList.toggle('active', modo === 'register');
}

async function entrar(email, senha) {
  const dados = await api('/api/login', { method: 'POST', body: { email, senha: senha ?? $('loginPassword').value } });
  estado.me = dados;
  mostrarApp();
  await carregarTudo();
  toast('Login realizado.');
}

async function registrar(evento) {
  evento.preventDefault();
  try {
    const dados = await api('/api/register', {
      method: 'POST',
      body: {
        nome: $('regName').value,
        email: $('regEmail').value,
        senha: $('regPassword').value
      }
    });
    estado.me = dados;
    mostrarApp();
    await carregarTudo();
    toast(`Conta criada. Seus ${estado.config.trialDias} dias de avaliação começaram.`);
  } catch (erro) {
    toast(erro.message, true);
  }
}

async function sair() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    // encerra a sessão local de qualquer forma
  }
  location.reload();
}

async function bootstrap() {
  try {
    estado.config = await api('/api/config');
  } catch {
    estado.config = { trialDias: 7 };
  }

  const params = new URLSearchParams(location.search);

  if (params.get('token')) {
    trocarAba('reset');
    mostrarLogin();
    return;
  }

  try {
    estado.me = await api('/api/me');
    mostrarApp();
    await carregarTudo();

    if (params.get('pagamento') === 'retorno') {
      await conferirPagamento();
    }
  } catch {
    mostrarLogin();
  }
}

async function conferirPagamento() {
  toast('Confirmando seu pagamento...');
  try {
    const r = await api('/api/billing/reconciliar', { method: 'POST', body: {} });
    if (r.aplicados > 0) {
      toast('Pagamento confirmado. Seu acesso já está liberado.');
    } else {
      toast('O pagamento ainda não foi confirmado. Atualizando em alguns segundos...');
    }
    estado.me = await api('/api/me');
    mostrarApp();
    await carregarTudo();

    if (r.aplicados === 0) {
      setTimeout(async () => {
        const s = await api('/api/billing/reconciliar', { method: 'POST', body: {} }).catch(() => null);
        if (s?.aplicados > 0) {
          estado.me = await api('/api/me');
          mostrarApp();
          await carregarTudo();
          toast('Pagamento confirmado.');
        }
      }, 12000);
    }
  } catch (erro) {
    toast(erro.message, true);
  }
}

/* ------------------------------------------------------------------ *
 * Navegação
 * ------------------------------------------------------------------ */

function irPara(pagina) {
  estado.pagina = pagina;
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  $(`page-${pagina}`).classList.add('active');
  document.querySelectorAll('#nav button').forEach(el => el.classList.toggle('active', el.dataset.page === pagina));
  $('pageHint').textContent = pagina === 'admin' ? 'Operação do sistema' : 'Central de campanhas e publicações';

  if (pagina === 'history') carregarHistorico();
  if (pagina === 'admin') carregarAdmin();
  if (pagina === 'subscription') carregarAssinatura();
}

async function carregarTudo() {
  const precisaAcesso = estado.me.statusPagamento === 'pro' || estado.me.statusPagamento === 'trial';
  const tarefas = [carregarDashboard()];

  if (precisaAcesso) {
    tarefas.push(carregarContas(), carregarCampanhas());
  } else {
    estado.contas = [];
    estado.campanhas = [];
    $('accountsList').innerHTML = '<div class="card empty">Escolha um plano para conectar contas do Facebook.</div>';
    $('campaignTable').innerHTML = '<tr><td colspan="6" class="empty">Escolha um plano para criar campanhas.</td></tr>';
  }

  tarefas.push(carregarAssinatura());
  await Promise.all(tarefas);
  atualizarBarraTrial();
}

async function carregarDashboard() {
  if (estado.me.statusPagamento === 'expired') return;
  try {
    const d = await api('/api/dashboard');
    $('sCampaigns').textContent = d.totalCampanhas;
    $('sScheduled').textContent = d.agendadas;
    $('sDone').textContent = d.concluidas;
    $('sFailed').textContent = d.falhas + d.interrompidas;

    $('upcoming').innerHTML = d.proximas.length
      ? d.proximas
          .map(
            x => html`<div class="listItem">
              <div><strong>${x.nome}</strong><div class="small">${x.destinos} destino(s)</div></div>
              <div class="small">${dataHora(x.dataExecucao)}</div>
            </div>`
          )
          .join('')
      : '<div class="empty">Nenhuma publicação agendada.</div>';

    $('fbSummary').innerHTML = html`<div style="font-size:28px;font-weight:800">${d.contasConectadas} / ${d.contas}</div>
      <div class="small">conta(s) pronta(s) — limite do plano: ${d.limiteContas}</div>`;
  } catch (erro) {
    if (erro.message.includes('expirou')) estado.me.statusPagamento = 'expired';
  }
}

async function carregarContas() {
  try {
    const d = await api('/api/facebook/accounts');
    estado.contas = d.accounts;

    $('accountsList').innerHTML = d.accounts.length
      ? d.accounts
          .map(
            a => html`<div class="card account">
              <div class="accountMain">
                <div class="fbIcon">f</div>
                <div>
                  <strong>${a.nome}</strong>
                  <div class="small">${a.browserOpen ? 'Janela do Facebook aberta no servidor.' : 'Janela fechada. O perfil continua salvo.'}</div>
                </div>
              </div>
              <div class="actions">
                ${raw(a.conectada ? '<span class="badge good">Conectada</span>' : '<span class="badge warn">Aguardando login</span>')}
                <button class="btn ghost small" type="button" data-acao="reabrir" data-id="${a.id}">Reabrir janela</button>
                <button class="btn ghost small" type="button" data-acao="renomearConta" data-id="${a.id}" data-nome="${a.nome}">Renomear</button>
                <button class="btn danger small" type="button" data-acao="desconectar" data-id="${a.id}">Desconectar</button>
              </div>
            </div>`
          )
          .join('')
      : '<div class="card empty">Nenhuma conta cadastrada. Clique em “Conectar Facebook”.</div>';

    const select = $('cAccount');
    select.innerHTML = d.accounts.length
      ? d.accounts.map(a => `<option value="${esc(a.id)}">${esc(a.nome)}${a.conectada ? '' : ' (aguardando login)'}</option>`).join('')
      : '<option value="">Conecte uma conta primeiro</option>';
  } catch (erro) {
    if (!erro.message.includes('expirou')) toast(erro.message, true);
  }

  const filtro = $('historyAccount');
  const atual = estado.historico.accountId;
  filtro.innerHTML =
    '<option value="">Todas as contas</option>' +
    estado.contas.map(a => `<option value="${esc(a.id)}">${esc(a.nome)}</option>`).join('');
  filtro.value = atual;
}

/* ------------------------------------------------------------------ *
 * Campanhas
 * ------------------------------------------------------------------ */

function botoesCampanha(c) {
  const acoes = [];

  if (c.status === 'pendente') {
    acoes.push(`<button class="btn ghost small" type="button" data-acao="editarCampanha" data-id="${esc(c.id)}">Editar</button>`);
  }
  if (['pendente', 'processando'].includes(c.status)) {
    acoes.push(`<button class="btn ghost small" type="button" data-acao="cancelarCampanha" data-id="${esc(c.id)}">Cancelar</button>`);
  }
  if (['falhou', 'interrompido', 'parcial'].includes(c.status)) {
    acoes.push(`<button class="btn ghost small" type="button" data-acao="reprocessarCampanha" data-id="${esc(c.id)}">Reprocessar</button>`);
  }
  acoes.push(`<button class="btn danger small" type="button" data-acao="excluirCampanha" data-id="${esc(c.id)}">Excluir</button>`);

  return acoes.join('');
}

async function carregarCampanhas() {
  try {
    const d = await api('/api/campaigns?perPage=100');
    estado.campanhas = d.campanhas;

    $('campaignTable').innerHTML = d.campanhas.length
      ? d.campanhas
          .map(
            c => html`<tr>
              <td><strong>${c.nome}</strong><div class="small">${c.textos.length} texto(s) · ${c.nImagens} imagem(ns)</div></td>
              <td>${c.conta}</td>
              <td>${c.destinos}</td>
              <td class="nowrap">${dataHora(c.dataExecucao)}</td>
              <td>${raw(badge(c.status))}</td>
              <td><div class="actions">${raw(botoesCampanha(c))}</div></td>
            </tr>`
          )
          .join('')
      : '<tr><td colspan="6" class="empty">Nenhuma campanha criada.</td></tr>';
  } catch (erro) {
    if (!erro.message.includes('expirou')) toast(erro.message, true);
  }
}

function abrirCampanha(campanha) {
  estado.edicaoCampanha = campanha || null;
  estado.imagens = campanha ? (campanha.imagens || []).map(nome => ({ nome, url: `/api/uploads/${nome}` })) : [];

  $('cNome').value = campanha?.nome || '';
  $('cDestinos').value = (campanha?.destinos || []).join('\n');
  $('cTexto').value = (campanha?.textos || [])[0] || '';
  $('cImagensInput').value = '';
  $('cTextosExtras').innerHTML = '';

  (campanha?.textos || []).slice(1).forEach(() => adicionarTexto());

  if (campanha) {
    $('cAccount').value = campanha.accountId;
    const d = new Date(campanha.dataExecucao);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    $('cData').value = local.toISOString().slice(0, 16);
  } else {
    const daqui = new Date(Date.now() + 30 * 60000);
    const local = new Date(daqui.getTime() - daqui.getTimezoneOffset() * 60000);
    $('cData').value = local.toISOString().slice(0, 16);
  }

  $('campaignModalTitle').textContent = campanha ? 'Editar campanha' : 'Nova campanha';
  $('cSubmitBtn').textContent = campanha ? 'Salvar alterações' : 'Criar campanha';
  $('cLimiteInfo').textContent = `Até ${estado.me?.limites?.destinosPorCampanha || 0} destinos e ${estado.me?.limites?.campanhasAtivas || 0} campanhas ativas.`;

  renderImagens();
  $('campaignModal').classList.add('show');
}

function adicionarTexto() {
  const div = document.createElement('div');
  div.className = 'field';
  div.innerHTML =
    '<label>Variação de texto</label>' +
    '<div style="display:flex;gap:8px;align-items:flex-start">' +
    '<textarea required placeholder="Outra opção de texto"></textarea>' +
    '<button type="button" class="btn ghost" data-acao="removerTexto">Remover</button>' +
    '</div>';
  $('cTextosExtras').appendChild(div);
}

function renderImagens() {
  $('cImagensList').innerHTML = estado.imagens
    .map(
      (img, i) => html`<div class="imgChip">
        <img src="${img.url}" alt="">
        <div><div class="small">${img.nome.slice(0, 8)}...</div></div>
        <button type="button" class="btn danger small" data-acao="removerImagem" data-i="${i}">×</button>
      </div>`
    )
    .join('');
}

async function enviarImagens(arquivos) {
  for (const arquivo of arquivos) {
    if (arquivo.size > 8 * 1024 * 1024) {
      toast(`"${arquivo.name}" passa de 8 MB e foi ignorado.`, true);
      continue;
    }

    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const leitor = new FileReader();
        leitor.onload = () => resolve(leitor.result);
        leitor.onerror = () => reject(new Error('Falha ao ler a imagem'));
        leitor.readAsDataURL(arquivo);
      });

      const up = await api('/api/uploads', { method: 'POST', body: { data: dataUrl } });
      estado.imagens.push({ nome: up.nome, url: up.url });
    } catch (erro) {
      toast(`${arquivo.name}: ${erro.message}`, true);
    }
  }

  renderImagens();
}

async function salvarCampanha(evento) {
  evento.preventDefault();

  const destinos = $('cDestinos').value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const textos = [
    $('cTexto').value.trim(),
    ...Array.from($('cTextosExtras').querySelectorAll('textarea')).map(t => t.value.trim())
  ].filter(Boolean);

  if (!destinos.length) return toast('Adicione pelo menos um destino.', true);
  if (!textos.length) return toast('Adicione pelo menos um texto.', true);

  const valorData = $('cData').value;
  if (!valorData) return toast('Escolha data e hora.', true);

  const payload = {
    nome: $('cNome').value,
    accountId: $('cAccount').value,
    destinos,
    textos,
    imagens: estado.imagens.map(i => i.nome),
    dataExecucao: new Date(valorData).toISOString()
  };

  $('cSubmitBtn').disabled = true;

  try {
    if (estado.edicaoCampanha) {
      await api(`/api/campaigns/${estado.edicaoCampanha.id}`, { method: 'PUT', body: payload });
      toast('Campanha atualizada.');
    } else {
      await api('/api/campaigns', { method: 'POST', body: payload });
      toast('Campanha criada.');
    }
    $('campaignModal').classList.remove('show');
    await carregarTudo();
  } catch (erro) {
    toast(erro.message, true);
  } finally {
    $('cSubmitBtn').disabled = false;
  }
}

async function acaoCampanha(acao, id) {
  const campanhas = { editarCampanha: 'editar', cancelarCampanha: 'cancelar', reprocessarCampanha: 'reprocessar', excluirCampanha: 'excluir' };
  const tipo = campanhas[acao];

  if (tipo === 'editar') {
    const campanha = estado.campanhas.find(c => c.id === id);
    if (campanha) abrirCampanha(campanha);
    return;
  }

  const confirmacoes = {
    cancelar: 'Cancelar esta campanha? Os destinos ainda não publicados serão cancelados.',
    reprocessar: 'Reenviar os destinos com falha ou interrompidos? Eles serão publicados novamente em instantes.',
    excluir: 'Excluir esta campanha e todo o histórico dos destinos dela? Essa ação não pode ser desfeita.'
  };

  if (!confirm(confirmacoes[tipo])) return;

  try {
    if (tipo === 'cancelar') await api(`/api/campaigns/${id}/cancel`, { method: 'POST', body: {} });
    if (tipo === 'reprocessar') await api(`/api/campaigns/${id}/retry`, { method: 'POST', body: {} });
    if (tipo === 'excluir') await api(`/api/campaigns/${id}`, { method: 'DELETE' });

    toast({ cancelar: 'Campanha cancelada.', reprocessar: 'Campanha reenviada para a fila.', excluir: 'Campanha excluída.' }[tipo]);
    await carregarTudo();
  } catch (erro) {
    toast(erro.message, true);
  }
}

/* ------------------------------------------------------------------ *
 * Contas Facebook
 * ------------------------------------------------------------------ */

function abrirModalConta() {
  $('contaNome').value = '';
  $('accountModal').classList.add('show');
}

async function conectarConta(evento) {
  evento.preventDefault();
  const botao = evento.target.querySelector('button[type="submit"]');
  botao.disabled = true;

  try {
    const d = await api('/api/facebook/accounts', { method: 'POST', body: { nome: $('contaNome').value } });
    $('accountModal').classList.remove('show');
    toast(d.mensagem);
    irPara('accounts');
    await carregarContas();
  } catch (erro) {
    toast(erro.message, true);
  } finally {
    botao.disabled = false;
  }
}

async function acaoConta(acao, id, nome) {
  try {
    if (acao === 'reabrir') {
      const d = await api(`/api/facebook/accounts/${id}/reabrir`, { method: 'POST', body: {} });
      toast(d.mensagem);
      await carregarContas();
      return;
    }

    if (acao === 'renomearConta') {
      const novo = prompt('Nome da conta:', nome);
      if (!novo) return;
      await api(`/api/facebook/accounts/${id}`, { method: 'PATCH', body: { nome: novo } });
      toast('Conta renomeada.');
      await carregarTudo();
      return;
    }

    if (acao === 'desconectar') {
      if (!confirm('Desconectar esta conta? A janela será fechada, o perfil local removido e o limite do plano liberado.')) return;
      await api(`/api/facebook/accounts/${id}`, { method: 'DELETE' });
      toast('Conta desconectada.');
      await carregarTudo();
    }
  } catch (erro) {
    toast(erro.message, true);
  }
}

/* ------------------------------------------------------------------ *
 * Histórico
 * ------------------------------------------------------------------ */

async function carregarHistorico() {
  const h = estado.historico;
  const query = new URLSearchParams({ page: h.page, perPage: h.perPage });
  if (h.accountId) query.set('accountId', h.accountId);
  if (h.status) query.set('status', h.status);

  try {
    const d = await api(`/api/history?${query}`);

    $('historyTable').innerHTML = d.posts.length
      ? d.posts
          .map(
            p => html`<tr>
              <td class="nowrap">${dataHora(p.dataExecucao)}</td>
              <td>${p.campanha || '-'}</td>
              <td>${p.conta || '-'}</td>
              <td style="max-width:260px;word-break:break-all">${p.destino}</td>
              <td>${raw(badge(p.status))}</td>
              <td>${p.motivo || ''}</td>
            </tr>`
          )
          .join('')
      : '<tr><td colspan="6" class="empty">Ainda não há histórico.</td></tr>';

    $('historyPagination').innerHTML = d.total
      ? html`<span class="small muted">Página ${d.page} de ${d.totalPages} · ${d.total} registro(s)</span>
        <div class="actions">
          <button class="btn ghost small" type="button" data-acao="pagina" data-pagina="${d.page - 1}" ${raw(d.page <= 1 ? 'disabled' : '')}>← Anterior</button>
          <button class="btn ghost small" type="button" data-acao="pagina" data-pagina="${d.page + 1}" ${raw(d.page >= d.totalPages ? 'disabled' : '')}>Próxima →</button>
        </div>`
      : '';

    $('historyPagination').className = 'pager';
  } catch (erro) {
    if (!erro.message.includes('expirou')) toast(erro.message, true);
  }
}

function exportarCsv() {
  const query = new URLSearchParams();
  if (estado.historico.accountId) query.set('accountId', estado.historico.accountId);
  if (estado.historico.status) query.set('status', estado.historico.status);
  location.href = `/api/history/export.csv?${query}`;
}

/* ------------------------------------------------------------------ *
 * Assinatura
 * ------------------------------------------------------------------ */

async function carregarAssinatura() {
  try {
    const s = await api('/api/subscription');

    $('currentPlan').innerHTML = html`<div class="account">
      <div>
        <div class="small">Situação atual</div>
        <h3 style="margin:5px 0">${s.nome}</h3>
        <div class="small">${s.descricao}</div>
      </div>
      <div>
        ${raw(s.ativo ? '<span class="badge good">Ativo</span>' : '<span class="badge bad">Precisa de assinatura</span>')}
        ${raw(s.ultimoPagamento ? `<div class="small" style="margin-top:8px">Último pagamento: ${dataHora(s.ultimoPagamento.data)}</div>` : '')}
      </div>
    </div>`;

    $('planGrid').innerHTML = (estado.config?.planos || [])
      .map(
        plano => html`<div class="plan ${raw(plano.id === 'annual' ? 'highlight' : '')}">
          <h3>${plano.nome.replace('Postador Pro ', '')} ${raw(plano.id === 'annual' ? '<span class="badge info">ECONOMIZE</span>' : '')}</h3>
          <div class="price">${moeda(plano.preco)}<span class="small">/${plano.days === 365 ? 'ano' : 'mês'}</span></div>
          <div class="small" style="margin:8px 0 18px">${moeda(Math.round(plano.preco / (plano.days / 30)))}/mês no período pago</div>
          <button class="btn primary block" type="button" data-acao="checkout" data-plano="${plano.id}">Assinar</button>
        </div>`
      )
      .join('');

    $('limitsCard').innerHTML = html`<strong>Limites do seu plano</strong>
      <div class="small" style="margin-top:8px">
        ${s.limites.contas} conta(s) Facebook · ${s.limites.campanhasAtivas} campanha(s) ativa(s) · ${s.limites.destinosPorCampanha} destino(s) por campanha
      </div>`;
  } catch (erro) {
    if (!erro.message.includes('expirou')) toast(erro.message, true);
  }
}

async function checkout(plano) {
  try {
    const d = await api('/api/billing/checkout', { method: 'POST', body: { plano } });
    location.href = d.url;
  } catch (erro) {
    toast(erro.message, true);
  }
}

/* ------------------------------------------------------------------ *
 * Minha conta
 * ------------------------------------------------------------------ */

async function salvarPerfil(evento) {
  evento.preventDefault();
  try {
    estado.me = await api('/api/me', { method: 'PATCH', body: { nome: $('perfilNome').value } });
    mostrarApp();
    toast('Nome atualizado.');
  } catch (erro) {
    toast(erro.message, true);
  }
}

async function salvarSenha(evento) {
  evento.preventDefault();
  try {
    await api('/api/me/senha', {
      method: 'POST',
      body: { senhaAtual: $('senhaAtual').value, novaSenha: $('senhaNova').value }
    });
    evento.target.reset();
    toast('Senha alterada. Entre novamente com a nova senha.');
    setTimeout(() => location.reload(), 1500);
  } catch (erro) {
    toast(erro.message, true);
  }
}

async function exportarDados() {
  try {
    const blob = await api('/api/me/dados', { blob: true });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `postador-dados-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (erro) {
    toast(erro.message, true);
  }
}

async function excluirConta() {
  const senha = prompt('Para confirmar, digite sua senha. Esta ação apaga todos os seus dados.');
  if (!senha) return;
  if (!confirm('Tem certeza? A conta, campanhas, histórico e perfis de navegador serão removidos.')) return;

  try {
    await api('/api/me/excluir', { method: 'POST', body: { senha } });
    location.reload();
  } catch (erro) {
    toast(erro.message, true);
  }
}

/* ------------------------------------------------------------------ *
 * Administração
 * ------------------------------------------------------------------ */

async function carregarAdmin() {
  try {
    const o = await api('/api/admin/overview');

    $('adminOverview').innerHTML = [
      ['Usuários', `${o.usuarios.ativos} / ${o.usuarios.total}`],
      ['Assinantes Pro', o.usuarios.pro],
      ['Campanhas ativas', o.campanhas.ativas],
      ['Publicações pendentes', o.publicacoes.pendentes]
    ]
      .map(([label, valor]) => html`<div class="card"><div class="statLabel">${label}</div><div class="statValue">${valor}</div></div>`)
      .join('');

    await carregarAdminUsuarios();
  } catch (erro) {
    toast(erro.message, true);
  }
}

async function carregarAdminUsuarios() {
  const busca = $('adminBusca').value.trim();
  const query = busca ? `?busca=${encodeURIComponent(busca)}&perPage=50` : '?perPage=50';

  try {
    const d = await api(`/api/admin/users${query}`);
    $('adminTable').innerHTML = d.usuarios.length
      ? d.usuarios
          .map(
            u => html`<tr>
              <td><strong>${u.nome}</strong><div class="small">${u.email}</div></td>
              <td>${u.plano === 'pro' ? u.tipoPlano || 'pro' : 'trial'}${raw(u.bloqueado ? ' <span class="badge bad">bloqueado</span>' : '')}</td>
              <td>${raw(badge(u.status))}</td>
              <td>${u.campanhas} / ${u.contas} contas</td>
              <td><div class="actions">
                <button class="btn ghost small" type="button" data-acao="grant" data-id="${u.id}" data-nome="${u.nome}">Dar acesso</button>
                <button class="btn ghost small" type="button" data-acao="toggleBloqueio" data-id="${u.id}" data-bloqueado="${u.bloqueado}">${raw(u.bloqueado ? 'Desbloquear' : 'Bloquear')}</button>
                <button class="btn danger small" type="button" data-acao="excluirUsuario" data-id="${u.id}">Excluir</button>
              </div></td>
            </tr>`
          )
          .join('')
      : '<tr><td colspan="5" class="empty">Nenhum usuário encontrado.</td></tr>';
  } catch (erro) {
    toast(erro.message, true);
  }
}

async function acaoAdmin(acao, id, nome) {
  try {
    if (acao === 'adminBuscar') return carregarAdminUsuarios();
    if (acao === 'adminBackup') {
      await api('/api/admin/backup', { method: 'POST', body: {} });
      return toast('Backup gerado.');
    }
    if (acao === 'adminPagamentos') {
      const d = await api('/api/admin/payments?perPage=20');
      $('adminPaymentsCard').classList.toggle('hidden');
      $('adminPaymentsTable').innerHTML = d.pagamentos.length
        ? d.pagamentos
            .map(
              p => html`<tr>
                <td class="nowrap">${dataHora(p.criadoEm)}</td>
                <td style="word-break:break-all">${p.order_nsu}</td>
                <td>${p.plano}</td>
                <td>${p.valor ? moeda(p.valor) : '—'}</td>
                <td>${raw(p.status === 'paid' ? '<span class="badge good">pago</span>' : '<span class="badge warn">pendente</span>')}</td>
                <td>${p.origem}</td>
              </tr>`
            )
            .join('')
        : '<tr><td colspan="6" class="empty">Nenhum pagamento registrado.</td></tr>';
      return;
    }
    if (acao === 'grant') {
      estado.grantUserId = id;
      $('grantTitle').textContent = `Dar acesso a ${nome || 'cliente'}`;
      $('grantMotivo').value = '';
      $('grantModal').classList.add('show');
      return;
    }
    if (acao === 'toggleBloqueio') {
      const bloqueado = id && document.querySelector(`[data-acao="toggleBloqueio"][data-id="${id}"]`)?.dataset.bloqueado === 'true';
      await api(`/api/admin/users/${id}/bloqueio`, { method: 'POST', body: { bloqueado: !bloqueado } });
      toast(bloqueado ? 'Usuário desbloqueado.' : 'Usuário bloqueado.');
      return carregarAdmin();
    }
    if (acao === 'excluirUsuario') {
      if (!confirm('Excluir este usuário e todos os dados dele? Essa ação não pode ser desfeita.')) return;
      await api(`/api/admin/users/${id}`, { method: 'DELETE' });
      toast('Usuário excluído.');
      return carregarAdmin();
    }
  } catch (erro) {
    toast(erro.message, true);
  }
}

async function enviarGrant(evento) {
  evento.preventDefault();
  try {
    await api(`/api/admin/users/${estado.grantUserId}/acesso`, {
      method: 'POST',
      body: { dias: Number($('grantDias').value), plano: $('grantPlano').value, motivo: $('grantMotivo').value }
    });
    $('grantModal').classList.remove('show');
    toast('Acesso concedido.');
    await carregarAdmin();
  } catch (erro) {
    toast(erro.message, true);
  }
}

/* ------------------------------------------------------------------ *
 * Eventos
 * ------------------------------------------------------------------ */

function preencherConfig() {
  if (estado.me) {
    $('perfilNome').value = estado.me.nome;
    $('perfilEmail').value = estado.me.email;
  }
}

document.addEventListener('click', async evento => {
  const botao = evento.target.closest('button');
  if (!botao) return;

  if (botao.dataset.page) {
    if (botao.dataset.page === 'subscription') await carregarAssinatura();
    if (botao.dataset.page === 'settings') preencherConfig();
    irPara(botao.dataset.page);
    return;
  }

  const acao = botao.dataset.acao;
  if (!acao) return;

  if (acao === 'logout') return sair();
  if (acao === 'novaCampanha') {
    if (estado.me.statusPagamento === 'expired') {
      toast('Sua avaliação terminou. Escolha um plano.', true);
      return irPara('subscription');
    }
    if (!estado.contas.length) {
      toast('Conecte uma conta do Facebook antes de criar campanhas.', true);
      return irPara('accounts');
    }
    return abrirCampanha(null);
  }
  if (acao === 'fecharCampanha') return $('campaignModal').classList.remove('show');
  if (acao === 'addTexto') return adicionarTexto();
  if (acao === 'removerTexto') return botao.closest('.field').remove();
  if (acao === 'removerImagem') {
    estado.imagens.splice(Number(botao.dataset.i), 1);
    return renderImagens();
  }
  if (acao === 'conectar') return abrirModalConta();
  if (acao === 'fecharContaModal') return $('accountModal').classList.remove('show');
  if (acao === 'fecharGrant') return $('grantModal').classList.remove('show');
  if (acao === 'exportar') return exportarCsv();
  if (acao === 'exportarDados') return exportarDados();
  if (acao === 'excluirConta') return excluirConta();
  if (acao === 'checkout') return checkout(botao.dataset.plano);
  if (acao === 'pagina') {
    estado.historico.page = Math.max(1, Number(botao.dataset.pagina));
    return carregarHistorico();
  }
  if (acao === 'esqueci') return trocarAba('forgot');
  if (acao === 'voltarLogin') return trocarAba('login');

  if (acao.startsWith('editar') || acao.startsWith('cancelar') || acao.startsWith('reprocessar') || acao.startsWith('excluirCampanha')) {
    return acaoCampanha(acao, botao.dataset.id);
  }
  if (['reabrir', 'renomearConta', 'desconectar'].includes(acao)) {
    return acaoConta(acao, botao.dataset.id, botao.dataset.nome);
  }
  if (acao === 'grant' || acao === 'toggleBloqueio' || acao === 'excluirUsuario' || acao.startsWith('admin')) {
    return acaoAdmin(acao, botao.dataset.id, botao.dataset.nome);
  }
});

document.addEventListener('submit', evento => {
  const form = evento.target;

  if (form.id === 'loginForm') {
    evento.preventDefault();
    entrar($('loginEmail').value).catch(erro => toast(erro.message, true));
  }
  if (form.id === 'registerForm') return registrar(evento);
  if (form.id === 'forgotForm') {
    evento.preventDefault();
    api('/api/recuperar-senha', { method: 'POST', body: { email: $('forgotEmail').value } })
      .then(d => {
        toast(d.mensagem);
        if (d.linkDev) toast(`Ambiente sem SMTP: use ${d.linkDev}`, true);
      })
      .catch(erro => toast(erro.message, true));
  }
  if (form.id === 'resetForm') {
    evento.preventDefault();
    const token = new URLSearchParams(location.search).get('token');
    if (!token) {
      toast('Link de redefinição inválido. Peça um novo.', true);
      return;
    }
    api('/api/redefinir-senha', { method: 'POST', body: { token, novaSenha: $('resetPassword').value } })
      .then(() => {
        history.replaceState({}, '', '/');
        trocarAba('login');
        toast('Senha redefinida. Faça login.');
      })
      .catch(erro => toast(erro.message, true));
  }
  if (form.id === 'formCampanha') return salvarCampanha(evento);
  if (form.id === 'formContaNome') return conectarConta(evento);
  if (form.id === 'formGrant') return enviarGrant(evento);
  if (form.id === 'formPerfil') return salvarPerfil(evento);
  if (form.id === 'formSenha') return salvarSenha(evento);
});

document.addEventListener('change', evento => {
  if (evento.target.id === 'historyAccount') {
    estado.historico.accountId = evento.target.value;
    estado.historico.page = 1;
    carregarHistorico();
  }
  if (evento.target.id === 'historyStatus') {
    estado.historico.status = evento.target.value;
    estado.historico.page = 1;
    carregarHistorico();
  }
  if (evento.target.id === 'cImagensInput') {
    enviarImagens(Array.from(evento.target.files || []));
    evento.target.value = '';
  }
});

$('tabLogin').addEventListener('click', () => trocarAba('login'));
$('tabRegister').addEventListener('click', () => trocarAba('register'));

// Atualiza sozinho apenas quando a aba está visível: nada de consumir bateria
// ou banda do servidor com quem está em outra aba.
setInterval(() => {
  if (estado.me && !document.hidden) {
    carregarTudo().catch(() => {});
  }
}, 30000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && estado.me) carregarTudo().catch(() => {});
});

bootstrap();
