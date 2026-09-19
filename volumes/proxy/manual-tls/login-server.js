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
//   [{"username": "luiz", "salt": "...", "hash": "...", "role": "admin"}]
// "role" é "admin" ou "user" (padrão). Só quem é "admin" vê /admin (CRUD
// de usuários). Gere uma entrada com: node hash-password.js "a-senha-aqui"
// (nunca senha em texto puro no arquivo - só salt+hash via scrypt).

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');
const { URL } = require('url');

const PORT = process.env.PORT || 8085;
const COOKIE_SECRET = process.env.AUTH_COOKIE_SECRET || '';
const USERS_FILE = process.env.USERS_FILE || '/app/users.json';
const FUNCTIONS_DIR = process.env.FUNCTIONS_DIR || '/app/functions';
const COOKIE_NAME = 'supabase_studio_auth';
const SESSION_HOURS = parseInt(process.env.AUTH_SESSION_HOURS || '168', 10);

// Conteúdo da tela de abertura - troque por env var sem tocar no código.
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
    return Array.isArray(parsed) ? parsed.map((u) => ({ role: 'user', ...u })) : [];
  } catch (e) {
    console.error(`Não foi possível ler ${USERS_FILE}: ${e.message}`);
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Escreve e responde 500 em vez de deixar uma exceção (ex: arquivo
// montado como somente leitura) derrubar o processo inteiro - isso já
// aconteceu uma vez e tirou o login do ar até o restart automático.
function trySaveUsers(res, users) {
  try {
    saveUsers(users);
    return true;
  } catch (e) {
    console.error(`Não foi possível gravar ${USERS_FILE}: ${e.message}`);
    sendJson(res, 500, { error: 'Não foi possível salvar - o arquivo users.json está gravável no container?' });
    return false;
  }
}

// --- Edge Functions: editor simples que escreve direto nos arquivos que
// o dispatcher (volumes/functions/main/index.ts) já lê do disco a cada
// requisição - editar aqui tem efeito imediato, sem reiniciar container.

const FUNCTION_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;
const RESERVED_FUNCTION_NAMES = new Set(['main']); // dispatcher - nunca editável por aqui

const FUNCTION_TEMPLATE = `import "@supabase/functions-js/edge-runtime.d.ts"

Deno.serve(async (req: Request) => {
  return Response.json({ message: "Hello from Edge Functions!" });
});
`;

function isValidFunctionName(name) {
  return FUNCTION_NAME_RE.test(name) && !RESERVED_FUNCTION_NAMES.has(name);
}

function functionIndexPath(name) {
  return path.join(FUNCTIONS_DIR, name, 'index.ts');
}

function listFunctions() {
  try {
    return fs.readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !RESERVED_FUNCTION_NAMES.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (e) {
    console.error(`Não foi possível listar ${FUNCTIONS_DIR}: ${e.message}`);
    return [];
  }
}

function readFunctionCode(name) {
  try {
    return fs.readFileSync(functionIndexPath(name), 'utf8');
  } catch {
    return null;
  }
}

// Grava via arquivo temporário + rename (atômico no mesmo filesystem) -
// evita o dispatcher ler um arquivo pela metade no meio de uma escrita.
function writeFunctionCode(name, code) {
  const dir = path.join(FUNCTIONS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, 'index.ts');
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, code);
  fs.renameSync(tmpPath, finalPath);
}

function deleteFunctionDir(name) {
  fs.rmSync(path.join(FUNCTIONS_DIR, name), { recursive: true, force: true });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
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

function isAdmin(user) {
  return Boolean(user) && user.role === 'admin';
}

// O nome de usuário é codificado em base64url antes de entrar no token:
// o alfabeto do base64url nunca contém ".", então usuários com ponto no
// nome (ex: "luiz.primati") não quebram o split('.') abaixo.
function makeToken(username) {
  const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
  const encodedUser = Buffer.from(username, 'utf8').toString('base64url');
  const payload = `${encodedUser}.${expires}`;
  return Buffer.from(`${payload}.${sign(payload)}`).toString('base64url');
}

// Retorna o username validado do cookie, ou null. Reconfirma que o
// usuário ainda existe no arquivo - permite revogar acesso na hora só
// removendo a entrada, sem esperar o cookie expirar.
function usernameFromToken(token) {
  try {
    const parts = Buffer.from(token, 'base64url').toString('utf8').split('.');
    if (parts.length !== 3) return null;
    const [encodedUser, expiresStr, sig] = parts;
    if (Date.now() > parseInt(expiresStr, 10)) return null;
    if (!safeEqual(sig, sign(`${encodedUser}.${expiresStr}`))) return null;
    const username = Buffer.from(encodedUser, 'base64url').toString('utf8');
    return findUser(loadUsers(), username) ? username : null;
  } catch {
    return null;
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

function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const username = usernameFromToken(cookies[COOKIE_NAME]);
  return username ? findUser(loadUsers(), username) : null;
}

// CSS compartilhado entre a tela de login e o painel de admin - variáveis
// de tema (claro/escuro), alternadas via atributo data-theme na <html>.
const THEME_CSS = `
  :root {
    --bg: #000; --bg-elevated: #0d0d0d; --bg-card: #111;
    --border: #1e1e1e; --border-strong: #2e2e2e;
    --text: #e4e4e7; --text-strong: #fff; --text-muted: #a1a1aa;
    --accent: #3ecf8e; --accent-ink: #05261a; --accent-hover: #34b87c;
    --danger-bg: #3a1d1d; --danger-border: #5c2b2b; --danger-text: #ff9b9b;
    --shadow: rgba(0,0,0,.5);
    color-scheme: dark;
  }
  [data-theme="light"] {
    --bg: #fafafa; --bg-elevated: #fff; --bg-card: #fff;
    --border: #e4e4e7; --border-strong: #d4d4d8;
    --text: #27272a; --text-strong: #09090b; --text-muted: #6b7280;
    --accent: #1f9d6f; --accent-ink: #fff; --accent-hover: #18845d;
    --danger-bg: #fef2f2; --danger-border: #fecaca; --danger-text: #b91c1c;
    --shadow: rgba(0,0,0,.1);
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: var(--text); background: var(--bg); transition: background .15s, color .15s;
  }
  .topnav {
    display: flex; align-items: center; justify-content: space-between;
    padding: 20px 32px; border-bottom: 1px solid var(--border);
  }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 17px; color: var(--text-strong); }
  .brand svg { flex-shrink: 0; }
  .navlinks { display: flex; gap: 28px; color: var(--text-muted); font-size: 14px; }
  .navlinks span { cursor: default; }
  @media (max-width: 800px) { .navlinks { display: none; } }
  .nav-actions { display: flex; align-items: center; gap: 12px; }
  .icon-btn {
    width: 36px; height: 36px; display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--border-strong); border-radius: 8px; background: transparent;
    color: var(--text); cursor: pointer;
  }
  .icon-btn:hover { border-color: var(--accent); color: var(--accent); }
  .icon-btn .icon-moon { display: none; }
  [data-theme="light"] .icon-btn .icon-sun { display: none; }
  [data-theme="light"] .icon-btn .icon-moon { display: block; }
  .btn {
    padding: 9px 20px; cursor: pointer; border: 1px solid var(--border-strong); border-radius: 6px;
    background: transparent; color: var(--text); font-weight: 500; font-size: 14px;
  }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn-primary {
    border: none; background: var(--accent); color: var(--accent-ink); font-weight: 600;
  }
  .btn-primary:hover { background: var(--accent-hover); color: var(--accent-ink); }
  .btn-danger { border-color: var(--danger-border); color: var(--danger-text); }
  .btn-danger:hover { border-color: var(--danger-text); }
`;

function themeInitScript() {
  return `<script>try{var t=localStorage.getItem('theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}</script>`;
}

function themeToggleMarkup() {
  return `<button class="icon-btn" id="themeToggle" type="button" aria-label="Alternar tema claro/escuro">
    <svg class="icon-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
    <svg class="icon-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"></path></svg>
  </button>`;
}

function themeToggleScript() {
  return `
    var themeBtn = document.getElementById('themeToggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', function () {
        var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('theme', next); } catch (e) {}
      });
    }
  `;
}

function renderPage({ error, redirect, session }) {
  const safeRedirect = (redirect || '/').replace(/"/g, '&quot;');
  const loggedIn = Boolean(session);
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
${themeInitScript()}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${PROJECT_TITLE}</title>
<style>
${THEME_CSS}
  .landing {
    display: flex; flex-direction: column; align-items: flex-start;
    padding: 72px 32px 56px; max-width: 1100px; margin: 0 auto;
  }
  .landing h1 {
    font-size: clamp(32px, 5.5vw, 58px); line-height: 1.05; margin: 0 0 8px;
    color: var(--text-strong); font-weight: 700; letter-spacing: -0.02em;
  }
  .landing .tagline {
    font-size: clamp(32px, 5.5vw, 58px); line-height: 1.05; margin: 0 0 24px;
    color: var(--accent); font-weight: 700; letter-spacing: -0.02em;
  }
  .landing p.desc { max-width: 560px; color: var(--text-muted); font-size: 17px; line-height: 1.6; margin: 0 0 32px; }
  .landing .actions { display: flex; gap: 12px; flex-wrap: wrap; }
  .landing .cta {
    display: inline-block; padding: 12px 28px; border: none; border-radius: 8px;
    background: var(--accent); color: var(--accent-ink); font-weight: 600; font-size: 15px; cursor: pointer;
    text-decoration: none;
  }
  .landing .cta:hover { background: var(--accent-hover); }
  .landing .cta.secondary {
    background: transparent; border: 1px solid var(--border-strong); color: var(--text);
  }
  .landing .cta.secondary:hover { border-color: var(--accent); color: var(--accent); background: transparent; }

  .features {
    max-width: 1100px; margin: 0 auto; padding: 0 32px 80px;
    display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px;
  }
  .feature-card { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  .feature-card svg { color: var(--accent); margin-bottom: 16px; }
  .feature-card h3 { font-size: 15px; color: var(--text-strong); margin: 0 0 8px; font-weight: 600; }
  .feature-card p { font-size: 13px; color: var(--text-muted); line-height: 1.5; margin: 0; }

  /* --- Login --- */
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.75); display: flex; opacity: 0; visibility: hidden;
    align-items: center; justify-content: center; padding: 16px; backdrop-filter: blur(4px);
    transition: opacity .18s ease;
  }
  .overlay.open { opacity: 1; visibility: visible; }
  .card {
    width: 100%; max-width: 400px; position: relative; background: var(--bg-card);
    border: 1px solid var(--border); border-radius: 16px; padding: 40px 36px;
    box-shadow: 0 20px 60px var(--shadow), 0 0 0 1px rgba(62,207,142,.06);
    transform: scale(.96) translateY(8px); transition: transform .18s ease;
  }
  .overlay.open .card { transform: scale(1) translateY(0); }
  .card::before {
    content: ''; position: absolute; top: 0; left: 16px; right: 16px; height: 2px; border-radius: 2px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
  }
  .card .close {
    position: absolute; top: 16px; right: 16px; background: none; border: none;
    color: var(--text-muted); font-size: 22px; cursor: pointer; line-height: 1;
  }
  .card .close:hover { color: var(--text-strong); }
  .card-logo { color: var(--accent); margin-bottom: 20px; }
  .card h2 { font-size: 24px; margin: 0 0 6px; color: var(--text-strong); font-weight: 700; }
  .card p.sub { margin: 0 0 28px; color: var(--text-muted); font-size: 14px; }
  label { display: block; font-size: 13px; margin-bottom: 6px; color: var(--text-muted); font-weight: 500; }
  .field { position: relative; margin-bottom: 18px; }
  .field svg.leading {
    position: absolute; left: 13px; top: 50%; transform: translateY(-50%); color: var(--text-muted); pointer-events: none;
  }
  input {
    width: 100%; padding: 12px 14px; border-radius: 9px;
    border: 1px solid var(--border-strong); background: var(--bg); color: var(--text-strong); font-size: 14px;
    transition: border-color .15s, box-shadow .15s;
  }
  .field input { padding-left: 40px; }
  .field input.has-trailing { padding-right: 42px; }
  input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(62,207,142,.15); }
  .toggle-eye {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    background: none; border: none; padding: 6px; cursor: pointer; color: var(--text-muted);
    display: flex; align-items: center;
  }
  .toggle-eye:hover { color: var(--text-strong); }
  button.submit {
    width: 100%; padding: 13px; border: none; border-radius: 9px; background: var(--accent);
    color: var(--accent-ink); font-weight: 600; font-size: 14px; cursor: pointer; margin-top: 8px;
    transition: background .15s, transform .1s;
  }
  button.submit:hover { background: var(--accent-hover); }
  button.submit:active { transform: scale(.98); }
  .error {
    background: var(--danger-bg); border: 1px solid var(--danger-border); color: var(--danger-text);
    padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px;
  }
</style>
</head>
<body>
  <nav class="topnav">
    <div class="brand">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="var(--accent)"><path d="M13 2 3 14h7l-1 8 11-14h-7l1-6Z"></path></svg>
      <span>${PROJECT_TITLE}</span>
    </div>
    <div class="navlinks">
      <span>Produto</span>
      <span>Desenvolvedores</span>
      <span>Soluções</span>
      <span>Documentação</span>
    </div>
    <div class="nav-actions">
      ${themeToggleMarkup()}
      ${loggedIn
        ? `<a class="btn" href="/logout">Sair</a>`
        : `<button class="btn" id="enterBtn" type="button">Entrar</button>`}
    </div>
  </nav>

  <div class="landing">
    <h1>${PROJECT_TITLE}</h1>
    <p class="tagline">${PROJECT_TAGLINE}</p>
    <p class="desc">${PROJECT_DESCRIPTION}</p>
    ${loggedIn
      ? `<div class="actions">
          <a class="cta" href="/admin">Gerenciar usuários</a>
          <a class="cta secondary" href="/">Ir para o Supabase</a>
        </div>`
      : `<button class="cta" id="ctaBtn" type="button">Acessar o painel</button>`}
  </div>

  <div class="features">
    <div class="feature-card">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>
      <h3>Banco de dados Postgres</h3>
      <p>Cada projeto é um banco Postgres completo, o banco relacional mais confiável do mundo.</p>
    </div>
    <div class="feature-card">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"></path></svg>
      <h3>Autenticação</h3>
      <p>Cadastro e login de usuários, protegendo os dados com Row Level Security.</p>
    </div>
    <div class="feature-card">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
      <h3>Funções Edge</h3>
      <p>Escreva código customizado sem se preocupar em implantar ou escalar servidores.</p>
    </div>
    <div class="feature-card">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"></path><path d="M1 3h22v5H1z"></path><path d="M10 12h4"></path></svg>
      <h3>Armazenamento</h3>
      <p>Guarde, organize e sirva arquivos grandes, de vídeos a imagens.</p>
    </div>
    <div class="feature-card">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>
      <h3>Tempo real</h3>
      <p>Construa experiências com sincronização de dados em tempo real.</p>
    </div>
    <div class="feature-card">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"></path><path d="m3.27 6.96 8.73 5.04 8.73-5.04"></path><path d="M12 22.08V12"></path></svg>
      <h3>Vetor</h3>
      <p>Integre modelos de ML para guardar, indexar e buscar embeddings vetoriais.</p>
    </div>
    <div class="feature-card">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
      <h3>APIs de dados</h3>
      <p>APIs REST prontas para uso, geradas automaticamente a partir do seu banco.</p>
    </div>
  </div>

  ${loggedIn ? '' : `
  <div class="overlay${error ? ' open' : ''}" id="overlay">
    <div class="card">
      <button class="close" id="closeBtn" type="button" aria-label="Fechar">&times;</button>
      <svg class="card-logo" width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h7l-1 8 11-14h-7l1-6Z"></path></svg>
      <h2>Bem-vindo(a) de volta</h2>
      <p class="sub">Entre com suas credenciais de administrador.</p>
      ${error ? `<div class="error">${error}</div>` : ''}
      <form method="POST" action="/login">
        <input type="hidden" name="rd" value="${safeRedirect}">
        <label for="username">Usuário</label>
        <div class="field">
          <svg class="leading" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
          <input type="text" id="username" name="username" autocomplete="username" required autofocus>
        </div>
        <label for="password">Senha</label>
        <div class="field">
          <svg class="leading" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
          <input class="has-trailing" type="password" id="password" name="password" autocomplete="current-password" required>
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
  `}

  <script>
    ${themeToggleScript()}
    ${loggedIn ? '' : `
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
    `}
  </script>
</body>
</html>`;
}

function renderForbiddenPage() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
${themeInitScript()}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acesso restrito</title>
<style>${THEME_CSS}
  .wrap { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 24px; }
  h1 { color: var(--text-strong); font-size: 22px; }
  p { color: var(--text-muted); max-width: 420px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Acesso restrito</h1>
    <p>Essa área é só para administradores. Fale com quem administra este painel se precisar de acesso.</p>
    <p><a href="/" style="color: var(--accent)">Voltar</a></p>
  </div>
</body>
</html>`;
}

function renderAdminPage(currentUsername) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
${themeInitScript()}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin - ${PROJECT_TITLE}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/dracula.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/javascript/javascript.min.js"></script>
<style>
${THEME_CSS}
  .wrap { max-width: 860px; margin: 0 auto; padding: 40px 24px 80px; }
  .tabs { display: flex; gap: 20px; margin-bottom: 24px; border-bottom: 1px solid var(--border); }
  .tab-btn {
    padding: 10px 2px; background: none; border: none; border-bottom: 2px solid transparent;
    color: var(--text-muted); font-size: 14px; font-weight: 500; cursor: pointer;
  }
  .tab-btn.active { color: var(--text-strong); border-bottom-color: var(--accent); }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  /* Precisa da dupla-classe (.card.editor-card) para ganhar de ".card"
     mesmo estando definida antes dela no arquivo - CSS resolve empate de
     especificidade pela ordem, e ".card" (mais abaixo) tinha um
     max-width menor que sempre vencia. */
  .card.editor-card { max-width: min(1300px, 68vw); width: 68vw; min-width: 480px; }
  .fn-url { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: var(--text-muted); word-break: break-all; }
  .CodeMirror { height: 456px; border: 1px solid var(--border-strong); border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
  textarea#fn-code { width: 100%; height: 456px; margin-bottom: 16px; }
  /* Linha de ações do editor de funções - usa os mesmos .btn/.btn-primary/
     .btn-danger do resto da interface (nav, toolbar) em vez do
     .card-actions esticado (feito só para o formulário pequeno de
     usuário), que fica gigante/estranho numa largura maior. Excluir fica
     isolado à esquerda (ação destrutiva); Cancelar/Salvar agrupados à
     direita - padrão comum de rodapé de diálogo. */
  .editor-actions { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
  .editor-actions .spacer { flex: 1; }
  .editor-actions .btn { padding: 10px 22px; }
  .wrap h1 { color: var(--text-strong); font-size: 24px; margin: 0 0 4px; }
  .wrap p.sub { color: var(--text-muted); font-size: 14px; margin: 0 0 28px; }
  table { width: 100%; border-collapse: collapse; background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 12px 16px; font-size: 14px; border-bottom: 1px solid var(--border); }
  th { color: var(--text-muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
  tr:last-child td { border-bottom: none; }
  .badge {
    display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
  }
  .badge.admin { background: rgba(62,207,142,.15); color: var(--accent); }
  .badge.user { background: var(--border); color: var(--text-muted); }
  .row-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .row-actions button {
    border: 1px solid var(--border-strong); background: transparent; color: var(--text);
    border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer;
  }
  .row-actions button:hover { border-color: var(--accent); color: var(--accent); }
  .row-actions button.danger:hover { border-color: var(--danger-text); color: var(--danger-text); }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }

  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.75); display: none;
    align-items: center; justify-content: center; padding: 16px; backdrop-filter: blur(4px);
  }
  .overlay.open { display: flex; }
  .card {
    width: 100%; max-width: 380px; background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 16px; padding: 32px; position: relative;
  }
  .card h2 { margin: 0 0 20px; font-size: 18px; color: var(--text-strong); }
  label { display: block; font-size: 13px; margin-bottom: 6px; color: var(--text-muted); font-weight: 500; }
  input, select {
    width: 100%; padding: 10px 12px; margin-bottom: 16px; border-radius: 8px;
    border: 1px solid var(--border-strong); background: var(--bg); color: var(--text-strong); font-size: 14px;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); }
  .hint { font-size: 12px; color: var(--text-muted); margin: -10px 0 16px; }
  .card-actions { display: flex; gap: 8px; margin-top: 4px; }
  .card-actions button { flex: 1; padding: 11px; border-radius: 8px; font-size: 14px; cursor: pointer; }
  .msg { font-size: 13px; margin-bottom: 14px; padding: 10px 12px; border-radius: 8px; display: none; }
  .msg.error { background: var(--danger-bg); border: 1px solid var(--danger-border); color: var(--danger-text); }
  .msg.ok { background: rgba(62,207,142,.12); border: 1px solid rgba(62,207,142,.3); color: var(--accent); }
</style>
</head>
<body>
  <nav class="topnav">
    <div class="brand">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="var(--accent)"><path d="M13 2 3 14h7l-1 8 11-14h-7l1-6Z"></path></svg>
      <span>${PROJECT_TITLE}</span>
    </div>
    <div class="nav-actions">
      ${themeToggleMarkup()}
      <a class="btn" href="/login">Voltar</a>
      <a class="btn" href="/logout">Sair</a>
    </div>
  </nav>

  <div class="wrap">
    <div class="tabs">
      <button class="tab-btn active" data-tab="users" type="button">Usuários</button>
      <button class="tab-btn" data-tab="functions" type="button">Edge Functions</button>
    </div>

    <div class="tab-panel active" id="usersPanel">
      <div class="toolbar">
        <div>
          <h1>Usuários</h1>
          <p class="sub">Logado como <strong>${currentUsername}</strong></p>
        </div>
        <button class="btn btn-primary" id="newUserBtn" type="button">Novo usuário</button>
      </div>
      <table>
        <thead><tr><th>Usuário</th><th>Papel</th><th></th></tr></thead>
        <tbody id="usersBody"></tbody>
      </table>
    </div>

    <div class="tab-panel" id="functionsPanel">
      <div class="toolbar">
        <div>
          <h1>Edge Functions</h1>
          <p class="sub">Salvar aqui grava direto no servidor - sem precisar reiniciar nada.</p>
        </div>
        <button class="btn btn-primary" id="newFnBtn" type="button">Nova função</button>
      </div>
      <table>
        <thead><tr><th>Nome</th><th>URL</th><th></th></tr></thead>
        <tbody id="functionsBody"></tbody>
      </table>
    </div>
  </div>

  <div class="overlay" id="overlay">
    <div class="card">
      <h2 id="formTitle">Novo usuário</h2>
      <div class="msg" id="formMsg"></div>
      <form id="userForm">
        <label for="f-username">Usuário</label>
        <input type="text" id="f-username" required autocomplete="off">
        <label for="f-password">Senha</label>
        <input type="password" id="f-password" autocomplete="new-password">
        <p class="hint" id="passwordHint">Mínimo 8 caracteres.</p>
        <label for="f-role">Papel</label>
        <select id="f-role">
          <option value="user">Usuário</option>
          <option value="admin">Administrador</option>
        </select>
        <div class="card-actions">
          <button type="button" class="btn" id="cancelBtn">Cancelar</button>
          <button type="submit" class="btn btn-primary" id="saveBtn">Salvar</button>
        </div>
      </form>
    </div>
  </div>

  <div class="overlay" id="fnOverlay">
    <div class="card editor-card">
      <h2 id="fnFormTitle">Nova função</h2>
      <div class="msg" id="fnFormMsg"></div>
      <label for="fn-name">Nome da função</label>
      <input type="text" id="fn-name" autocomplete="off" placeholder="ex: minha-funcao">
      <p class="hint" id="fnNameHint">Letras minúsculas, números, "-" ou "_", começando com letra. Não pode ser alterado depois de criada.</p>
      <label for="fn-code">Código (index.ts)</label>
      <textarea id="fn-code"></textarea>
      <p class="fn-url" id="fnUrlHint"></p>
      <div class="editor-actions">
        <button type="button" class="btn btn-danger" id="fnDeleteBtn" style="display:none">Excluir</button>
        <div class="spacer"></div>
        <button type="button" class="btn" id="fnCancelBtn">Cancelar</button>
        <button type="button" class="btn btn-primary" id="fnSaveBtn">Salvar</button>
      </div>
    </div>
  </div>

  <script>
    ${themeToggleScript()}

    var overlay = document.getElementById('overlay');
    var form = document.getElementById('userForm');
    var usernameField = document.getElementById('f-username');
    var passwordField = document.getElementById('f-password');
    var passwordHint = document.getElementById('passwordHint');
    var roleField = document.getElementById('f-role');
    var formMsg = document.getElementById('formMsg');
    var editingUsername = null;

    function showMsg(text, kind) {
      formMsg.textContent = text;
      formMsg.className = 'msg ' + kind;
      formMsg.style.display = 'block';
    }
    function hideMsg() { formMsg.style.display = 'none'; }

    function openForm(user) {
      hideMsg();
      form.reset();
      if (user) {
        editingUsername = user.username;
        document.getElementById('formTitle').textContent = 'Editar ' + user.username;
        usernameField.value = user.username;
        usernameField.disabled = true;
        roleField.value = user.role;
        passwordField.required = false;
        passwordHint.textContent = 'Deixe em branco para manter a senha atual.';
      } else {
        editingUsername = null;
        document.getElementById('formTitle').textContent = 'Novo usuário';
        usernameField.disabled = false;
        passwordField.required = true;
        passwordHint.textContent = 'Mínimo 8 caracteres.';
      }
      overlay.classList.add('open');
    }
    function closeForm() { overlay.classList.remove('open'); }

    document.getElementById('newUserBtn').addEventListener('click', function () { openForm(null); });
    document.getElementById('cancelBtn').addEventListener('click', closeForm);

    function loadUsers() {
      fetch('/admin/api/users').then(function (r) { return r.json(); }).then(function (users) {
        var body = document.getElementById('usersBody');
        body.innerHTML = '';
        users.forEach(function (u) {
          var tr = document.createElement('tr');
          var badgeClass = u.role === 'admin' ? 'admin' : 'user';
          var badgeLabel = u.role === 'admin' ? 'Administrador' : 'Usuário';
          tr.innerHTML =
            '<td>' + u.username + '</td>' +
            '<td><span class="badge ' + badgeClass + '">' + badgeLabel + '</span></td>' +
            '<td><div class="row-actions">' +
              '<button data-action="edit">Editar</button>' +
              '<button data-action="delete" class="danger">Excluir</button>' +
            '</div></td>';
          tr.querySelector('[data-action="edit"]').addEventListener('click', function () { openForm(u); });
          tr.querySelector('[data-action="delete"]').addEventListener('click', function () {
            if (!confirm('Excluir o usuário "' + u.username + '"? Essa ação não pode ser desfeita.')) return;
            fetch('/admin/api/users/' + encodeURIComponent(u.username), { method: 'DELETE' })
              .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
              .then(function (res) {
                if (!res.ok) { alert(res.d.error || 'Não foi possível excluir.'); return; }
                loadUsers();
              });
          });
          body.appendChild(tr);
        });
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      hideMsg();
      var payload = { role: roleField.value };
      if (passwordField.value) payload.password = passwordField.value;

      var url = '/admin/api/users';
      var method = 'POST';
      if (editingUsername) {
        url += '/' + encodeURIComponent(editingUsername);
        method = 'PUT';
      } else {
        payload.username = usernameField.value;
      }

      fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) { showMsg(res.d.error || 'Não foi possível salvar.', 'error'); return; }
          closeForm();
          loadUsers();
        });
    });

    loadUsers();

    // --- Abas ---
    var tabButtons = document.querySelectorAll('.tab-btn');
    var tabPanels = { users: document.getElementById('usersPanel'), functions: document.getElementById('functionsPanel') };
    var functionsLoaded = false;
    tabButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        tabButtons.forEach(function (b) { b.classList.remove('active'); });
        Object.keys(tabPanels).forEach(function (k) { tabPanels[k].classList.remove('active'); });
        btn.classList.add('active');
        tabPanels[btn.dataset.tab].classList.add('active');
        if (btn.dataset.tab === 'functions' && !functionsLoaded) {
          functionsLoaded = true;
          loadFunctions();
        }
      });
    });

    // --- Edge Functions ---
    var fnOverlay = document.getElementById('fnOverlay');
    var fnNameField = document.getElementById('fn-name');
    var fnCodeArea = document.getElementById('fn-code');
    var fnFormMsg = document.getElementById('fnFormMsg');
    var fnUrlHint = document.getElementById('fnUrlHint');
    var fnDeleteBtn = document.getElementById('fnDeleteBtn');
    var editingFunctionName = null;
    var fnEditor = null;
    var FUNCTION_TEMPLATE = ${JSON.stringify(FUNCTION_TEMPLATE)};

    function ensureEditor() {
      if (fnEditor) return fnEditor;
      if (window.CodeMirror) {
        fnEditor = CodeMirror.fromTextArea(fnCodeArea, {
          mode: 'text/typescript', theme: 'dracula', lineNumbers: true, tabSize: 2, indentUnit: 2,
        });
      }
      return fnEditor;
    }
    function getCode() { return fnEditor ? fnEditor.getValue() : fnCodeArea.value; }
    function setCode(v) { if (fnEditor) { fnEditor.setValue(v); } else { fnCodeArea.value = v; } }

    function fnShowMsg(text, kind) {
      fnFormMsg.textContent = text;
      fnFormMsg.className = 'msg ' + kind;
      fnFormMsg.style.display = 'block';
    }
    function fnHideMsg() { fnFormMsg.style.display = 'none'; }

    function openFunctionEditor(name) {
      fnHideMsg();
      ensureEditor();
      editingFunctionName = name;
      if (name) {
        document.getElementById('fnFormTitle').textContent = 'Editar ' + name;
        fnNameField.value = name;
        fnNameField.disabled = true;
        fnDeleteBtn.style.display = '';
        fnUrlHint.textContent = window.location.origin + '/functions/v1/' + name;
        setCode('');
        fetch('/admin/api/functions/' + encodeURIComponent(name)).then(function (r) { return r.json(); }).then(function (d) {
          setCode(d.code || '');
        });
      } else {
        document.getElementById('fnFormTitle').textContent = 'Nova função';
        fnNameField.value = '';
        fnNameField.disabled = false;
        fnDeleteBtn.style.display = 'none';
        fnUrlHint.textContent = '';
        setCode(FUNCTION_TEMPLATE);
      }
      fnOverlay.classList.add('open');
      if (fnEditor) setTimeout(function () { fnEditor.refresh(); }, 10);
    }
    function closeFunctionEditor() { fnOverlay.classList.remove('open'); }

    document.getElementById('newFnBtn').addEventListener('click', function () { openFunctionEditor(null); });
    document.getElementById('fnCancelBtn').addEventListener('click', closeFunctionEditor);

    fnNameField.addEventListener('input', function () {
      if (!fnNameField.disabled) {
        fnUrlHint.textContent = fnNameField.value ? window.location.origin + '/functions/v1/' + fnNameField.value : '';
      }
    });

    document.getElementById('fnSaveBtn').addEventListener('click', function () {
      fnHideMsg();
      var name = (editingFunctionName || fnNameField.value.trim());
      if (!name) { fnShowMsg('Informe um nome para a função.', 'error'); return; }
      fetch('/admin/api/functions/' + encodeURIComponent(name), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: getCode() }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) { fnShowMsg(res.d.error || 'Não foi possível salvar.', 'error'); return; }
          closeFunctionEditor();
          loadFunctions();
        });
    });

    fnDeleteBtn.addEventListener('click', function () {
      if (!editingFunctionName) return;
      if (!confirm('Excluir a função "' + editingFunctionName + '"? Essa ação não pode ser desfeita.')) return;
      fetch('/admin/api/functions/' + encodeURIComponent(editingFunctionName), { method: 'DELETE' })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) { alert(res.d.error || 'Não foi possível excluir.'); return; }
          closeFunctionEditor();
          loadFunctions();
        });
    });

    function loadFunctions() {
      fetch('/admin/api/functions').then(function (r) { return r.json(); }).then(function (names) {
        var body = document.getElementById('functionsBody');
        body.innerHTML = '';
        names.forEach(function (name) {
          var tr = document.createElement('tr');
          var fnUrl = window.location.origin + '/functions/v1/' + name;
          tr.innerHTML =
            '<td>' + name + '</td>' +
            '<td class="fn-url">' + fnUrl + '</td>' +
            '<td><div class="row-actions"><button data-action="edit">Editar</button></div></td>';
          tr.querySelector('[data-action="edit"]').addEventListener('click', function () { openFunctionEditor(name); });
          body.appendChild(tr);
        });
      });
    }
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

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// Qualquer erro não previsto aqui dentro (ex: disco cheio, permissão de
// arquivo) derrubaria o processo inteiro e, com ele, o acesso ao Studio
// inteiro (o auth_request do Nginx depende deste serviço) - por isso todo
// o tratamento de requisição fica dentro de um try/catch.
const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (e) {
    console.error('Erro tratando requisição:', e);
    if (!res.headersSent) sendJson(res, 500, { error: 'Erro interno.' });
  }
});

