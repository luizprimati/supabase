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
    color: #e4e4e7; background: #000;
  }

  /* --- Tela de abertura --- */
  .landing {
    min-height: 100vh; display: flex; flex-direction: column; align-items: flex-start;
    justify-content: center; padding: 24px 64px; max-width: 900px;
  }
  .landing h1 {
    font-size: clamp(36px, 6vw, 64px); line-height: 1.05; margin: 0 0 8px;
    color: #fff; font-weight: 700; letter-spacing: -0.02em;
  }
  .landing .tagline {
    font-size: clamp(36px, 6vw, 64px); line-height: 1.05; margin: 0 0 24px;
    color: #3ecf8e; font-weight: 700; letter-spacing: -0.02em;
  }
  .landing p.desc { max-width: 560px; color: #a1a1aa; font-size: 17px; line-height: 1.6; margin: 0 0 32px; }

  .landing .cta {
    display: inline-block; padding: 12px 28px; border: none; border-radius: 8px;
    background: #3ecf8e; color: #05261a; font-weight: 600; font-size: 15px; cursor: pointer;
  }
  .landing .cta:hover { background: #34b87c; }

  .enter-btn {
    position: fixed; top: 24px; right: 32px; padding: 9px 20px; cursor: pointer;
    border: 1px solid #2e2e2e; border-radius: 6px; background: transparent;
    color: #e4e4e7; font-weight: 500; font-size: 14px;
  }
  .enter-btn:hover { border-color: #3ecf8e; color: #3ecf8e; }

  /* --- Login --- */
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.75); display: none;
    align-items: center; justify-content: center; padding: 16px; backdrop-filter: blur(2px);
  }
  .overlay.open { display: flex; }
  .card { width: 100%; max-width: 380px; position: relative; }
  .card .close {
    position: absolute; top: -36px; right: 0; background: none; border: none;
    color: #71717a; font-size: 24px; cursor: pointer; line-height: 1;
  }
  .card .close:hover { color: #fff; }
  .card h2 { font-size: 26px; margin: 0 0 6px; color: #fff; font-weight: 700; }
  .card p.sub { margin: 0 0 28px; color: #a1a1aa; font-size: 14px; }
  label { display: block; font-size: 13px; margin-bottom: 6px; color: #c4c4c4; }
  .field { position: relative; margin-bottom: 18px; }
  input {
    width: 100%; padding: 11px 14px; border-radius: 8px;
    border: 1px solid #2e2e2e; background: #111; color: #fff; font-size: 14px;
  }
  input:focus { outline: none; border-color: #3ecf8e; }
  .field input { padding-right: 42px; }
  .toggle-eye {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    background: none; border: none; padding: 6px; cursor: pointer; color: #a1a1aa;
    display: flex; align-items: center;
  }
  .toggle-eye:hover { color: #fff; }
  button.submit {
    width: 100%; padding: 12px; border: none; border-radius: 8px; background: #3ecf8e;
    color: #05261a; font-weight: 600; font-size: 14px; cursor: pointer; margin-top: 4px;
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
    <button class="cta" id="ctaBtn" type="button">Acessar o painel</button>
  </div>

  <div class="overlay${error ? ' open' : ''}" id="overlay">
    <div class="card">
      <button class="close" id="closeBtn" type="button" aria-label="Fechar">&times;</button>
      <h2>Bem-vindo(a) de volta</h2>
      <p class="sub">Entre com suas credenciais de administrador.</p>
      ${error ? `<div class="error">${error}</div>` : ''}
      <form method="POST" action="/login">
        <input type="hidden" name="rd" value="${safeRedirect}">
        <label for="username">Usuário</label>
        <div class="field">
          <input type="text" id="username" name="username" autocomplete="username" required autofocus>
        </div>
        <label for="password">Senha</label>
        <div class="field">
          <input type="password" id="password" name="password" autocomplete="current-password" required>
          <button class="toggle-eye" id="toggleEye" type="button" aria-label="Mostrar senha">
            <svg id="eyeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
          </button>
        </div>
        <button class="submit" type="submit">Entrar</button>
      </form>
    </div>
  </div>

  <script>
    var overlay = document.getElementById('overlay');
    function openOverlay() { overlay.classList.add('open'); }
    document.getElementById('enterBtn').addEventListener('click', openOverlay);
    document.getElementById('ctaBtn').addEventListener('click', openOverlay);
    document.getElementById('closeBtn').addEventListener('click', function () {
      overlay.classList.remove('open');
    });

    var pwd = document.getElementById('password');
    var eyeIcon = document.getElementById('eyeIcon');
    var EYE_OPEN = eyeIcon.innerHTML;
    var EYE_OFF = '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.6 21.6 0 0 1 5.06-6.06M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a21.6 21.6 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
    document.getElementById('toggleEye').addEventListener('click', function () {
      var showing = pwd.type === 'text';
      pwd.type = showing ? 'password' : 'text';
      eyeIcon.innerHTML = showing ? EYE_OPEN : EYE_OFF;
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
