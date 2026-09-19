'use strict';

// Página de abertura + login próprio para o Studio, no lugar do pop-up
// nativo de Basic Auth do navegador. Usado pelo Nginx via "auth_request"
// (veja nginx.conf.tpl) - este processo não fala com a internet, só com o
// Nginx na rede interna do Docker.
//
// Sem dependências externas (só módulos nativos do Node) para não precisar
// de "npm install" nem de imagem própria - roda direto na imagem oficial
// node:alpine.
//
// Múltiplos usuários: credenciais ficam em USERS_FILE (padrão
// /app/users.json), formato:
//   [{"username": "luiz", "salt": "...", "hash": "..."}, ...]
// Gere uma entrada com: node hash-password.js "a-senha-aqui"
// (nunca senha em texto puro no arquivo - só salt+hash via scrypt).

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const querystring = require('querystring');
const { URL } = require('url');

const PORT = process.env.PORT || 8085;
const COOKIE_SECRET = process.env.AUTH_COOKIE_SECRET || '';
const USERS_FILE = process.env.USERS_FILE || '/app/users.json';
const COOKIE_NAME = 'supabase_studio_auth';
const SESSION_HOURS = parseInt(process.env.AUTH_SESSION_HOURS || '168', 10);

// Conteúdo da tela de abertura - troque por env var sem tocar no código,
// ou me mande a tela que você tem em mente que eu reescrevo o HTML/CSS
// pra bater com ela.
const PROJECT_TITLE = process.env.PROJECT_TITLE || 'Valleti Books & Rádio';
const PROJECT_TAGLINE = process.env.PROJECT_TAGLINE || 'Painel administrativo';
const PROJECT_DESCRIPTION = process.env.PROJECT_DESCRIPTION ||
  'Esta é a área de administração de dados do projeto. O acesso é restrito à equipe autorizada.';

if (!COOKIE_SECRET) {
  console.error('AUTH_COOKIE_SECRET é obrigatório');
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

function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error(`Não foi possível ler ${USERS_FILE}: ${e.message}`);
    return [];
  }
}

