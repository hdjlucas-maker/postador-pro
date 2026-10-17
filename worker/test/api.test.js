import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

// A origem da extensão precisa ter as 32 letras do Chrome e estar na
// `EXTENSAO_IDS` do `vitest.config.mjs`, senão o CORS e a allowlist de origem
// rejeitam antes de chegar na rota.
const ORIGEM = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const OUTRA_ORIGEM = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba';

const BASE = 'https://api.postador.test';

// Recebe o `Headers` da resposta (é assim que os testes chamam), e não a
// resposta inteira. `getSetCookie` devolve um item por cookie, sem precisar
// quebrar a string por vírgula.
function cookies(headers) {
  return headers
    .getSetCookie()
    .map(parte => parte.split(';')[0].trim())
    .filter(Boolean);
}

function parDe(headers) {
  const mapa = new Map();
  for (const par of cookies(headers)) {
    const indice = par.indexOf('=');
    mapa.set(par.slice(0, indice), par.slice(indice + 1));
  }
  return mapa;
}

// Cabeçalho `Cookie` com sessão e CSRF, como o navegador devolveria. O servidor
// só aceita escrita com os dois: o cookie de CSRF e o header com o mesmo valor.
function cookieDe(headers) {
  const mapa = parDe(headers);
  return `postador_session=${mapa.get('postador_session')}; postador_csrf=${mapa.get('postador_csrf')}`;
}

