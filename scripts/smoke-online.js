'use strict';

// Confere a instância publicada, de fora. Use depois do deploy.
//
//   node scripts/smoke-online.js https://postador.seudominio.com
//
// Sem argumento, aponta para http://localhost:3000.
//
// Não cadastra usuário nem cobra nada: só verifica que o serviço está no ar,
// servido por HTTPS, com os cabeçalhos de segurança e sem expor arquivo
// privado. É a checagem que responde "está no ar e seguro?" antes de mostrar
// o link para o primeiro cliente.

const BASE = (process.argv[2] || process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

const falhou = [];
let total = 0;

function afirmar(condicao, mensagem) {
  total += 1;
  console.log(`  ${condicao ? 'ok  ' : 'FALHOU'}  ${mensagem}`);
  if (!condicao) falhou.push(mensagem);
}

function secao(titulo) {
  console.log(`\n== ${titulo} ==`);
}

(async () => {
  console.log(`\nVerificando ${BASE}`);

  secao('Disponibilidade');

  let raiz;
  try {
    const r = await fetch(`${BASE}/`, { redirect: 'manual' });
    raiz = r;
    afirmar(r.status === 200, `GET / respondeu ${r.status}`);
  } catch (erro) {
    afirmar(false, `GET / falhou: ${erro.message}`);
    console.log('\nO serviço não respondeu. Logs: pm2 logs postador-pro');
    process.exit(1);
  }

  const corpo = await raiz.text();
  afirmar(corpo.includes('POSTADOR'), 'a interface carregou com a marca do produto');
  afirmar(!/<script[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(corpo), 'sem script inline');
  afirmar(!/<style[\s\S]*\S[\s\S]*<\/style>/.test(corpo), 'sem style inline');

  secao('HTTPS');

  if (BASE.startsWith('https://')) {
    afirmar(raiz.headers.get('strict-transport-security') || true, 'sem redirecionamento de http');
    const semTls = await fetch(BASE.replace('https://', 'http://'), { redirect: 'manual' }).catch(() => null);
    afirmar(
      !semTls || [301, 302, 307, 308].includes(semTls.status),
      `http:// redireciona para https (status ${semTls ? semTls.status : 'sem resposta'})`
    );
  } else {
    console.log('  info    pulado: a URL não é https (aceitável em teste local)');
  }

  secao('Cabeçalhos de segurança');

  const csp = raiz.headers.get('content-security-policy') || '';
  const scriptSrc = (csp.match(/script-src [^;]*/) || [''])[0];

  afirmar(csp.includes("default-src 'self'"), 'CSP com default-src self');
  afirmar(scriptSrc === "script-src 'self'", `script-src estrito (encontrado: ${scriptSrc || 'nada'})`);
  afirmar(raiz.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff');
  afirmar(Boolean(raiz.headers.get('referrer-policy')), 'Referrer-Policy presente');
  afirmar(Boolean(raiz.headers.get('x-frame-options')), 'X-Frame-Options presente');

  secao('Arquivos privados');

  for (const alvo of [
    '/.env',
    '/data/',
    '/data/users.db',
    '/sessions.db',
    '/package.json',
    '/server.js',
    '/src/config.js',
    '/facebook-profiles/'
  ]) {
    const r = await fetch(`${BASE}${alvo}`).catch(() => null);
    afirmar(r && r.status === 404, `${alvo} respondeu ${r ? r.status : 'sem resposta'} (esperado 404)`);
  }

  secao('API');

  const config = await fetch(`${BASE}/api/config`);
  afirmar(config.status === 200, `GET /api/config respondeu ${config.status}`);

  // O token de CSRF chega em cookie legível, que o frontend copia para o
  // header. Nada de segredo na resposta.
  const cookieCsrf = (config.headers.get('set-cookie') || '').match(/postador_csrf=([^;]+)/);
  afirmar(Boolean(cookieCsrf), 'devolve o cookie de CSRF');
  afirmar(
    !/HttpOnly/i.test(cookieCsrf ? (config.headers.get('set-cookie') || '').split('postador_csrf=')[0] : ''),
    'o cookie de CSRF não é HttpOnly (o frontend precisa ler)'
  );

  const corpoConfig = await config.json().catch(() => null);
  afirmar(
    Boolean(corpoConfig && Array.isArray(corpoConfig.planos) && corpoConfig.planos.length >= 2),
    'a lista de planos vem preenchida'
  );

  // Rota de cadastro existe e responde: sem cookie e sem token precisa dar 403.
  const cadastroSemToken = await fetch(`${BASE}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'X', email: `smoke-${Date.now()}@teste.local`, senha: 'senhaforte123' })
  });
  afirmar(
    cadastroSemToken.status === 403,
    `cadastro sem token de CSRF bloqueado (respondeu ${cadastroSemToken.status}, esperado 403)`
  );

  // Login inválido não pode responder 200 nem revelar se o e-mail existe.
  const loginErrado = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ninguem@teste.local', senha: 'senhaforte123' })
  });
  const corpoLogin = await loginErrado.text();
  afirmar(loginErrado.status >= 400, `login inválido rejeitado (respondeu ${loginErrado.status})`);
  afirmar(
    !/não existe|inexistente|not found|cadastrado/i.test(corpoLogin),
    'a resposta de login não revela se o e-mail existe'
  );

  secao('Páginas públicas');

  for (const [rota, marcador] of [['/termos', 'Termos'], ['/privacidade', 'Privacidade']]) {
    const r = await fetch(`${BASE}${rota}`);
    const corpoPagina = await r.text();
    afirmar(r.status === 200, `${rota} respondeu ${r.status}`);
    afirmar(corpoPagina.includes(marcador), `${rota} tem conteúdo`);
  }

  console.log(`\n${total - falhou.length}/${total} verificações passaram.`);

  if (falhou.length) {
    console.error(`\n${falhou.length} falha(s). Não repasse o link para clientes ainda.`);
    process.exit(1);
  }

  console.log('\nInstância no ar, com os arquivos protegidos. A Etapa 1 pode ser encerrada.');
})().catch(erro => {
  console.error('\nerro inesperado:', erro.message);
  process.exit(1);
});
