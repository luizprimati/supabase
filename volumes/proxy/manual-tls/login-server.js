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
    text-decoration: none; display: inline-block; line-height: 1.4;
  }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn-primary {
    border: none; background: var(--accent); color: var(--accent-ink); font-weight: 600;
  }
  .btn-primary:hover { background: var(--accent-hover); color: var(--accent-ink); }
  .btn-danger { border-color: var(--danger-border); color: var(--danger-text); }
  .btn-danger:hover { border-color: var(--danger-text); }
  /* Variante para ações secundárias de navegação (Voltar/Sair) - borda e
     texto na cor de destaque em vez do cinza neutro do .btn puro. */
  .btn-outline { border-color: var(--accent); color: var(--accent); }
  .btn-outline:hover { background: var(--accent); color: var(--accent-ink); }
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
    <div class="nav-actions">
      ${themeToggleMarkup()}
      ${loggedIn
        ? `<a class="btn btn-outline" href="/logout">Sair</a>`
        : `<button class="btn" id="enterBtn" type="button">Entrar</button>`}
    </div>
  </nav>

  <div class="landing">
    <h1>${PROJECT_TITLE}</h1>
    <p class="tagline">${PROJECT_TAGLINE}</p>
    <p class="desc">${PROJECT_DESCRIPTION}</p>
    ${loggedIn
      ? `<div class="actions">
          <a class="cta" href="/admin">Painel Admin</a>
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
  .row-actions button.icon-only { padding: 6px; width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; }
  .confirm-popover {
    position: fixed; z-index: 10000; background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px 16px; width: 240px; box-shadow: 0 12px 32px var(--shadow);
    font-size: 13px; color: var(--text);
  }
  .confirm-popover p { margin: 0 0 12px; line-height: 1.4; }
  .confirm-popover .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .confirm-popover .confirm-actions button { padding: 5px 12px; font-size: 12px; }
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
      <a class="btn btn-outline" href="/login">Voltar</a>
      <a class="btn btn-outline" href="/logout">Sair</a>
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
        fnUrlHint.textContent = window.location.origin + '/functions/v1/' + name;
        setCode('');
        fetch('/admin/api/functions/' + encodeURIComponent(name)).then(function (r) { return r.json(); }).then(function (d) {
          setCode(d.code || '');
        });
      } else {
        document.getElementById('fnFormTitle').textContent = 'Nova função';
        fnNameField.value = '';
        fnNameField.disabled = false;
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

    var PENCIL_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>';
    var TRASH_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>';

    // Popover de confirmação próprio (em vez do confirm() nativo do
    // navegador), ancorado perto do botão que abriu ele.
    function showConfirmPopover(anchorEl, message, onConfirm) {
      var existing = document.getElementById('__confirmPopover');
      if (existing) existing.remove();

      var popover = document.createElement('div');
      popover.id = '__confirmPopover';
      popover.className = 'confirm-popover';

      var text = document.createElement('p');
      text.textContent = message;

      var actions = document.createElement('div');
      actions.className = 'confirm-actions';

      var cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn';
      cancelBtn.textContent = 'Cancelar';

      var confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'btn btn-danger';
      confirmBtn.textContent = 'Excluir';

      function close() {
        popover.remove();
        document.removeEventListener('mousedown', onOutsideClick, true);
      }
      function onOutsideClick(e) {
        if (!popover.contains(e.target) && e.target !== anchorEl) close();
      }

      cancelBtn.addEventListener('click', close);
      confirmBtn.addEventListener('click', function () {
        close();
        onConfirm();
      });

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      popover.appendChild(text);
      popover.appendChild(actions);
      document.body.appendChild(popover);

      var rect = anchorEl.getBoundingClientRect();
      var popRect = popover.getBoundingClientRect();
      var left = Math.min(rect.left, window.innerWidth - popRect.width - 12);
      var top = rect.bottom + 8;
      if (top + popRect.height > window.innerHeight) top = rect.top - popRect.height - 8;
      popover.style.left = Math.max(12, left) + 'px';
      popover.style.top = top + 'px';

      setTimeout(function () { document.addEventListener('mousedown', onOutsideClick, true); }, 0);
    }

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
            '<td><div class="row-actions">' +
              '<button data-action="edit" class="icon-only" title="Editar" aria-label="Editar">' + PENCIL_ICON + '</button>' +
              '<button data-action="delete" class="icon-only danger" title="Excluir" aria-label="Excluir">' + TRASH_ICON + '</button>' +
            '</div></td>';
          tr.querySelector('[data-action="edit"]').addEventListener('click', function () { openFunctionEditor(name); });
          tr.querySelector('[data-action="delete"]').addEventListener('click', function (e) {
            showConfirmPopover(e.currentTarget, 'Excluir a função "' + name + '"? Essa ação não pode ser desfeita.', function () {
              fetch('/admin/api/functions/' + encodeURIComponent(name), { method: 'DELETE' })
                .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                .then(function (res) {
                  if (!res.ok) { alert(res.d.error || 'Não foi possível excluir.'); return; }
                  loadFunctions();
                });
            });
          });
          body.appendChild(tr);
        });
      });
    }

    // Atalho vindo do botão injetado na página da função no Studio
    // (?editFunction=<nome>) - já abre direto na aba certa com o editor.
    var deepLinkFn = new URLSearchParams(window.location.search).get('editFunction');
    if (deepLinkFn) {
      var functionsTabBtn = document.querySelector('.tab-btn[data-tab="functions"]');
      if (functionsTabBtn) functionsTabBtn.click();
      openFunctionEditor(deepLinkFn);
    }
  </script>
</body>
</html>`;
}