let ipSeq = 0;
const novoIp = () => `10.1.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

// Um navegador de verdade manda `Origin` em toda escrita e, antes de escrever,
// já recebeu o cookie de CSRF de `GET /api/config`. O helper reproduz os dois
// passos, senão o servidor (corretamente) barra a chamada.
//
// - Quem passa `Cookie` está montando a requisição à mão (é o caso dos testes
//   de CSRF), então o helper não acrescenta o par cookie + header.
// - Rotas de `/extensao/` não usam cookie: o helper também não acrescenta.
// - Cada chamada sai de um IP diferente (`cf-connecting-ip`), para que o limite
//   de cadastro de um teste não derrube o teste seguinte. Os testes de limite
//   fixam o IP de propósito.
async function post(caminho, corpo, cabecalhos = {}) {
  const cabecalhosFinais = {
    'Content-Type': 'application/json',
    Origin: BASE,
    'cf-connecting-ip': novoIp(),
    ...cabecalhos
  };

  const precisaCsrf = !caminho.startsWith('/api/extensao/') && !cabecalhosFinais.Cookie;
  if (precisaCsrf) {
    const config = await SELF.fetch(`${BASE}/api/config`, {
      headers: { 'cf-connecting-ip': cabecalhosFinais['cf-connecting-ip'] }
    });
    const token = parDe(config.headers).get('postador_csrf');
    cabecalhosFinais.Cookie = `postador_csrf=${token}`;
    cabecalhosFinais['x-csrf-token'] = token;
  }

  return SELF.fetch(`${BASE}${caminho}`, {
    method: 'POST',
    headers: cabecalhosFinais,
    body: JSON.stringify(corpo)
  });
}

function tokenCsrf(rotas) {
  return parDe(rotas).get('postador_csrf');
}

describe('API do Postador Pro sobre Workers + D1', () => {
  let seq = 0;
  const novoEmail = () => `cliente${Date.now()}${seq++}@postador.pro`;

  beforeAll(() => {
    // Garante que `sistema` exista antes do health, que mede o tempo desde a
    // instalação.
    return env.DB.prepare('INSERT OR IGNORE INTO sistema (id, instalado_em, versao) VALUES (1, ?, ?)')
      .bind(new Date().toISOString(), 'teste')
      .run();
  });

  it('responde ao health sem exigir nada', async () => {
    const resposta = await SELF.fetch('https://api.postador.test/api/health');
    const dados = await resposta.json();

    expect(resposta.status).toBe(200);
    expect(dados.ok).toBe(true);
    expect(typeof dados.uptime).toBe('number');
  });

  it('serve a interface em /', async () => {
    const resposta = await SELF.fetch('https://api.postador.test/');
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get('content-type')).toContain('text/html');
  });

  it('cria conta, faz login e devolve a licença', async () => {
    const email = novoEmail();
    const cadastro = await post('/api/register', { nome: 'Ana Souza', email, senha: 'senha-super-segura' });
    const corpoCadastro = await cadastro.json();

    expect(cadastro.status).toBe(201);
    // A linha de cima é a que quebrava: `users_inserir` devolvia o objeto errado
    // e o perfil saía sem id, sem e-mail e sem plano.
    expect(corpoCadastro.id).toBeTruthy();
    expect(corpoCadastro.email).toBe(email);
    expect(corpoCadastro.plano).toBe('trial');
    expect(corpoCadastro.admin).toBe(false);
    expect(corpoCadastro.limites.gruposPorDia).toBe(5);

    const rotas = parDe(cadastro.headers);
    expect(rotas.get('postador_session')).toBeTruthy();
    expect(rotas.get('postador_csrf')).toBeTruthy();

    const login = await post('/api/login', { email, senha: 'senha-super-segura' }, {
      Cookie: cookieDe(cadastro.headers),
      'x-csrf-token': rotas.get('postador_csrf')
    });
    expect(login.status).toBe(200);
  });

  it('recusa e-mail repetido com 409', async () => {
    const email = novoEmail();
    const corpo = { nome: 'Bruno Lima', email, senha: 'senha-super-segura' };

    expect((await post('/api/register', corpo)).status).toBe(201);
    const segunda = await post('/api/register', corpo);
    expect(segunda.status).toBe(409);
  });

  it('recusa senha curta e e-mail inválido', async () => {
    const curta = await post('/api/register', { nome: 'Carla', email: novoEmail(), senha: '123' });
    expect(curta.status).toBe(400);

    const email = await post('/api/register', { nome: 'Carla', email: 'nao-e-email', senha: 'senha-super-segura' });
    expect(email.status).toBe(400);
  });

  it('não diz qual campo falhou no login', async () => {
    const email = novoEmail();
    await post('/api/register', { nome: 'Diego Alves', email, senha: 'senha-super-segura' });

    const resposta = await post('/api/login', { email, senha: 'senha-errada-qualquer' });
    const dados = await resposta.json();

    expect(resposta.status).toBe(401);
    // A mensagem é genérica de propósito: distinguir "e-mail não existe" de
    // "senha errada" revelaria quem tem conta.
    expect(dados.erro).toBe('E-mail ou senha incorretos.');
  });

  it('bloqueia a conta depois de LOGIN_FALHAS_MAX tentativas', async () => {
    const email = novoEmail();
    await post('/api/register', { nome: 'Elena Prado', email, senha: 'senha-super-segura' });

    for (let tentativa = 0; tentativa < 8; tentativa += 1) {
      await post('/api/login', { email, senha: `errada-${tentativa}` });
    }

    const travada = await post('/api/login', { email, senha: 'senha-super-segura' });
    const dados = await travada.json();

    expect(travada.status).toBe(429);
    expect(dados.codigo).toBe('conta_bloqueada');
  });

  it('limita o cadastro por rate limit no D1', async () => {
    const respostas = [];
    for (let i = 0; i < 7; i += 1) {
      // IP fixo de propósito: o limite de cadastro é por IP.
      respostas.push(await post(
        '/api/register',
        { nome: 'Teste Limite', email: novoEmail(), senha: 'senha-super-segura' },
        { 'cf-connecting-ip': '10.9.9.9' }
      ));
    }

    // `RATE_LIMIT_REGISTRO` é 5 na configuração de teste.
    expect(respostas.filter(r => r.status === 429).length).toBeGreaterThanOrEqual(1);
  });

  it('mantém o contador de rate limit entre requisições', async () => {
    // Guarda contra o bug da expurgação por bucket: a limpeza não pode apagar
    // uma janela viva, senão o limite nunca fecha.
    const chave = 'teste:persistencia:900';
    const primeira = await env.DB.prepare(
      `INSERT INTO rate_limits (chave, janela, contagem, expira_em) VALUES (?, 1, 1, ?)`,
    )
      .bind(chave, new Date(Date.now() + 900000).toISOString())
      .run();
    expect(primeira.success).toBe(true);

    const limpeza = await env.DB.prepare('DELETE FROM rate_limits WHERE expira_em <= ?')
      .bind(new Date().toISOString())
      .run();

    const sobrou = await env.DB.prepare('SELECT contagem FROM rate_limits WHERE chave = ?').bind(chave).first();
    expect(sobrou).not.toBeNull();
    expect(Number(sobrou.contagem)).toBe(1);
    expect(Number(limpeza.meta.changes)).toBe(0);
  });

  it('cria token de extensão e protege a rota de licença', async () => {
    const email = novoEmail();
    await post('/api/register', { nome: 'Fabio Nunes', email, senha: 'senha-super-segura' });

    const login = await post('/api/extensao/login', { email, senha: 'senha-super-segura' }, { Origin: ORIGEM });
    const dados = await login.json();

    // Sem Bearer e sem cookie, `/api/extensao/login` é justamente a rota que
    // não pode ser barrada por CSRF: é a porta de entrada da extensão.
    expect(login.status).toBe(200);
    expect(login.headers.get('access-control-allow-origin')).toBe(ORIGEM);
    expect(dados.token).toBeTruthy();
    expect(dados.licenca.plano).toBe('trial');
    expect(dados.acesso.permitido).toBe(true);

    const semToken = await SELF.fetch('https://api.postador.test/api/extensao/licenca', {
      headers: { Origin: ORIGEM }
    });
    expect(semToken.status).toBe(401);

    const comToken = await SELF.fetch('https://api.postador.test/api/extensao/licenca', {
      headers: { Origin: ORIGEM, Authorization: `Bearer ${dados.token}` }
    });
    expect(comToken.status).toBe(200);
    expect((await comToken.json()).licenca.email).toBe(email);
  });

  it('concede 7 dias de avaliação e informa quando ela expirou', async () => {
    const planosResposta = await SELF.fetch('https://api.postador.test/api/extensao/planos');
    expect(planosResposta.status).toBe(200);
    expect((await planosResposta.json()).avaliacaoDias).toBe(7);

    const email = novoEmail();
    const cadastro = await post('/api/extensao/cadastro', {
      nome: 'Teste Avaliação', email, senha: 'senha-super-segura'
    }, { Origin: ORIGEM });
    const dados = await cadastro.json();
    expect(cadastro.status).toBe(201);
    expect(Math.round((Date.parse(dados.licenca.avaliacaoAte) - Date.now()) / 86400000)).toBe(7);

    const usuario = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    await env.DB.prepare('UPDATE users SET trial_fim = ? WHERE id = ?')
      .bind(new Date(Date.now() - 60000).toISOString(), usuario.id)
      .run();

    const licenca = await SELF.fetch('https://api.postador.test/api/extensao/licenca', {
      headers: { Origin: ORIGEM, Authorization: `Bearer ${dados.token}` }
    });
    expect(licenca.status).toBe(200);
    expect((await licenca.json()).acesso).toEqual({ permitido: false, status: 'expirado' });
  });

  it('conta de administrador nunca expira: avaliação vencida continua valendo como Pro', async () => {
    // `segundo@postador.pro` vem da lista `ADMIN_EMAILS` do vitest.config.mjs,
    // que tem dois e-mails separados por vírgula, como a produção.
    const email = 'segundo@postador.pro';
    const cadastro = await post('/api/register', { nome: 'Segundo Admin', email, senha: 'senha-super-segura' });
    const rotas = parDe(cadastro.headers);

    // Sem forçar o fim da avaliação, o teste não provaria a permanência.
    await env.DB.prepare('UPDATE users SET trial_fim = ? WHERE email = ?')
      .bind(new Date(Date.now() - 60000).toISOString(), email)
      .run();

    const perfil = await SELF.fetch(`${BASE}/api/me`, {
      headers: { Cookie: `postador_session=${rotas.get('postador_session')}` }
    });
    const dados = await perfil.json();
    expect(dados.admin).toBe(true);
    expect(dados.statusPagamento).toBe('pro');
    expect(dados.limites.gruposPorDia).toBe(10);

    const login = await post('/api/extensao/login', { email, senha: 'senha-super-segura' }, { Origin: ORIGEM });
    const extensao = await login.json();
    expect(login.status).toBe(200);
    expect(extensao.acesso).toEqual({ permitido: true, status: 'pro' });
    expect(extensao.licenca.plano).toBe('pro');
    expect(extensao.licenca.avaliacaoAte).toBeNull();
    expect(extensao.licenca.limites.gruposPorDia).toBe(10);
  });

  it('lista as avaliações aprovadas para a janela Avaliar ferramenta', async () => {
    const resposta = await SELF.fetch('https://api.postador.test/api/extensao/avaliacoes', {
      headers: { Origin: ORIGEM }
    });
    const dados = await resposta.json();

    expect(resposta.status).toBe(200);
    expect(dados.total).toBeGreaterThanOrEqual(4);
    expect(dados.media).toBeGreaterThanOrEqual(4);
    expect(dados.avaliacoes.length).toBeGreaterThanOrEqual(4);
    expect(dados.avaliacoes[0]).toHaveProperty('nome');
    expect(typeof dados.avaliacoes[0].nota).toBe('number');
  });

  it('publica nota alta na hora e segura nota baixa para a revisão', async () => {
    const email = novoEmail();
    const cadastro = await post('/api/extensao/cadastro', {
      nome: 'Iris Campos', email, senha: 'senha-super-segura'
    }, { Origin: ORIGEM });
    const { token } = await cadastro.json();

    const semToken = await SELF.fetch('https://api.postador.test/api/extensao/avaliacao', {
      method: 'POST',
      headers: { Origin: ORIGEM, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nota: 5 })
    });
    expect(semToken.status).toBe(401);

    const notaInvalida = await SELF.fetch('https://api.postador.test/api/extensao/avaliacao', {
      method: 'POST',
      headers: { Origin: ORIGEM, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ nota: 9 })
    });
    expect(notaInvalida.status).toBe(400);

    const comentario = 'O agendamento deixou minha rotina mais leve.';
    const envio = await SELF.fetch('https://api.postador.test/api/extensao/avaliacao', {
      method: 'POST',
      headers: { Origin: ORIGEM, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ nota: 5, comentario })
    });
    expect(envio.status).toBe(200);
    expect((await envio.json()).ok).toBe(true);

    // Guarda o primeiro nome da conta, por privacidade, e a nota alta já entra
    // publicada na janela dos clientes.
    const linha = await env.DB.prepare(
      'SELECT nome, aprovada FROM avaliacoes WHERE user_id = (SELECT id FROM users WHERE email = ?)'
    ).bind(email).first();
    expect(linha.nome).toBe('Iris');
    expect(Number(linha.aprovada)).toBe(1);

    const publica = await SELF.fetch(
      'https://api.postador.test/api/extensao/avaliacoes',
      { headers: { Origin: ORIGEM } }
    );
    expect((await publica.json()).avaliacoes.some(a => a.comentario === comentario)).toBe(true);

    // Reenvio com nota baixa atualiza a existente e a tira do ar até a revisão.
    const reenvio = await SELF.fetch('https://api.postador.test/api/extensao/avaliacao', {
      method: 'POST',
      headers: { Origin: ORIGEM, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ nota: 2, comentario: 'Mudou minha opinião: está deixando a desejar.' })
    });
    expect(reenvio.status).toBe(200);

    const linhaBaixa = await env.DB.prepare(
      'SELECT nota, aprovada FROM avaliacoes WHERE user_id = (SELECT id FROM users WHERE email = ?)'
    ).bind(email).first();
    expect(Number(linhaBaixa.nota)).toBe(2);
    expect(Number(linhaBaixa.aprovada)).toBe(0);

    const depois = await SELF.fetch(
      'https://api.postador.test/api/extensao/avaliacoes',
      { headers: { Origin: ORIGEM } }
    );
    const lista = (await depois.json()).avaliacoes;
    expect(lista.some(a => a.comentario === comentario)).toBe(false);
    expect(lista.some(a => a.comentario === 'Mudou minha opinião: está deixando a desejar.')).toBe(false);
  });

  it('recusa extensão fora da allowlist', async () => {
    const email = novoEmail();
    await post('/api/register', { nome: 'Gabi Rocha', email, senha: 'senha-super-segura' });

    const resposta = await post('/api/extensao/login', { email, senha: 'senha-super-segura' }, { Origin: OUTRA_ORIGEM });
    const dados = await resposta.json();

    // Sem `Access-Control-Allow-Origin`, o navegador da extensão bloqueia a
    // resposta. A API ainda responde 200 para não dar pista, mas o cabeçalho
    // não é emitido.
    expect(resposta.headers.get('access-control-allow-origin')).toBeNull();
    expect(dados.token).toBeTruthy();
  });

  it('recusa requisição sem origem, sem referer e sem token', async () => {
    // `SELF.fetch` direto: o helper `post` sempre manda `Origin`, e aqui o que
    // se testa é justamente a ausência dele.
    const resposta = await SELF.fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@y.pro', senha: 'senha-super-segura' })
    });
    const dados = await resposta.json();

    expect(resposta.status).toBe(403);
    expect(dados.codigo).toBe('origem_desconhecida');
  });

  it('exige CSRF em escrita vinda da própria web', async () => {
    const email = novoEmail();
    const cadastro = await post('/api/register', { nome: 'Hugo Paz', email, senha: 'senha-super-segura' });
    const rotas = parDe(cadastro.headers);

    const semCsrf = await post('/api/login', { email, senha: 'senha-super-segura' }, {
      Cookie: `postador_session=${rotas.get('postador_session')}`
    });
    expect(semCsrf.status).toBe(403);

    const comCsrf = await post('/api/login', { email, senha: 'senha-super-segura' }, {
      Cookie: cookieDe(cadastro.headers),
      'x-csrf-token': rotas.get('postador_csrf')
    });
    expect(comCsrf.status).toBe(200);
  });

  it('redefine senha e derruba as sessões', async () => {
    const email = novoEmail();
    await post('/api/register', { nome: 'Iara Melo', email, senha: 'senha-super-segura' });

    // Sem binding EMAIL nos testes, o link volta no corpo em vez de sair por
    // e-mail. É o modo de desenvolvimento descrito em `email.js`.
    const pedido = await post('/api/recuperar-senha', { email });
    const dadosPedido = await pedido.json();
    expect(pedido.status).toBe(200);
    expect(dadosPedido.linkDev).toBeTruthy();

    const token = new URL(dadosPedido.linkDev).searchParams.get('token');
    const redefinir = await post('/api/redefinir-senha', { token, novaSenha: 'outra-senha-segura' });
    expect(redefinir.status).toBe(200);

    const antiga = await post('/api/login', { email, senha: 'senha-super-segura' });
    expect(antiga.status).toBe(401);

    const nova = await post('/api/login', { email, senha: 'outra-senha-segura' });
    expect(nova.status).toBe(200);
  });

  it('não revela se o e-mail está cadastrado na recuperação', async () => {
    const existe = novoEmail();
    await post('/api/register', { nome: 'João Reis', email: existe, senha: 'senha-super-segura' });

    const cadastrado = await post('/api/recuperar-senha', { email: existe });
    const desconhecido = await post('/api/recuperar-senha', { email: 'ninguem@postador.pro' });

    expect(cadastrado.status).toBe(200);
    expect(desconhecido.status).toBe(200);
    // O corpo de uma resposta só pode ser lido uma vez.
    const dadosDesconhecido = await desconhecido.json();
    const dadosCadastrado = await cadastrado.json();
    expect(dadosDesconhecido.mensagem).toBe(dadosCadastrado.mensagem);
    expect(dadosDesconhecido.linkDev).toBeUndefined();
  });

  it('rejeita token de redefinição repetido', async () => {
    const email = novoEmail();
    await post('/api/register', { nome: 'Karla Dias', email, senha: 'senha-super-segura' });
    const pedido = await post('/api/recuperar-senha', { email });
    const token = new URL((await pedido.json()).linkDev).searchParams.get('token');

    expect((await post('/api/redefinir-senha', { token, novaSenha: 'outra-senha-segura' })).status).toBe(200);
    const segunda = await post('/api/redefinir-senha', { token, novaSenha: 'terceira-senha-segura' });
    expect(segunda.status).toBe(400);
  });

  it('restringe o painel a administradores', async () => {
    const comum = novoEmail();
    const cadastro = await post('/api/register', { nome: 'Lena Vaz', email: comum, senha: 'senha-super-segura' });
    const rotas = parDe(cadastro.headers);

    const negado = await SELF.fetch('https://api.postador.test/api/admin/overview', {
      headers: { Cookie: `postador_session=${rotas.get('postador_session')}` }
    });
    expect(negado.status).toBe(403);

    const semSessao = await SELF.fetch('https://api.postador.test/api/admin/overview');
    expect(semSessao.status).toBe(401);
  });

  it('libera o painel para o e-mail em ADMIN_EMAILS', async () => {
    const cadastro = await post('/api/register', {
      nome: 'Admin Postador',
      email: 'admin@postador.pro',
      senha: 'senha-super-segura'
    });
    const rotas = parDe(cadastro.headers);

    const painel = await SELF.fetch('https://api.postador.test/api/admin/overview', {
      headers: { Cookie: `postador_session=${rotas.get('postador_session')}` }
    });
    const dados = await painel.json();

    expect(painel.status).toBe(200);
    expect(dados.usuarios.total).toBeGreaterThan(0);
    // Administrador nunca expira: conta como Pro e ativo nos cartões do
    // painel, igual à tabela de usuários.
    expect(dados.usuarios.pro).toBeGreaterThanOrEqual(1);
    expect(dados.usuarios.ativos).toBeGreaterThanOrEqual(1);
    expect(typeof dados.pagamentos.total).toBe('number');
    expect(typeof dados.avaliacoes.pendentes).toBe('number');
  });

  it('aprova, edita, oculta e exclui avaliações pelo painel', async () => {
    // Conta com avaliação pendente (nota baixa) para o administrador mexer.
    const email = novoEmail();
    const cadastro = await post('/api/extensao/cadastro', {
      nome: 'Nina Torres', email, senha: 'senha-super-segura'
    }, { Origin: ORIGEM });
    const { token } = await cadastro.json();
    const comentarioOriginal = 'Ainda preciso de ajustes para o meu caso.';
    await SELF.fetch('https://api.postador.test/api/extensao/avaliacao', {
      method: 'POST',
      headers: { Origin: ORIGEM, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ nota: 2, comentario: comentarioOriginal })
    });

    // A conta de administrador (e-mail em ADMIN_EMAILS). O armazenamento é
    // isolado por teste, então ela precisa nascer aqui dentro.
    const cadastroAdmin = await post('/api/register', {
      nome: 'Admin Postador', email: 'admin@postador.pro', senha: 'senha-super-segura'
    });
    expect(cadastroAdmin.status).toBe(201);
    const admin = {
      Cookie: cookieDe(cadastroAdmin.headers),
      'x-csrf-token': parDe(cadastroAdmin.headers).get('postador_csrf')
    };

    // A lista traz a pendente com o e-mail de quem avaliou e marca as de exemplo.
    const lista = await SELF.fetch(`${BASE}/api/admin/avaliacoes`, { headers: { Cookie: admin.Cookie } });
    const dados = await lista.json();
    expect(lista.status).toBe(200);

    const pendente = dados.avaliacoes.find(a => a.comentario === comentarioOriginal);
    expect(pendente).toBeTruthy();
    expect(pendente.aprovada).toBe(false);
    expect(pendente.email).toBe(email);
    expect(pendente.exemplo).toBe(false);
    expect(dados.avaliacoes.some(a => a.exemplo === true)).toBe(true);

    // O resumo do painel conta a pendente e o aviso vai aparecer.
    const overview = await SELF.fetch(`${BASE}/api/admin/overview`, { headers: { Cookie: admin.Cookie } });
    expect((await overview.json()).avaliacoes.pendentes).toBeGreaterThanOrEqual(1);

    // Aprovar publica na janela dos clientes na hora.
    const aprovar = await post(`/api/admin/avaliacoes/${pendente.id}/aprovar`, { aprovada: true }, admin);
    expect(aprovar.status).toBe(200);

    const publicaUm = await SELF.fetch('https://api.postador.test/api/extensao/avaliacoes', { headers: { Origin: ORIGEM } });
    expect((await publicaUm.json()).avaliacoes.some(a => a.comentario === comentarioOriginal)).toBe(true);

    // Editar o texto reflete na listagem pública.
    const revisado = 'Ainda preciso de ajustes (texto revisado pelo suporte).';
    const editar = await post(`/api/admin/avaliacoes/${pendente.id}/editar`, { comentario: revisado }, admin);
    expect(editar.status).toBe(200);

    const publicaDois = await SELF.fetch('https://api.postador.test/api/extensao/avaliacoes', { headers: { Origin: ORIGEM } });
    const listaPublica = (await publicaDois.json()).avaliacoes;
    expect(listaPublica.some(a => a.comentario === revisado)).toBe(true);
    expect(listaPublica.some(a => a.comentario === comentarioOriginal)).toBe(false);

    // Ocultar tira da listagem pública.
    const ocultar = await post(`/api/admin/avaliacoes/${pendente.id}/aprovar`, { aprovada: false }, admin);
    expect(ocultar.status).toBe(200);

    const publicaTres = await SELF.fetch('https://api.postador.test/api/extensao/avaliacoes', { headers: { Origin: ORIGEM } });
    expect((await publicaTres.json()).avaliacoes.some(a => a.comentario === revisado)).toBe(false);

    // Excluir remove de vez.
    const excluir = await SELF.fetch(`${BASE}/api/admin/avaliacoes/${pendente.id}`, {
      method: 'DELETE',
      headers: { Origin: BASE, ...admin }
    });
    expect(excluir.status).toBe(200);

    const listaFinal = await SELF.fetch(`${BASE}/api/admin/avaliacoes`, { headers: { Cookie: admin.Cookie } });
    expect((await listaFinal.json()).avaliacoes.some(a => a.id === pendente.id)).toBe(false);
  });

  it('exporta os dados da conta e apaga a conta', async () => {
    const email = novoEmail();
    const cadastro = await post('/api/register', { nome: 'Marcos Teixeira', email, senha: 'senha-super-segura' });
    const rotas = parDe(cadastro.headers);
    const cookie = cookieDe(cadastro.headers);
    const csrf = rotas.get('postador_csrf');

    const exportar = await SELF.fetch('https://api.postador.test/api/me/dados', { headers: { Cookie: cookie } });
    const dados = await exportar.json();
    expect(exportar.status).toBe(200);
    expect(dados.conta.email).toBe(email);

    const errado = await post('/api/me/excluir', { senha: 'senha-errada' }, { Cookie: cookie, 'x-csrf-token': csrf });
    expect(errado.status).toBe(400);

    const certo = await post('/api/me/excluir', { senha: 'senha-super-segura' }, { Cookie: cookie, 'x-csrf-token': csrf });
    expect(certo.status).toBe(200);

    const linha = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    expect(linha).toBeNull();
  });

  it('nega acesso a rota desconhecida da API em JSON', async () => {
    const resposta = await SELF.fetch('https://api.postador.test/api/nao-existe');
    expect(resposta.status).toBe(404);
    expect((await resposta.json()).erro).toBe('Recurso não encontrado.');
  });

  it('responde o preflight para a extensão autorizada', async () => {
    const resposta = await SELF.fetch('https://api.postador.test/api/extensao/licenca', {
      method: 'OPTIONS',
      headers: { Origin: ORIGEM, 'Access-Control-Request-Method': 'POST' }
    });

    expect(resposta.status).toBe(204);
    expect(resposta.headers.get('access-control-allow-origin')).toBe(ORIGEM);
    expect(resposta.headers.get('access-control-allow-headers')).toContain('Authorization');
  });

  it('aplica os cabeçalhos de segurança na API', async () => {
    const resposta = await SELF.fetch('https://api.postador.test/api/health');

    expect(resposta.headers.get('x-content-type-options')).toBe('nosniff');
    expect(resposta.headers.get('x-frame-options')).toBe('DENY');
    expect(resposta.headers.get('content-security-policy')).toContain("default-src 'self'");
    // `same-origin` aqui derrubaria a leitura da resposta pela extensão.
    expect(resposta.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });
});
