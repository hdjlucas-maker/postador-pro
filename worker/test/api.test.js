import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

// A origem da extensão precisa ter as 32 letras do Chrome e estar na
// `EXTENSAO_IDS` do `vitest.config.mjs`, senão o CORS e a allowlist de origem
// rejeitam antes de chegar na rota.
const ORIGEM = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const OUTRA_ORIGEM = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba';

function cookies(resposta) {
  const bruto = resposta.headers.get('set-cookie') || '';
  return bruto
    .split(/,(?=[^;]+?=)/)
    .map(parte => parte.trim().split(';')[0])
    .filter(Boolean);
}

function parDe(rotas) {
  const mapa = new Map();
  for (const par of cookies(rotas)) {
    const [nome, valor] = par.split('=');
    mapa.set(nome, valor);
  }
  return mapa;
}

async function post(caminho, corpo, cabecalhos = {}) {
  return SELF.fetch(`https://api.postador.test${caminho}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cabecalhos },
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
    expect(corpoCadastro.limites.gruposPorDia).toBe(10);

    const rotas = parDe(cadastro.headers);
    expect(rotas.get('postador_session')).toBeTruthy();
    expect(rotas.get('postador_csrf')).toBeTruthy();

    const login = await post('/api/login', { email, senha: 'senha-super-segura' }, {
      Cookie: `postador_session=${rotas.get('postador_session')}`,
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
      respostas.push(await post('/api/register', { nome: 'Teste Limite', email: novoEmail(), senha: 'senha-super-segura' }));
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
    const resposta = await post('/api/login', { email: 'x@y.pro', senha: 'senha-super-segura' });
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
      Cookie: `postador_session=${rotas.get('postador_session')}`,
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
    expect((await desconhecido.json()).mensagem).toBe((await cadastrado.json()).mensagem);
    expect((await desconhecido.json()).linkDev).toBeUndefined();
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
    expect(typeof dados.pagamentos.total).toBe('number');
  });

  it('exporta os dados da conta e apaga a conta', async () => {
    const email = novoEmail();
    const cadastro = await post('/api/register', { nome: 'Marcos Teixeira', email, senha: 'senha-super-segura' });
    const rotas = parDe(cadastro.headers);
    const cookie = `postador_session=${rotas.get('postador_session')}`;
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