function handleRequest(req, res) {
  const url = new URL(req.url, 'http://internal');

  // Chamado pelo Nginx via auth_request - nunca exposto direto ao cliente.
  if (url.pathname === '/auth') {
    const cookies = parseCookies(req.headers.cookie);
    res.writeHead(usernameFromToken(cookies[COOKIE_NAME]) ? 200 : 401);
    res.end();
    return;
  }

  if (url.pathname === '/login' && req.method === 'GET') {
    // Usuário comum logado nunca vê a tela de abertura - vai direto pro
    // Supabase. Só admin tem um estado "logado" nessa página (o hub com
    // os botões extras); sessão nula = tela de login normal.
    const sessionUser = getSessionUser(req);
    if (sessionUser && !isAdmin(sessionUser)) {
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPage({
      redirect: url.searchParams.get('rd') || '/',
      session: sessionUser ? { username: sessionUser.username } : null,
    }));
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
        // Sem um destino específico (rd só veio "/" ou "/login"): usuário
        // comum vai direto pro Supabase; admin cai de volta em /login,
        // que já sabe se mostrar como hub pra quem está logado.
        let finalRedirect = redirect;
        if (redirect === '/' || redirect === '/login') {
          finalRedirect = isAdmin(user) ? '/login' : '/';
        }
        res.writeHead(302, {
          'Set-Cookie': `${COOKIE_NAME}=${makeToken(username)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`,
          Location: finalRedirect,
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

  // --- Painel de admin: CRUD de usuários, só para role === 'admin' ---

  if (url.pathname === '/admin' && req.method === 'GET') {
    const user = getSessionUser(req);
    if (!user) {
      res.writeHead(302, { Location: '/login?rd=%2Fadmin' });
      res.end();
      return;
    }
    if (!isAdmin(user)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderForbiddenPage());
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderAdminPage(user.username));
    return;
  }

  if (url.pathname.startsWith('/admin/api/users')) {
    const user = getSessionUser(req);
    if (!isAdmin(user)) {
      sendJson(res, user ? 403 : 401, { error: 'Acesso restrito a administradores.' });
      return;
    }

    // GET /admin/api/users - lista (nunca inclui salt/hash)
    if (url.pathname === '/admin/api/users' && req.method === 'GET') {
      const users = loadUsers().map((u) => ({ username: u.username, role: u.role }));
      sendJson(res, 200, users);
      return;
    }

    // POST /admin/api/users - cria
    if (url.pathname === '/admin/api/users' && req.method === 'POST') {
      collectBody(req, (body) => {
        let data;
        try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'JSON inválido.' }); return; }
        const username = String(data.username || '').trim();
        const password = String(data.password || '');
        const role = data.role === 'admin' ? 'admin' : 'user';
        if (!username) { sendJson(res, 400, { error: 'Informe um nome de usuário.' }); return; }
        if (password.length < 8) { sendJson(res, 400, { error: 'A senha precisa ter ao menos 8 caracteres.' }); return; }
        const users = loadUsers();
        if (findUser(users, username)) { sendJson(res, 409, { error: 'Já existe um usuário com esse nome.' }); return; }
        users.push({ username, role, ...hashPassword(password) });
        if (!trySaveUsers(res, users)) return;
        sendJson(res, 201, { username, role });
      });
      return;
    }

    // PUT/DELETE /admin/api/users/<username>
    const prefix = '/admin/api/users/';
    if (url.pathname.startsWith(prefix)) {
      const targetUsername = decodeURIComponent(url.pathname.slice(prefix.length));
      const users = loadUsers();
      const target = findUser(users, targetUsername);
      if (!target) { sendJson(res, 404, { error: 'Usuário não encontrado.' }); return; }

      if (req.method === 'PUT') {
        collectBody(req, (body) => {
          let data;
          try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'JSON inválido.' }); return; }
          if (typeof data.role === 'string') {
            const isLastAdmin = target.role === 'admin' && data.role !== 'admin' &&
              users.filter((u) => u.role === 'admin').length <= 1;
            if (isLastAdmin) { sendJson(res, 400, { error: 'Não é possível remover o último administrador.' }); return; }
            target.role = data.role === 'admin' ? 'admin' : 'user';
          }
          if (typeof data.password === 'string' && data.password) {
            if (data.password.length < 8) { sendJson(res, 400, { error: 'A senha precisa ter ao menos 8 caracteres.' }); return; }
            Object.assign(target, hashPassword(data.password));
          }
          if (!trySaveUsers(res, users)) return;
          sendJson(res, 200, { username: target.username, role: target.role });
        });
        return;
      }

      if (req.method === 'DELETE') {
        if (target.role === 'admin' && users.filter((u) => u.role === 'admin').length <= 1) {
          sendJson(res, 400, { error: 'Não é possível excluir o último administrador.' });
          return;
        }
        if (!trySaveUsers(res, users.filter((u) => u.username !== targetUsername))) return;
        sendJson(res, 200, { ok: true });
        return;
      }
    }
  }

  // --- Edge Functions: editor, também restrito a role === 'admin' ---
  if (url.pathname.startsWith('/admin/api/functions')) {
    const user = getSessionUser(req);
    if (!isAdmin(user)) {
      sendJson(res, user ? 403 : 401, { error: 'Acesso restrito a administradores.' });
      return;
    }

    if (url.pathname === '/admin/api/functions' && req.method === 'GET') {
      sendJson(res, 200, listFunctions());
      return;
    }

    const fnPrefix = '/admin/api/functions/';
    if (url.pathname.startsWith(fnPrefix)) {
      const name = decodeURIComponent(url.pathname.slice(fnPrefix.length));

      if (req.method === 'GET') {
        if (!isValidFunctionName(name)) { sendJson(res, 400, { error: 'Nome de função inválido.' }); return; }
        const code = readFunctionCode(name);
        if (code === null) { sendJson(res, 404, { error: 'Função não encontrada.' }); return; }
        sendJson(res, 200, { name, code });
        return;
      }

      if (req.method === 'PUT') {
        collectBody(req, (body) => {
          let data;
          try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'JSON inválido.' }); return; }
          if (!isValidFunctionName(name)) {
            sendJson(res, 400, { error: 'Nome inválido. Use letras minúsculas, números, "-" ou "_", começando com letra.' });
            return;
          }
          const code = typeof data.code === 'string' ? data.code : '';
          if (!code.trim()) { sendJson(res, 400, { error: 'O código não pode ficar vazio.' }); return; }
          try {
            writeFunctionCode(name, code);
          } catch (e) {
            console.error(`Não foi possível gravar a função ${name}: ${e.message}`);
            sendJson(res, 500, { error: 'Não foi possível salvar - a pasta de functions está gravável no container?' });
            return;
          }
          sendJson(res, 200, { name });
        });
        return;
      }

      if (req.method === 'DELETE') {
        if (!isValidFunctionName(name)) { sendJson(res, 400, { error: 'Nome de função inválido.' }); return; }
        try {
          deleteFunctionDir(name);
        } catch (e) {
          sendJson(res, 500, { error: `Não foi possível excluir: ${e.message}` });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }
    }
  }

  res.writeHead(404);
  res.end('not found');
}

server.listen(PORT, () => console.log(`login-server ouvindo na porta ${PORT}`));