function verifyPassword(password, salt, hash) {
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function findUser(users, username) {
  return users.find((u) => u.username === username);
}

function makeToken(username) {
  const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
  const payload = `${username}.${expires}`;
  return Buffer.from(`${payload}.${sign(payload)}`).toString('base64url');
}

function verifyToken(token) {
  try {
    const [username, expiresStr, sig] = Buffer.from(token, 'base64url').toString('utf8').split('.');
    if (!username || !expiresStr || !sig) return false;
    if (Date.now() > parseInt(expiresStr, 10)) return false;
    if (!safeEqual(sig, sign(`${username}.${expiresStr}`))) return false;
    // Reconfirma que o usuário ainda existe no arquivo - permite revogar
    // acesso na hora só removendo a entrada, sem esperar o cookie expirar.
    return Boolean(findUser(loadUsers(), username));
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

function renderPage({ error, redirect }) {
  const safeRedirect = (redirect || '/').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${PROJECT_TITLE}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #e4e4e7; background: radial-gradient(circle at 50% 0%, #1f2a24 0%, #141414 60%);
  }

  /* --- Tela de abertura --- */
  .landing {
    min-height: 100vh; display: flex; flex-direction: column; align-items: center;
    justify-content: center; text-align: center; padding: 24px;
  }
  .landing h1 { font-size: 32px; margin: 0 0 12px; color: #fff; }
  .landing .tagline { font-size: 16px; color: #3ecf8e; margin: 0 0 20px; font-weight: 600; }
  .landing p.desc { max-width: 520px; color: #a1a1aa; font-size: 15px; line-height: 1.6; margin: 0; }

  .enter-btn {
    position: fixed; top: 20px; right: 24px; padding: 10px 20px; border: none;
    border-radius: 999px; background: #3ecf8e; color: #05261a; font-weight: 600;
    font-size: 14px; cursor: pointer; box-shadow: 0 4px 14px rgba(62,207,142,.35);
  }
  .enter-btn:hover { background: #34b87c; }

  /* --- Modal de login --- */
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.6); display: none;
    align-items: center; justify-content: center; padding: 16px;
  }
  .overlay.open { display: flex; }
  .card {
    width: 100%; max-width: 360px; padding: 32px; border-radius: 12px;
    background: #242424; border: 1px solid #333; box-shadow: 0 10px 30px rgba(0,0,0,.4);
    position: relative;
  }
  .card .close {
    position: absolute; top: 12px; right: 14px; background: none; border: none;
    color: #9a9a9a; font-size: 18px; cursor: pointer; line-height: 1;
  }
  .card h2 { font-size: 18px; margin: 0 0 4px; color: #fff; }
  .card p.sub { margin: 0 0 20px; color: #9a9a9a; font-size: 13px; }
  label { display: block; font-size: 13px; margin-bottom: 6px; color: #c4c4c4; }
  input {
    width: 100%; padding: 10px 12px; margin-bottom: 16px; border-radius: 8px;
    border: 1px solid #3a3a3a; background: #1a1a1a; color: #fff; font-size: 14px;
  }
  input:focus { outline: none; border-color: #3ecf8e; }
  button.submit {
    width: 100%; padding: 11px; border: none; border-radius: 8px; background: #3ecf8e;
    color: #05261a; font-weight: 600; font-size: 14px; cursor: pointer;
  }
  button.submit:hover { background: #34b87c; }
  .error {
    background: #3a1d1d; border: 1px solid #5c2b2b; color: #ff9b9b;
    padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px;
  }
</style>
</head>
<body>
  <button class="enter-btn" id="enterBtn" type="button">Entrar</button>

  <div class="landing">
    <h1>${PROJECT_TITLE}</h1>
    <p class="tagline">${PROJECT_TAGLINE}</p>
    <p class="desc">${PROJECT_DESCRIPTION}</p>
  </div>

  <div class="overlay${error ? ' open' : ''}" id="overlay">
    <div class="card">
      <button class="close" id="closeBtn" type="button" aria-label="Fechar">&times;</button>
      <h2>Entrar</h2>
      <p class="sub">Use suas credenciais de administrador.</p>
      ${error ? `<div class="error">${error}</div>` : ''}
      <form method="POST" action="/login">
        <input type="hidden" name="rd" value="${safeRedirect}">
        <label for="username">Usuário</label>
        <input type="text" id="username" name="username" autocomplete="username" required autofocus>
        <label for="password">Senha</label>
        <input type="password" id="password" name="password" autocomplete="current-password" required>
        <button class="submit" type="submit">Entrar</button>
      </form>
    </div>
  </div>

  <script>
    var overlay = document.getElementById('overlay');
    document.getElementById('enterBtn').addEventListener('click', function () {
      overlay.classList.add('open');
    });
    document.getElementById('closeBtn').addEventListener('click', function () {
      overlay.classList.remove('open');
    });
  </script>
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
    res.end(renderPage({ redirect: url.searchParams.get('rd') || '/' }));
    return;
  }

  if (url.pathname === '/login' && req.method === 'POST') {
    collectBody(req, (body) => {
      const form = querystring.parse(body);
      const username = String(form.username || '');
      const password = String(form.password || '');
      const redirect = String(form.rd || '/');
      const user = findUser(loadUsers(), username);
      const ok = Boolean(user) && verifyPassword(password, user.salt, user.hash);
      if (ok) {
        res.writeHead(302, {
          'Set-Cookie': `${COOKIE_NAME}=${makeToken(username)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`,
          Location: redirect,
        });
        res.end();
      } else {
        // Pequeno atraso proposital para dificultar força bruta.
        setTimeout(() => {
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderPage({ error: 'Usuário ou senha incorretos.', redirect }));
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
