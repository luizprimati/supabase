'use strict';

// Tela de login própria para o Studio, no lugar do pop-up nativo de Basic
// Auth do navegador. Usado pelo Nginx via "auth_request" (veja
// nginx.conf.tpl) - este processo não fala com a internet, só com o Nginx
// na rede interna do Docker.
//
// Sem dependências externas (só módulos nativos do Node) para não precisar
// de "npm install" nem de imagem própria - roda direto na imagem oficial
// node:alpine.

const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');
const { URL } = require('url');

const PORT = process.env.PORT || 8085;
const AUTH_USERNAME = process.env.AUTH_USERNAME || '';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const COOKIE_SECRET = process.env.AUTH_COOKIE_SECRET || '';
const COOKIE_NAME = 'supabase_studio_auth';
const SESSION_HOURS = parseInt(process.env.AUTH_SESSION_HOURS || '168', 10);

if (!AUTH_USERNAME || !AUTH_PASSWORD || !COOKIE_SECRET) {
  console.error('AUTH_USERNAME, AUTH_PASSWORD e AUTH_COOKIE_SECRET são obrigatórios');
  process.exit(1);
}

function sign(value) {
  return crypto.createHmac('sha256', COOKIE_SECRET).update(value).digest('hex');
}

// Compara em tempo constante (via hash) para evitar timing attack e não
// depender dos dois valores terem o mesmo tamanho.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function makeToken() {
  const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
  const payload = `${AUTH_USERNAME}.${expires}`;
  return Buffer.from(`${payload}.${sign(payload)}`).toString('base64url');
}

function verifyToken(token) {
  try {
    const [user, expiresStr, sig] = Buffer.from(token, 'base64url').toString('utf8').split('.');
    if (!user || !expiresStr || !sig) return false;
    if (Date.now() > parseInt(expiresStr, 10)) return false;
    return safeEqual(sig, sign(`${user}.${expiresStr}`)) && user === AUTH_USERNAME;
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function renderLoginPage({ error, redirect }) {
  const safeRedirect = (redirect || '/').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Entrar - Supabase</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #1c1c1c; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #e4e4e7;
  }
  .card {
    width: 100%; max-width: 360px; padding: 32px; border-radius: 12px;
    background: #242424; border: 1px solid #333; box-shadow: 0 10px 30px rgba(0,0,0,.4);
  }
  h1 { font-size: 20px; margin: 0 0 4px; color: #fff; }
  p.sub { margin: 0 0 24px; color: #9a9a9a; font-size: 14px; }
  label { display: block; font-size: 13px; margin-bottom: 6px; color: #c4c4c4; }
  input {
    width: 100%; padding: 10px 12px; margin-bottom: 16px; border-radius: 8px;
    border: 1px solid #3a3a3a; background: #1a1a1a; color: #fff; font-size: 14px;
  }
  input:focus { outline: none; border-color: #3ecf8e; }
  button {
    width: 100%; padding: 11px; border: none; border-radius: 8px; background: #3ecf8e;
    color: #05261a; font-weight: 600; font-size: 14px; cursor: pointer;
  }
  button:hover { background: #34b87c; }
  .error {
    background: #3a1d1d; border: 1px solid #5c2b2b; color: #ff9b9b;
    padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>Supabase Studio</h1>
    <p class="sub">Entre com suas credenciais de administrador.</p>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST" action="/login">
      <input type="hidden" name="rd" value="${safeRedirect}">
      <label for="username">Usuário</label>
      <input type="text" id="username" name="username" autocomplete="username" required autofocus>
      <label for="password">Senha</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
      <button type="submit">Entrar</button>
    </form>
  </div>
</body>
</html>`;
}

function collectBody(req, callback) {
  let data = '';
  req.on('data', (chunk) => {
    data += chunk;
    if (data.length > 1e5) req.destroy();
  });
  req.on('end', () => callback(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://internal');

  // Chamado pelo Nginx via auth_request - nunca exposto direto ao cliente.
  if (url.pathname === '/auth') {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[COOKIE_NAME] && verifyToken(cookies[COOKIE_NAME])) {
      res.writeHead(200);
      res.end('ok');
    } else {
      res.writeHead(401);
      res.end('unauthorized');
    }
    return;
  }

  if (url.pathname === '/login' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderLoginPage({ redirect: url.searchParams.get('rd') || '/' }));
    return;
  }

  if (url.pathname === '/login' && req.method === 'POST') {
    collectBody(req, (body) => {
      const form = querystring.parse(body);
      const username = String(form.username || '');
      const password = String(form.password || '');
      const redirect = String(form.rd || '/');
      if (safeEqual(username, AUTH_USERNAME) && safeEqual(password, AUTH_PASSWORD)) {
        res.writeHead(302, {
          'Set-Cookie': `${COOKIE_NAME}=${makeToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`,
          Location: redirect,
        });
        res.end();
      } else {
        // Pequeno atraso proposital para dificultar força bruta.
        setTimeout(() => {
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderLoginPage({ error: 'Usuário ou senha incorretos.', redirect }));
        }, 400);
      }
    });
    return;
  }

  if (url.pathname === '/logout') {
    res.writeHead(302, {
      'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      Location: '/login',
    });
    res.end();
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => console.log(`login-server ouvindo na porta ${PORT}`));