// JS injetado pelo Nginx (sub_filter, veja nginx.conf.tpl) em toda página
// do Studio: botão flutuante de logout + botão/modal de "Nova função" na
// aba Edge Functions. Fica num arquivo servido por aqui (em vez de embutido
// direto na diretiva sub_filter) porque o Nginx tem um limite de ~4KB por
// parâmetro de configuração - o sub_filter só injeta uma tag <script src>
// pequena e fixa; o conteúdo de verdade nunca passa pelo parser de config
// do Nginx, então cresce à vontade sem esbarrar nesse teto.
const STUDIO_INJECT_JS = `(function () {
  'use strict';

  function createLogoutButton() {
    if (document.getElementById('__logout_fab')) return;
    var btn = document.createElement('a');
    btn.id = '__logout_fab';
    btn.href = '/logout';
    btn.title = 'Sair';
    btn.style.position = 'fixed';
    btn.style.bottom = '20px';
    btn.style.right = '20px';
    btn.style.zIndex = '999999';
    btn.style.width = '32px';
    btn.style.height = '32px';
    btn.style.borderRadius = '50%';
    btn.style.background = '#3ecf8e';
    btn.style.color = '#05261a';
    btn.style.display = 'flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.boxShadow = '0 2px 8px rgba(0,0,0,.3)';
    btn.style.textDecoration = 'none';
    btn.style.opacity = '.7';
    btn.style.transition = 'opacity .15s, transform .15s';
    btn.addEventListener('mouseenter', function () {
      btn.style.opacity = '1';
      btn.style.background = '#34b87c';
      btn.style.transform = 'scale(1.08)';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.opacity = '.7';
      btn.style.background = '#3ecf8e';
      btn.style.transform = 'scale(1)';
    });

    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4');
    var poly = document.createElementNS(svgNS, 'polyline');
    poly.setAttribute('points', '16 17 21 12 16 7');
    var line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', '21'); line.setAttribute('y1', '12');
    line.setAttribute('x2', '9'); line.setAttribute('y2', '12');
    svg.appendChild(path); svg.appendChild(poly); svg.appendChild(line);
    btn.appendChild(svg);
    document.body.appendChild(btn);
  }

  function isValidFnName(n) {
    if (!n) return false;
    if (n.length > 63) return false;
    if (n === 'main') return false;
    var c0 = n.charCodeAt(0);
    if (c0 < 97 || c0 > 122) return false;
    for (var i = 0; i < n.length; i++) {
      var c = n.charCodeAt(i);
      var ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95;
      if (!ok) return false;
    }
    return true;
  }

  var modalApi = null;
  function getModal() {
    if (modalApi) return modalApi;

    var overlay = document.createElement('div');
    overlay.id = '__fn_modal_overlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0,0,0,.5)';
    overlay.style.display = 'none';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '1000000';
    overlay.style.fontFamily = 'inherit';

    var card = document.createElement('div');
    card.style.background = '#fff';
    card.style.borderRadius = '10px';
    card.style.padding = '20px';
    card.style.width = '320px';
    card.style.boxSizing = 'border-box';
    card.style.boxShadow = '0 10px 40px rgba(0,0,0,.3)';
    card.style.fontFamily = 'inherit';

    var title = document.createElement('div');
    title.textContent = 'Nova função';
    title.style.fontSize = '15px';
    title.style.fontWeight = '600';
    title.style.color = '#1c1c1c';
    title.style.marginBottom = '12px';

    var label = document.createElement('label');
    label.textContent = 'Nome da função';
    label.style.display = 'block';
    label.style.fontSize = '12px';
    label.style.color = '#555';
    label.style.marginBottom = '6px';
    label.style.fontWeight = '500';

    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'minha-funcao';
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    input.style.padding = '8px 10px';
    input.style.border = '1px solid #d4d4d4';
    input.style.borderRadius = '6px';
    input.style.fontSize = '13px';
    input.style.fontFamily = 'inherit';
    input.style.marginBottom = '4px';
    input.style.outline = 'none';
    // O Studio roda com color-scheme escuro; sem isso o navegador usa
    // texto/caret claros (nativos do modo escuro) sobre o fundo branco
    // do nosso modal, e o que a pessoa digita fica invisível.
    input.style.colorScheme = 'light';
    input.style.background = '#fff';
    input.style.color = '#1c1c1c';
    input.addEventListener('focus', function () { input.style.borderColor = '#3ecf8e'; });
    input.addEventListener('blur', function () { input.style.borderColor = '#d4d4d4'; });

    var hint = document.createElement('div');
    hint.textContent = 'Letras minúsculas, números, - ou _, começando com letra.';
    hint.style.fontSize = '11px';
    hint.style.color = '#888';
    hint.style.marginBottom = '10px';

    var errorMsg = document.createElement('div');
    errorMsg.style.fontSize = '12px';
    errorMsg.style.color = '#c0392b';
    errorMsg.style.marginBottom = '10px';
    errorMsg.style.display = 'none';

    var actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.justifyContent = 'flex-end';
    actions.style.gap = '8px';
    actions.style.marginTop = '4px';

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancelar';
    cancelBtn.style.border = '1px solid #d4d4d4';
    cancelBtn.style.background = '#fff';
    cancelBtn.style.color = '#333';
    cancelBtn.style.borderRadius = '6px';
    cancelBtn.style.padding = '6px 14px';
    cancelBtn.style.fontSize = '13px';
    cancelBtn.style.fontFamily = 'inherit';
    cancelBtn.style.cursor = 'pointer';

    var createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.textContent = 'Criar';
    createBtn.style.border = 'none';
    createBtn.style.background = '#3ecf8e';
    createBtn.style.color = '#05261a';
    createBtn.style.fontWeight = '600';
    createBtn.style.borderRadius = '6px';
    createBtn.style.padding = '6px 14px';
    createBtn.style.fontSize = '13px';
    createBtn.style.fontFamily = 'inherit';
    createBtn.style.cursor = 'pointer';

    actions.appendChild(cancelBtn);
    actions.appendChild(createBtn);
    card.appendChild(title);
    card.appendChild(label);
    card.appendChild(input);
    card.appendChild(hint);
    card.appendChild(errorMsg);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function resetBtn() {
      createBtn.disabled = false;
      createBtn.textContent = 'Criar';
    }
    function showError(msg) {
      errorMsg.textContent = msg;
      errorMsg.style.display = 'block';
    }
    function close() {
      overlay.style.display = 'none';
      input.value = '';
      errorMsg.style.display = 'none';
      resetBtn();
    }
    function submit() {
      var name = input.value.trim();
      if (!isValidFnName(name)) {
        showError('Nome inválido.');
        return;
      }
      errorMsg.style.display = 'none';
      createBtn.disabled = true;
      createBtn.textContent = 'Criando...';
      var code = 'Deno.serve(() => Response.json({ message: "Hello from Edge Functions!" }));';
      fetch('/admin/api/functions/' + encodeURIComponent(name), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) {
            resetBtn();
            showError(res.d && res.d.error ? res.d.error : 'Não foi possível criar a função.');
            return;
          }
          window.location.reload();
        })
        .catch(function () {
          resetBtn();
          showError('Erro de rede ao criar a função.');
        });
    }

    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    createBtn.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') close();
    });

    modalApi = {
      open: function () {
        overlay.style.display = 'flex';
        input.value = '';
        errorMsg.style.display = 'none';
        setTimeout(function () { input.focus(); }, 0);
      },
      remove: function () { overlay.remove(); },
    };
    return modalApi;
  }

  function createFnBtn() {
    var btn = document.createElement('button');
    btn.id = '__new_fn_btn';
    btn.type = 'button';

    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var l1 = document.createElementNS(svgNS, 'line');
    l1.setAttribute('x1', '12'); l1.setAttribute('y1', '5');
    l1.setAttribute('x2', '12'); l1.setAttribute('y2', '19');
    var l2 = document.createElementNS(svgNS, 'line');
    l2.setAttribute('x1', '5'); l2.setAttribute('y1', '12');
    l2.setAttribute('x2', '19'); l2.setAttribute('y2', '12');
    svg.appendChild(l1); svg.appendChild(l2);
    var lbl = document.createElement('span');
    lbl.textContent = 'Nova função';
    btn.appendChild(svg);
    btn.appendChild(lbl);

    btn.style.position = 'fixed';
    btn.style.zIndex = '999999';
    btn.style.border = 'none';
    btn.style.borderRadius = '6px';
    btn.style.background = '#3ecf8e';
    btn.style.color = '#05261a';
    btn.style.fontWeight = '600';
    btn.style.fontSize = '12px';
    btn.style.fontFamily = 'inherit';
    btn.style.cursor = 'pointer';
    btn.style.boxSizing = 'border-box';
    btn.style.height = '26px';
    btn.style.lineHeight = '1';
    btn.style.padding = '0 10px';
    btn.style.display = 'inline-flex';
    btn.style.alignItems = 'center';
    btn.style.gap = '6px';
    btn.style.justifyContent = 'center';
    btn.addEventListener('click', function () { getModal().open(); });
    document.body.appendChild(btn);
    return btn;
  }

  function ensureFnBtn() {
    var existing = document.getElementById('__new_fn_btn');
    if (window.location.pathname.indexOf('/functions') === -1) {
      if (existing) existing.remove();
      var m = document.getElementById('__fn_modal_overlay');
      if (m) m.remove();
      modalApi = null;
      return;
    }
    var els = document.querySelectorAll('a,button');
    var examplesBtn = null;
    for (var i = 0; i < els.length; i++) {
      if (els[i].id !== '__new_fn_btn' && els[i].textContent.trim() === 'Examples') { examplesBtn = els[i]; break; }
    }
    if (!examplesBtn) {
      if (existing) existing.remove();
      return;
    }
    var btn = existing || createFnBtn();
    var group = examplesBtn.parentElement || examplesBtn;
    var groupRect = group.getBoundingClientRect();
    var w = btn.offsetWidth || 140;
    btn.style.top = groupRect.top + 'px';
    btn.style.left = Math.max(8, groupRect.left - w - 8) + 'px';
  }

  function ensureLogoutButton() {
    // Só na tela principal (Project Overview, a primeira página depois do
    // login) - em várias outras páginas do Studio já existe alguma coisa
    // nesse mesmo canto, e o botão flutuante brigava com elas.
    var isMainScreen = window.location.pathname === '/project/default';
    var existing = document.getElementById('__logout_fab');
    if (isMainScreen) {
      if (!existing) createLogoutButton();
    } else if (existing) {
      existing.remove();
    }
  }

  // Editor de código de uma função existente: o Studio abre o Monaco em
  // modo só-leitura, e não é só a opção "readOnly" - o React deles reverte
  // qualquer edição de volta pro texto original a cada mudança (é uma
  // segunda camada de proteção, de propósito, para reforçar que o
  // self-hosted é mesmo só-leitura). Desbloquear só o Monaco não é
  // suficiente e produz um comportamento quebrado (cursor pulando pro
  // início a cada tecla, "salvar" gravando o texto original de volta em
  // vez do editado, aviso de "unsaved changes" do próprio roteador deles).
  // Em vez de tentar contornar cada camada (cada vez mais frágil), este
  // botão só leva direto pro editor de verdade em /admin, que já
  // funciona.
  function getFunctionNameFromPath() {
    var parts = window.location.pathname.split('/').filter(Boolean);
    var idx = parts.indexOf('functions');
    if (idx === -1) return null;
    var name = parts[idx + 1];
    if (!name || name === 'new') return null;
    return name;
  }

  var editLink = null;
  function ensureEditDeepLink() {
    var name = getFunctionNameFromPath();
    if (!name) {
      if (editLink) { editLink.remove(); editLink = null; }
      return;
    }
    if (editLink) return;

    editLink = document.createElement('a');
    editLink.id = '__edit_admin_link';
    editLink.href = '/admin?editFunction=' + encodeURIComponent(name);
    editLink.textContent = 'Editar no painel admin';
    editLink.style.position = 'fixed';
    editLink.style.bottom = '20px';
    editLink.style.right = '20px';
    editLink.style.zIndex = '999999';
    editLink.style.border = 'none';
    editLink.style.borderRadius = '6px';
    editLink.style.background = '#3ecf8e';
    editLink.style.color = '#05261a';
    editLink.style.fontWeight = '600';
    editLink.style.fontSize = '13px';
    editLink.style.fontFamily = 'inherit';
    editLink.style.padding = '8px 18px';
    editLink.style.cursor = 'pointer';
    editLink.style.textDecoration = 'none';
    editLink.style.boxShadow = '0 2px 10px rgba(0,0,0,.3)';
    document.body.appendChild(editLink);
  }

  function ensureAll() {
    ensureLogoutButton();
    ensureFnBtn();
    ensureEditDeepLink();
  }

  setInterval(ensureAll, 600);
  ensureAll();
})();
`;

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

  // Servido no lugar de embutir o JS direto na diretiva sub_filter do
  // Nginx (que tem um limite de ~4KB por parâmetro de config) - veja
  // STUDIO_INJECT_JS acima.
  if (url.pathname === '/studio-inject.js' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(STUDIO_INJECT_JS);
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
