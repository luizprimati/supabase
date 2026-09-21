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
const os = require('os');
const path = require('path');
const querystring = require('querystring');
const { URL } = require('url');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 8085;
const COOKIE_SECRET = process.env.AUTH_COOKIE_SECRET || '';
const USERS_FILE = process.env.USERS_FILE || '/app/users.json';
const FUNCTIONS_DIR = process.env.FUNCTIONS_DIR || '/app/functions';
const COOKIE_NAME = 'supabase_studio_auth';
const SESSION_HOURS = parseInt(process.env.AUTH_SESSION_HOURS || '168', 10);

// Backup (aba Backup em /admin) - dump do Postgres via
// pg_dump (mesmas credenciais que os outros serviços do compose já
// usam) + tar das Edge Functions, subidos pro Google Drive do usuário.
const BACKUP_CONFIG_FILE = process.env.BACKUP_CONFIG_FILE || '/app/backup-config.json';
const PG_ENV = {
  PGHOST: process.env.POSTGRES_HOST || 'db',
  PGPORT: process.env.POSTGRES_PORT || '5432',
  PGDATABASE: process.env.POSTGRES_DB || 'postgres',
  PGPASSWORD: process.env.POSTGRES_PASSWORD || '',
  PGUSER: 'postgres',
};

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

// Arquivos extras dentro da pasta de uma function (além do index.ts) - o
// dispatcher (main/index.ts) já aponta pra pasta inteira, então o Deno
// resolve imports relativos entre eles sem precisar de nada novo na
// infra; isso só expõe criar/editar/excluir esses arquivos pelo /admin.
const FUNCTION_FILE_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

function isValidRelFilePath(relPath) {
  return typeof relPath === 'string' && relPath.length <= 200 && FUNCTION_FILE_PATH_RE.test(relPath);
}

// Resolve e confere que o caminho final não escapa da pasta da function
// (defesa extra além da regex, contra qualquer link simbólico/edge case).
function resolveFunctionFilePath(name, relPath) {
  const rootDir = path.resolve(path.join(FUNCTIONS_DIR, name));
  const fullPath = path.resolve(path.join(rootDir, relPath));
  if (fullPath !== rootDir && !fullPath.startsWith(rootDir + path.sep)) {
    throw new Error('Caminho inválido.');
  }
  return fullPath;
}

function listFunctionFiles(name) {
  const rootDir = path.join(FUNCTIONS_DIR, name);
  const results = [];
  function walk(currentDir, prefix) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(currentDir, entry.name), relPath);
      } else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
        results.push(relPath);
      }
    }
  }
  walk(rootDir, '');
  results.sort((a, b) => {
    if (a === 'index.ts') return -1;
    if (b === 'index.ts') return 1;
    return a.localeCompare(b);
  });
  return results;
}

function readFunctionFile(name, relPath) {
  try {
    return fs.readFileSync(resolveFunctionFilePath(name, relPath), 'utf8');
  } catch {
    return null;
  }
}

// Mesmo padrão de escrita atômica (arquivo temporário + rename) do
// writeFunctionCode, criando subpastas conforme necessário.
function writeFunctionFile(name, relPath, code) {
  const finalPath = resolveFunctionFilePath(name, relPath);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, code);
  fs.renameSync(tmpPath, finalPath);
}

function deleteFunctionFile(name, relPath) {
  const fullPath = resolveFunctionFilePath(name, relPath);
  fs.rmSync(fullPath, { force: true });

  // Remove subpastas que ficaram vazias depois da exclusão, sem tocar na
  // pasta raiz da function.
  const rootDir = path.resolve(path.join(FUNCTIONS_DIR, name));
  let dir = path.dirname(fullPath);
  while (dir !== rootDir && dir.startsWith(rootDir + path.sep)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

// --- Backup (aba Backup em /admin) ---------------------------
// Faz dump do Postgres (pg_dump) + tar.gz das Edge Functions e sobe os
// dois pro Google Drive do próprio usuário via OAuth (scope "drive.file",
// restrito aos arquivos que este app cria - nunca vê o resto do Drive).
// Usa só o `fetch` global do Node (disponível desde a v18, sem precisar
// de nenhuma dependência nova) pra falar com a API do Google.

const DEFAULT_BACKUP_CONFIG = {
  googleClientId: '',
  googleClientSecret: '',
  googleApiKey: '',
  googleRefreshToken: '',
  driveFolderId: '',
  frequencyHours: 24,
  retentionCount: 7,
  lastRunAt: null,
  lastRunStatus: null,
  lastRunError: null,
};

const GOOGLE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// CSRF do fluxo OAuth: state gerado em /oauth/start, conferido em
// /oauth/callback. Fica só em memória - se o processo reiniciar no meio
// do fluxo, o usuário só precisa clicar em "Conectar" de novo.
const pendingOAuthStates = new Set();
let backupRunning = false;

function readBackupConfig() {
  try {
    const raw = fs.readFileSync(BACKUP_CONFIG_FILE, 'utf8');
    return { ...DEFAULT_BACKUP_CONFIG, ...JSON.parse(raw) };
  } catch (e) {
    console.error(`Não foi possível ler ${BACKUP_CONFIG_FILE}: ${e.message}`);
    return { ...DEFAULT_BACKUP_CONFIG };
  }
}

// Escrita direta (sem arquivo temporário + rename) - BACKUP_CONFIG_FILE
// é um bind mount de um único arquivo (igual USERS_FILE), e um rename
// por cima da própria montagem falha com EBUSY de dentro do container.
function writeBackupConfig(config) {
  fs.writeFileSync(BACKUP_CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Mesmo padrão de trySaveUsers - devolve 500 em vez de deixar uma
// exceção (ex: permissão de arquivo) escapar de um callback síncrono e
// derrubar o processo inteiro.
function tryWriteBackupConfig(res, config) {
  try {
    writeBackupConfig(config);
    return true;
  } catch (e) {
    console.error(`Não foi possível gravar ${BACKUP_CONFIG_FILE}: ${e.message}`);
    sendJson(res, 500, { error: 'Não foi possível salvar - o arquivo backup-config.json está gravável no container?' });
    return false;
  }
}

// Nunca devolve client secret nem refresh token pro navegador. A API Key
// não é segredo do mesmo jeito (é feita pra rodar no navegador, restrita
// por HTTP referrer no Cloud Console) - por isso essa sim volta inteira,
// o seletor de pastas (Google Picker) precisa dela no cliente.
function maskBackupConfig(config) {
  return {
    googleClientId: config.googleClientId || '',
    hasClientSecret: !!config.googleClientSecret,
    googleApiKey: config.googleApiKey || '',
    connected: !!config.googleRefreshToken,
    driveFolderId: config.driveFolderId || '',
    frequencyHours: config.frequencyHours,
    retentionCount: config.retentionCount,
    lastRunAt: config.lastRunAt,
    lastRunStatus: config.lastRunStatus,
    lastRunError: config.lastRunError,
    running: backupRunning,
  };
}

// Aceita tanto um link completo da pasta ("https://drive.google.com/
// drive/folders/<id>?usp=sharing") quanto só o ID, pra colar direto da
// barra de endereço do navegador.
function extractDriveFolderId(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return '';
  const match = trimmed.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (match) return match[1];
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
  return null;
}

// $host (usado no Host normal que o Nginx repassa) não inclui a porta -
// só $http_host, mandado aqui como X-Forwarded-Host (mesma lição de
// @login_redirect no nginx.conf.tpl), preserva o ":9443" da URL que o
// cliente realmente usou.
function backupRedirectUri(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `https://${host}/admin/api/backup/oauth/callback`;
}

function buildGoogleAuthUrl(clientId, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_OAUTH_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeGoogleCode(clientId, clientSecret, code, redirectUri) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Falha ao trocar o código pelo token do Google.');
  return data;
}

async function refreshGoogleAccessToken(clientId, clientSecret, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Falha ao renovar o token do Google (reconecte o Drive na aba Backup).');
  return data.access_token;
}

// Padrão comum das rotas de Drive em /admin/api/backup/drive/* - renova
// o access token e só então roda a operação; qualquer erro (sem conexão,
// token expirado, chamada ao Drive) vira uma resposta 500 limpa em vez
// de escapar pra fora sem resposta nenhuma.
function withDriveAccessToken(res, handler) {
  const config = readBackupConfig();
  if (!config.googleRefreshToken) { sendJson(res, 400, { error: 'Conecte o Google Drive primeiro.' }); return; }
  refreshGoogleAccessToken(config.googleClientId, config.googleClientSecret, config.googleRefreshToken)
    .then((accessToken) => handler(accessToken, config))
    .catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
}

// Upload multipart (metadados JSON + conteúdo do arquivo numa só
// requisição) - mais simples que o protocolo resumível e suficiente pro
// tamanho normal de um dump/tar deste projeto; se falhar no meio, a
// rodada de backup inteira falha e tenta de novo na próxima janela.
async function driveUploadFile(accessToken, { name, parents, mimeType, filePath }) {
  const boundary = `foilboundary${crypto.randomBytes(8).toString('hex')}`;
  const metadata = JSON.stringify({ name, parents });
  const fileData = fs.readFileSync(filePath);
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const suffix = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([prefix, fileData, suffix]);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Falha ao enviar ${name} pro Drive.`);
  return data;
}

async function driveListFolderFiles(accessToken, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,createdTime)&orderBy=createdTime&pageSize=1000`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Falha ao listar arquivos da pasta do Drive.');
  return data.files || [];
}

async function driveDeleteFile(accessToken, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error?.message || 'Falha ao excluir um backup antigo do Drive.');
  }
}

// Usada tanto pra pasta do dia de cada rodada de backup quanto pelo
// botão "+ Criar nova pasta" do seletor em /admin - sem parentId, cria
// na raiz do Drive.
async function driveCreateFolder(accessToken, name, parentId) {
  const body = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [parentId];
  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Falha ao criar a pasta no Drive.');
  return data;
}

// Base pra listar pastas de backup (retenção, aba Gerenciar) e arquivos
// dentro de uma delas (aba Gerenciar) - já vem em ordem decrescente de
// criação, mais recente primeiro.
async function driveListChildren(accessToken, parentId, { foldersOnly } = {}) {
  let q = `'${parentId}' in parents and trashed = false`;
  if (foldersOnly) q += ` and mimeType = 'application/vnd.google-apps.folder'`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,createdTime)&orderBy=createdTime desc&pageSize=1000`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Falha ao listar itens do Drive.');
  return data.files || [];
}

function driveListFolders(accessToken, parentId) {
  return driveListChildren(accessToken, parentId, { foldersOnly: true });
}

async function driveListFiles(accessToken, parentId) {
  const children = await driveListChildren(accessToken, parentId);
  return children.filter((f) => f.mimeType !== 'application/vnd.google-apps.folder');
}

async function driveDownloadFile(accessToken, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error?.message || 'Falha ao baixar o arquivo do Drive.');
  }
  return Buffer.from(await res.arrayBuffer());
}

function execFileAsync(cmd, args, options) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); return; }
      resolve({ stdout, stderr });
    });
  });
}

// Formato "custom" do pg_dump (-Fc): binário, já comprimido sozinho, e
// restaurável com pg_restore - evita ter que gzipar por fora.
async function dumpPostgres(destPath) {
  await execFileAsync(
    'pg_dump',
    ['--no-owner', '--no-privileges', '--format=custom', '--file', destPath],
    { env: { ...process.env, ...PG_ENV }, maxBuffer: 1024 * 1024 * 1024 }
  );
}

async function tarFunctions(destPath) {
  await execFileAsync('tar', ['czf', destPath, '-C', FUNCTIONS_DIR, '.'], { maxBuffer: 1024 * 1024 * 1024 });
}

// AAAAMMDDHHmm (sem separador) - vira o nome da subpasta de cada rodada.
function backupFolderStamp(date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// Mantém só as N subpastas (uma por rodada) mais recentes dentro da
// pasta configurada - excluir a subpasta já leva os 2 arquivos junto.
async function pruneOldBackups(accessToken, config) {
  // driveListFolders já vem em ordem decrescente de criação.
  const folders = await driveListFolders(accessToken, config.driveFolderId);
  const toDelete = folders.slice(config.retentionCount);
  for (const f of toDelete) {
    await driveDeleteFile(accessToken, f.id);
  }
}

async function performBackup() {
  const config = readBackupConfig();
  if (!config.googleRefreshToken) throw new Error('Google Drive não está conectado.');
  if (!config.driveFolderId) throw new Error('Nenhuma pasta do Drive configurada.');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
  const dbPath = path.join(tmpDir, 'db.dump');
  const fnPath = path.join(tmpDir, 'edge-functions.tar.gz');

  try {
    const accessToken = await refreshGoogleAccessToken(config.googleClientId, config.googleClientSecret, config.googleRefreshToken);

    await dumpPostgres(dbPath);
    await tarFunctions(fnPath);

    const dayFolder = await driveCreateFolder(accessToken, backupFolderStamp(), config.driveFolderId);

    await driveUploadFile(accessToken, { name: 'db.dump', parents: [dayFolder.id], mimeType: 'application/octet-stream', filePath: dbPath });
    await driveUploadFile(accessToken, { name: 'edge-functions.tar.gz', parents: [dayFolder.id], mimeType: 'application/gzip', filePath: fnPath });

    await pruneOldBackups(accessToken, config);

    writeBackupConfig({ ...readBackupConfig(), lastRunAt: new Date().toISOString(), lastRunStatus: 'ok', lastRunError: null });
  } catch (e) {
    console.error(`Backup falhou: ${e.message}`);
    writeBackupConfig({ ...readBackupConfig(), lastRunAt: new Date().toISOString(), lastRunStatus: 'error', lastRunError: e.message });
    throw e;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runBackupInBackground() {
  backupRunning = true;
  performBackup()
    .catch((e) => console.error(`Backup em segundo plano falhou: ${e.message}`))
    .finally(() => { backupRunning = false; });
}

// Roda a cada 5 min só a checagem (barata: 1 leitura de arquivo); dispara
// o backup de verdade quando já passou tempo suficiente desde a última
// rodada com sucesso ou falha (evita tentar de novo a cada 5 min se o
// Drive estiver fora do ar, por exemplo).
function maybeRunScheduledBackup() {
  if (backupRunning) return;
  const config = readBackupConfig();
  if (!config.googleRefreshToken || !config.driveFolderId) return;
  const frequencyMs = (config.frequencyHours || 24) * 60 * 60 * 1000;
  const lastRun = config.lastRunAt ? new Date(config.lastRunAt).getTime() : 0;
  if (Date.now() - lastRun < frequencyMs) return;
  runBackupInBackground();
}

setInterval(maybeRunScheduledBackup, 5 * 60 * 1000);

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
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${PROJECT_TITLE}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script>
<style>
  :root, html[data-theme="dark"] {
    --bg:#0a0b0a; --glow:rgba(62,207,142,0.16); --card-glow:rgba(62,207,142,0.08);
    --grid-line:rgba(255,255,255,0.025); --header-border:rgba(255,255,255,0.08);
    --text-hi:#f5f6f5; --text-hi2:#f2f3f2; --text-mid:#9a9d9b; --text-lo:#7d807e; --row-text:#c7cac8;
    --accent:#3ecf8e; --toggle-border:rgba(255,255,255,0.12); --toggle-bg:rgba(255,255,255,0.03); --toggle-color:#c7cac8;
    --btn-sec-border:rgba(255,255,255,0.14); --btn-sec-bg:rgba(255,255,255,0.03);
    --card-bg-top:rgba(255,255,255,0.045); --card-bg-bot:rgba(255,255,255,0.015); --card-border:rgba(255,255,255,0.09); --card-shadow:none;
    --field-bg:rgba(255,255,255,0.045); --field-border:rgba(255,255,255,0.08); --field-bar:rgba(255,255,255,0.32);
    --tile-bg:rgba(255,255,255,0.04); --tile-border:rgba(255,255,255,0.07); --icon-muted:rgba(255,255,255,0.4);
    --svg-stroke:rgba(255,255,255,0.22); --svg-stroke-2:rgba(255,255,255,0.14); --svg-stroke-3:rgba(255,255,255,0.3);
    --dot-neutral:#ffffff; --grid-dot:rgba(255,255,255,0.14);
    --bubble-bg:rgba(255,255,255,0.07); --bubble-border:rgba(255,255,255,0.12); --bubble-dot:#e7e9e8;
    --dash-border:rgba(255,255,255,0.09); --pill-bg:rgba(255,255,255,0.04); --pill-border:rgba(255,255,255,0.08); --pill-text:#7d807e;
    --error-bg:rgba(220,60,60,.12); --error-border:rgba(220,60,60,.35); --error-text:#ff9b9b;
  }
  html[data-theme="light"] {
    --bg:#f7f8f7; --glow:rgba(62,207,142,0.1); --card-glow:rgba(62,207,142,0.06);
    --grid-line:rgba(0,0,0,0.035); --header-border:rgba(0,0,0,0.08);
    --text-hi:#14151a; --text-hi2:#181917; --text-mid:#5c605e; --text-lo:#6b6e6c; --row-text:#3a3d3b;
    --accent:#0d7a4e; --toggle-border:rgba(0,0,0,0.12); --toggle-bg:rgba(0,0,0,0.03); --toggle-color:#4b4f4d;
    --btn-sec-border:rgba(0,0,0,0.15); --btn-sec-bg:rgba(0,0,0,0.02);
    --card-bg-top:#ffffff; --card-bg-bot:#ffffff; --card-border:rgba(0,0,0,0.08); --card-shadow:0 1px 3px rgba(0,0,0,0.04);
    --field-bg:rgba(0,0,0,0.035); --field-border:rgba(0,0,0,0.08); --field-bar:rgba(0,0,0,0.28);
    --tile-bg:rgba(0,0,0,0.03); --tile-border:rgba(0,0,0,0.07); --icon-muted:rgba(0,0,0,0.42);
    --svg-stroke:rgba(0,0,0,0.28); --svg-stroke-2:rgba(0,0,0,0.16); --svg-stroke-3:rgba(0,0,0,0.34);
    --dot-neutral:#20211f; --grid-dot:rgba(0,0,0,0.16);
    --bubble-bg:rgba(0,0,0,0.045); --bubble-border:rgba(0,0,0,0.1); --bubble-dot:#3a3d3b;
    --dash-border:rgba(0,0,0,0.1); --pill-bg:rgba(0,0,0,0.03); --pill-border:rgba(0,0,0,0.08); --pill-text:#6b6e6c;
    --error-bg:#fef2f2; --error-border:#fecaca; --error-text:#b91c1c;
  }
  * { box-sizing:border-box; }
  body { margin:0; font-family:'Inter',system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--text-hi2); transition:background .25s; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { opacity:.8; }
  ::selection { background:#3ecf8e; color:#06110c; }
  @keyframes pulseDot { 0%,100% { opacity:.35; transform:scale(.8); } 50% { opacity:1; transform:scale(1); } }
  @keyframes floatY { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-8px); } }

  .page { position:relative; min-height:100vh; overflow:hidden; }
  .bg-glow { position:absolute; top:-260px; left:50%; transform:translateX(-50%); width:1100px; height:520px; background:radial-gradient(ellipse at center, var(--glow) 0%, rgba(62,207,142,0) 70%); pointer-events:none; }
  .bg-grid { position:absolute; inset:0; background-image:linear-gradient(var(--grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--grid-line) 1px, transparent 1px); background-size:64px 64px; -webkit-mask-image:linear-gradient(to bottom, black, transparent 60%); mask-image:linear-gradient(to bottom, black, transparent 60%); pointer-events:none; }

  header { position:relative; display:flex; align-items:center; justify-content:space-between; padding:22px 48px; border-bottom:1px solid var(--header-border); flex-wrap:wrap; gap:12px; }
  .logo { display:flex; align-items:center; gap:10px; font-weight:600; font-size:15px; color:var(--text-hi2); }
  .logo svg { color:#3ecf8e; fill:#3ecf8e; width:20px; height:20px; }
  .header-actions { display:flex; align-items:center; gap:12px; }
  .icon-btn { width:36px; height:36px; border-radius:8px; border:1px solid var(--toggle-border); background:var(--toggle-bg); color:var(--toggle-color); display:flex; align-items:center; justify-content:center; cursor:pointer; padding:0; }
  .icon-btn:hover { border-color:var(--accent); color:var(--accent); }
  .icon-btn svg { width:16px; height:16px; }
  #sun-ic { display:none; }
  .btn-outline { font-family:inherit; font-size:14px; font-weight:500; cursor:pointer; border-radius:8px; padding:9px 18px; border:1px solid var(--btn-sec-border); background:var(--btn-sec-bg); color:var(--text-hi); }
  .btn-outline:hover { border-color:var(--accent); color:var(--accent); }

  main { position:relative; max-width:1220px; margin:0 auto; padding:96px 48px 40px; }
  .hero h1, .hero h2 { font-size:56px; line-height:1.08; font-weight:700; margin:0; letter-spacing:-0.02em; }
  .hero h1 { color:var(--text-hi); }
  .hero h2 { color:var(--accent); margin-top:6px; }
  .hero p { max-width:620px; margin:28px 0 0; font-size:17px; line-height:1.6; color:var(--text-mid); }
  .hero-actions { display:flex; gap:14px; margin-top:32px; flex-wrap:wrap; }
  .btn-primary, .btn-secondary { font-family:inherit; font-size:15px; font-weight:600; cursor:pointer; border-radius:8px; padding:13px 26px; }
  .btn-primary { border:none; background:#128a5c; color:#fff; box-shadow:0 0 0 1px rgba(62,207,142,.25), 0 8px 24px rgba(18,138,92,.25); }
  .btn-primary:hover { background:#0e6f4a; }
  .btn-secondary { border:1px solid var(--btn-sec-border); background:var(--btn-sec-bg); color:var(--text-hi); }
  .btn-secondary:hover { border-color:var(--accent); color:var(--accent); }
  a.btn-primary, a.btn-secondary, a.btn-outline { text-decoration:none; display:inline-block; }

  .row-4 { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:18px; margin-top:64px; }
  .row-3 { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:18px; margin-top:18px; }
  @media (max-width:900px) { .row-4, .row-3 { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @media (max-width:600px) { .row-4, .row-3 { grid-template-columns:1fr; } .hero h1, .hero h2 { font-size:38px; } header { padding:18px 24px; } main { padding:56px 24px 40px; } }

  .card { height:360px; background:linear-gradient(180deg, var(--card-bg-top), var(--card-bg-bot)); border:1px solid var(--card-border); border-radius:14px; padding:24px 22px 0; display:flex; flex-direction:column; overflow:hidden; position:relative; box-shadow:var(--card-shadow); }
  .row-3 .card { height:380px; }
  .card-icon { color:var(--accent); display:inline-flex; }
  .card-icon svg { width:20px; height:20px; }
  .card-title { margin-top:14px; font-size:16px; font-weight:600; color:var(--text-hi2); }
  .card-desc { margin-top:8px; font-size:13.5px; line-height:1.55; color:var(--text-mid); }

  .graphic-center { flex:1; margin:14px -22px 0; display:flex; align-items:center; justify-content:center; }
  .graphic-glow { background:radial-gradient(ellipse at 50% 35%, var(--card-glow), transparent 70%); }

  .field-grid { flex:1; margin-top:14px; padding:2px 4px 0; display:grid; grid-template-columns:1fr 1fr; gap:8px; align-content:start; -webkit-mask-image:linear-gradient(to bottom, black 40%, transparent 92%); mask-image:linear-gradient(to bottom, black 40%, transparent 92%); }
  .field { height:30px; border-radius:7px; background:var(--field-bg); border:1px solid var(--field-border); display:flex; align-items:center; padding:0 10px; }
  .field-bar { height:6px; border-radius:3px; background:var(--field-bar); }

  .edge-graphic { flex:1; margin-top:14px; display:flex; flex-direction:column; align-items:center; justify-content:space-between; padding-bottom:16px; }
  .code-chip { align-self:flex-start; font-family:'SF Mono',Consolas,monospace; font-size:11px; color:#c7cac8; background:#1a1b1a; border:1px solid rgba(255,255,255,.1); border-radius:6px; padding:6px 10px; white-space:nowrap; }
  .code-chip .dollar { color:#3ecf8e; }

  .tile-grid { flex:1; margin-top:14px; padding:0 2px; display:grid; grid-template-columns:repeat(4,1fr); grid-auto-rows:auto; gap:6px; align-content:start; -webkit-mask-image:linear-gradient(to bottom, black 55%, transparent 96%); mask-image:linear-gradient(to bottom, black 55%, transparent 96%); }
  .tile { border-radius:6px; background:var(--tile-bg); border:1px solid var(--tile-border); display:flex; align-items:center; justify-content:center; aspect-ratio:1; }
  .tile svg { width:13px; height:13px; color:var(--icon-muted); }

  .realtime-graphic { flex:1; margin:14px -22px 0; position:relative; overflow:hidden; background-image:radial-gradient(circle, var(--grid-dot) 1px, transparent 1.2px); background-size:16px 16px; }
  .cursor { position:absolute; display:flex; flex-direction:column; align-items:flex-start; gap:5px; }
  .cursor svg { width:17px; height:17px; }
  .cursor-ana { left:22%; top:24%; }
  .cursor-ana svg { color:var(--accent); transform:rotate(-8deg); }
  .cursor-rio { left:46%; bottom:16%; }
  .cursor-rio svg { color:var(--text-mid); transform:rotate(6deg); }
  .tag { font-size:10px; padding:2px 7px; border-radius:4px; color:#fff; font-weight:500; }
  .tag-ana { background:#128a5c; }
  .tag-rio { background:#2b2d2c; }
  .bubble { position:absolute; right:14%; top:46%; display:flex; align-items:center; gap:5px; background:var(--bubble-bg); border:1px solid var(--bubble-border); border-radius:14px; padding:7px 11px; }
  .bubble span { width:5px; height:5px; border-radius:50%; background:var(--bubble-dot); display:inline-block; animation:pulseDot 1.4s ease-in-out infinite; }
  .bubble span:nth-child(2) { animation-delay:.2s; }
  .bubble span:nth-child(3) { animation-delay:.4s; }

  .cube-wrap { flex:1; margin-top:8px; display:flex; align-items:center; justify-content:center; }
  .cube-wrap svg { animation:floatY 4.5s ease-in-out infinite; }

  .api-rows { flex:1; margin-top:10px; display:flex; flex-direction:column; }
  .api-row { display:flex; align-items:center; gap:9px; padding:8px 0; border-bottom:1px dashed var(--dash-border); }
  .api-row:last-child { border-bottom:none; }
  .api-row svg { width:12px; height:12px; color:var(--icon-muted); flex-shrink:0; }
  .api-name { font-size:12px; color:var(--row-text); font-family:'SF Mono',Consolas,monospace; }
  .api-spacer { flex:1; }
  .api-pill { font-size:10.5px; font-family:'SF Mono',Consolas,monospace; color:var(--pill-text); background:var(--pill-bg); border:1px solid var(--pill-border); border-radius:20px; padding:3px 9px; white-space:nowrap; }
  .api-pill b { color:var(--accent); font-weight:400; }

  .footer-note { margin-top:56px; padding:28px 0 64px; font-size:15px; color:var(--text-lo); border-top:1px solid var(--header-border); }

  /* --- Login --- */
  .login-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; opacity: 0; visibility: hidden;
    align-items: center; justify-content: center; padding: 16px; backdrop-filter: blur(4px);
    transition: opacity .18s ease; z-index: 50;
  }
  .login-overlay.open { opacity: 1; visibility: visible; }
  .login-card {
    width: 100%; max-width: 400px; position: relative;
    background: linear-gradient(180deg, var(--card-bg-top), var(--card-bg-bot));
    border: 1px solid var(--card-border); border-radius: 16px; padding: 40px 36px;
    box-shadow: 0 20px 60px rgba(0,0,0,.4);
    transform: scale(.96) translateY(8px); transition: transform .18s ease;
  }
  .login-overlay.open .login-card { transform: scale(1) translateY(0); }
  .login-card .close {
    position: absolute; top: 16px; right: 16px; background: none; border: none;
    color: var(--text-mid); font-size: 22px; cursor: pointer; line-height: 1;
  }
  .login-card .close:hover { color: var(--text-hi); }
  .login-card .card-logo { color: var(--accent); margin-bottom: 20px; }
  .login-card h2 { font-size: 24px; margin: 0 0 6px; color: var(--text-hi); font-weight: 700; }
  .login-card p.sub { margin: 0 0 28px; color: var(--text-mid); font-size: 14px; }
  .login-card label { display: block; font-size: 13px; margin-bottom: 6px; color: var(--text-mid); font-weight: 500; }
  .login-field { position: relative; margin-bottom: 18px; }
  .login-field svg.leading {
    position: absolute; left: 13px; top: 50%; transform: translateY(-50%); color: var(--text-mid); pointer-events: none;
  }
  .login-card input {
    width: 100%; padding: 12px 14px 12px 40px; border-radius: 9px;
    border: 1px solid var(--field-border); background: var(--field-bg); color: var(--text-hi); font-size: 14px;
    font-family: inherit; transition: border-color .15s, box-shadow .15s;
  }
  .login-card input.has-trailing { padding-right: 42px; }
  .login-card input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--card-glow); }
  .toggle-eye {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    background: none; border: none; padding: 6px; cursor: pointer; color: var(--text-mid);
    display: flex; align-items: center;
  }
  .toggle-eye:hover { color: var(--text-hi); }
  .login-submit {
    width: 100%; padding: 13px; border: none; border-radius: 9px; background: #128a5c;
    color: #fff; font-weight: 600; font-size: 14px; font-family: inherit; cursor: pointer; margin-top: 8px;
    transition: background .15s, transform .1s;
  }
  .login-submit:hover { background: #0e6f4a; }
  .login-submit:active { transform: scale(.98); }
  .login-error {
    background: var(--error-bg); border: 1px solid var(--error-border); color: var(--error-text);
    padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px;
  }
</style>
</head>
<body>
<div class="page">
  <div class="bg-glow"></div>
  <div class="bg-grid"></div>

  <header>
    <div class="logo"><i data-lucide="zap"></i><span>${PROJECT_TITLE}</span></div>
    <div class="header-actions">
      <button class="icon-btn" id="theme-toggle" aria-label="Alternar tema claro/escuro">
        <span id="moon-ic" style="display:flex;"><i data-lucide="moon"></i></span>
        <span id="sun-ic"><i data-lucide="sun"></i></span>
      </button>
      ${loggedIn
        ? `<a class="btn-outline" href="/logout">Sair</a>`
        : `<button class="btn-outline" id="enterBtn" type="button">Entrar</button>`}
    </div>
  </header>

  <main>
    <div class="hero">
      <h1>${PROJECT_TITLE}</h1>
      <h2>${PROJECT_TAGLINE}</h2>
      <p>${PROJECT_DESCRIPTION}</p>
      <div class="hero-actions">
        ${loggedIn
          ? `<a class="btn-primary" href="/admin">Painel Admin</a>
             <a class="btn-secondary" href="/">Ir para o Supabase</a>`
          : `<button class="btn-primary" id="ctaBtn" type="button">Acessar o painel</button>`}
      </div>
    </div>

    <!-- Row 1 -->
    <div class="row-4">

      <!-- Postgres -->
      <div class="card">
        <span class="card-icon"><i data-lucide="database"></i></span>
        <div class="card-title">Banco de dados Postgres</div>
        <div class="card-desc">Cada projeto é um banco Postgres completo, o mais confiável do mundo.</div>
        <div class="graphic-center graphic-glow">
          <svg viewBox="0 0 200 170" style="width:60%; max-width:150px;">
            <path d="M30,42 L30,132 A70,22 0 0,0 170,132 L170,42" fill="none" style="stroke:var(--svg-stroke); stroke-width:1.4px;"/>
            <path d="M30,87 A70,22 0 0,0 170,87" fill="none" style="stroke:var(--svg-stroke); stroke-width:1.4px;"/>
            <ellipse cx="100" cy="42" rx="70" ry="22" style="fill:var(--card-glow); stroke:#3ecf8e; stroke-width:1.5px; stroke-opacity:.7;"/>
            <circle cx="100" cy="42" r="2.5" style="fill:var(--accent); animation:pulseDot 2.6s ease-in-out infinite;"/>
          </svg>
        </div>
      </div>

      <!-- Auth -->
      <div class="card">
        <span class="card-icon"><i data-lucide="shield"></i></span>
        <div class="card-title">Autenticação</div>
        <div class="card-desc">Cadastro e login de usuários, protegendo os dados com Row Level Security.</div>
        <div class="field-grid">
          <div class="field"><div class="field-bar" style="width:70%;"></div></div>
          <div class="field"><div class="field-bar" style="width:45%;"></div></div>
          <div class="field"><div class="field-bar" style="width:80%;"></div></div>
          <div class="field"><div class="field-bar" style="width:55%;"></div></div>
          <div class="field"><div class="field-bar" style="width:38%;"></div></div>
          <div class="field"><div class="field-bar" style="width:65%;"></div></div>
        </div>
      </div>

      <!-- Edge Functions -->
      <div class="card">
        <span class="card-icon"><i data-lucide="zap"></i></span>
        <div class="card-title">Funções Edge</div>
        <div class="card-desc">Escreva código sem se preocupar em implantar ou escalar servidores.</div>
        <div class="edge-graphic">
          <div class="code-chip"><span class="dollar">$</span>&nbsp;functions deploy</div>
          <svg viewBox="0 0 220 190" style="width:74%; max-width:140px;">
            <defs><clipPath id="globeClip"><circle cx="110" cy="95" r="68"/></clipPath></defs>
            <circle cx="110" cy="95" r="68" fill="none" style="stroke:var(--svg-stroke); stroke-width:1.3px;"/>
            <g clip-path="url(#globeClip)" fill="none" style="stroke:var(--svg-stroke-2); stroke-width:1px;">
              <ellipse cx="110" cy="95" rx="26" ry="68"/>
              <ellipse cx="110" cy="95" rx="49" ry="68"/>
              <line x1="42" y1="68" x2="178" y2="68"/>
              <line x1="42" y1="123" x2="178" y2="123"/>
            </g>
            <line x1="92" y1="80" x2="138" y2="112" style="stroke:var(--svg-stroke-3);" stroke-dasharray="2 3"/>
            <line x1="138" y1="112" x2="118" y2="142" style="stroke:var(--svg-stroke-3);" stroke-dasharray="2 3"/>
            <circle cx="92" cy="80" r="3" style="fill:var(--accent); animation:pulseDot 2.2s ease-in-out infinite;"/>
            <circle cx="138" cy="112" r="3" style="fill:var(--dot-neutral);"/>
            <circle cx="118" cy="142" r="3" style="fill:var(--accent); animation:pulseDot 2.2s ease-in-out infinite .6s;"/>
          </svg>
        </div>
      </div>

      <!-- Storage -->
      <div class="card">
        <span class="card-icon"><i data-lucide="archive"></i></span>
        <div class="card-title">Armazenamento</div>
        <div class="card-desc">Guarde, organize e sirva arquivos grandes, de vídeos a imagens.</div>
        <div class="tile-grid">
          <div class="tile"><i data-lucide="image"></i></div>
          <div class="tile"><i data-lucide="image"></i></div>
          <div class="tile"><i data-lucide="image"></i></div>
          <div class="tile"><i data-lucide="image"></i></div>
          <div class="tile"><i data-lucide="file-text"></i></div>
          <div class="tile"><i data-lucide="file-text"></i></div>
          <div class="tile"><i data-lucide="file-text"></i></div>
          <div class="tile"><i data-lucide="file-text"></i></div>
          <div class="tile"><i data-lucide="video"></i></div>
          <div class="tile"><i data-lucide="video"></i></div>
          <div class="tile"><i data-lucide="video"></i></div>
          <div class="tile"><i data-lucide="video"></i></div>
        </div>
      </div>
    </div>

    <!-- Row 2 -->
    <div class="row-3">

      <!-- Realtime -->
      <div class="card">
        <span class="card-icon"><i data-lucide="activity"></i></span>
        <div class="card-title">Tempo real</div>
        <div class="card-desc">Construa experiências com sincronização de dados em tempo real.</div>
        <div class="realtime-graphic">
          <div class="cursor cursor-ana"><i data-lucide="mouse-pointer-2"></i><span class="tag tag-ana">Ana</span></div>
          <div class="bubble"><span></span><span></span><span></span></div>
          <div class="cursor cursor-rio"><i data-lucide="mouse-pointer-2"></i><span class="tag tag-rio">Rio</span></div>
        </div>
      </div>

      <!-- Vector -->
      <div class="card">
        <span class="card-icon"><i data-lucide="box"></i></span>
        <div class="card-title">Vetor</div>
        <div class="card-desc">Integre modelos de ML para guardar, indexar e buscar embeddings vetoriais.</div>
        <div class="cube-wrap">
          <svg viewBox="0 0 180 170" style="width:62%; max-width:150px;">
            <g fill="none" style="stroke:var(--svg-stroke-3); stroke-width:1.4px;">
              <path d="M90,20 L140,46 L90,72 L40,46 Z"/>
              <path d="M40,46 L40,118 L90,144 L90,72 Z"/>
              <path d="M140,46 L140,118 L90,144 L90,72 Z"/>
            </g>
            <circle cx="65" cy="35" r="2.5" style="fill:var(--accent);"/>
            <circle cx="115" cy="60" r="2" style="fill:var(--dot-neutral);"/>
            <circle cx="55" cy="90" r="3" style="fill:var(--accent); opacity:.8; animation:pulseDot 2.4s ease-in-out infinite;"/>
            <circle cx="125" cy="95" r="2" style="fill:var(--dot-neutral);"/>
            <circle cx="70" cy="120" r="2" style="fill:var(--accent); opacity:.6;"/>
            <circle cx="30" cy="60" r="2" style="fill:var(--dot-neutral);"/>
            <circle cx="150" cy="75" r="2.5" style="fill:var(--accent); opacity:.7; animation:pulseDot 2.4s ease-in-out infinite .8s;"/>
          </svg>
        </div>
      </div>

      <!-- Data APIs -->
      <div class="card">
        <span class="card-icon"><i data-lucide="grid-3x3"></i></span>
        <div class="card-title">APIs de dados</div>
        <div class="card-desc">APIs REST prontas para uso, geradas a partir do seu banco.</div>
        <div class="api-rows">
          <div class="api-row"><i data-lucide="table"></i><span class="api-name">livros</span><span class="api-spacer"></span><span class="api-pill">.../v1/<b>livros</b></span></div>
          <div class="api-row"><i data-lucide="table"></i><span class="api-name">autores</span><span class="api-spacer"></span><span class="api-pill">.../v1/<b>autores</b></span></div>
          <div class="api-row"><i data-lucide="table"></i><span class="api-name">episodios</span><span class="api-spacer"></span><span class="api-pill">.../v1/<b>episodios</b></span></div>
          <div class="api-row"><i data-lucide="table"></i><span class="api-name">poemas</span><span class="api-spacer"></span><span class="api-pill">.../v1/<b>poemas</b></span></div>
          <div class="api-row"><i data-lucide="table"></i><span class="api-name">generos</span><span class="api-spacer"></span><span class="api-pill">.../v1/<b>generos</b></span></div>
        </div>
      </div>
    </div>

    <div class="footer-note">Use um ou todos. Ferramentas integradas em uma única plataforma.</div>
  </main>
</div>

${loggedIn ? '' : `
<div class="login-overlay${error ? ' open' : ''}" id="loginOverlay">
  <div class="login-card">
    <button class="close" id="closeBtn" type="button" aria-label="Fechar">&times;</button>
    <svg class="card-logo" width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h7l-1 8 11-14h-7l1-6Z"></path></svg>
    <h2>Bem-vindo(a) de volta</h2>
    <p class="sub">Entre com suas credenciais de administrador.</p>
    ${error ? `<div class="login-error">${error}</div>` : ''}
    <form method="POST" action="/login">
      <input type="hidden" name="rd" value="${safeRedirect}">
      <label for="username">Usuário</label>
      <div class="login-field">
        <svg class="leading" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
        <input type="text" id="username" name="username" autocomplete="username" required autofocus>
      </div>
      <label for="password">Senha</label>
      <div class="login-field">
        <svg class="leading" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
        <input class="has-trailing" type="password" id="password" name="password" autocomplete="current-password" required>
        <button class="toggle-eye" id="toggleEye" type="button" aria-label="Mostrar senha">
          <svg id="eyeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        </button>
      </div>
      <button class="login-submit" type="submit">Entrar</button>
    </form>
  </div>
</div>
`}

<script>
  if (window.lucide) { try { lucide.createIcons(); } catch (e) {} }
  var root = document.documentElement;
  var moonIc = document.getElementById('moon-ic');
  var sunIc = document.getElementById('sun-ic');
  function syncThemeIcons(t) {
    moonIc.style.display = t === 'light' ? 'none' : 'flex';
    sunIc.style.display = t === 'light' ? 'flex' : 'none';
  }
  document.getElementById('theme-toggle').addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    syncThemeIcons(next);
    try { localStorage.setItem('theme', next); } catch (e) {}
  });
  syncThemeIcons(root.getAttribute('data-theme') || 'dark');

  ${loggedIn ? '' : `
  var overlay = document.getElementById('loginOverlay');
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

// Página pública exigida pelo Google Cloud Console pra publicar o app
// OAuth usado no Backup (veja docs/backup-google-drive.md) - não usa
// sessão nem tem nada sensível, só o texto que o Google pede.
function renderPrivacyPage() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="index, follow">
  <meta name="description" content="Política de Privacidade do painel administrativo self-hosted de ${PROJECT_TITLE}.">
  <title>Política de Privacidade | ${PROJECT_TITLE}</title>

  <style>
    :root {
      --bg: #f5f7fb;
      --card: #ffffff;
      --text: #1f2937;
      --muted: #6b7280;
      --border: #e5e7eb;
      --accent: #2563eb;
      --accent-soft: #eff6ff;
      --max-width: 860px;
    }

    * {
      box-sizing: border-box;
    }

    html {
      scroll-behavior: smooth;
    }

    body {
      margin: 0;
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.7;
    }

    .container {
      width: min(calc(100% - 32px), var(--max-width));
      margin: 48px auto;
    }

    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 40px;
      box-shadow: 0 12px 40px rgba(15, 23, 42, 0.06);
    }

    header {
      margin-bottom: 32px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
    }

    h1, h2 {
      line-height: 1.25;
      color: #111827;
    }

    h1 {
      margin: 0 0 10px;
      font-size: clamp(2rem, 5vw, 2.8rem);
      letter-spacing: -0.03em;
    }

    h2 {
      margin-top: 34px;
      margin-bottom: 12px;
      font-size: 1.35rem;
    }

    p {
      margin: 0 0 16px;
    }

    ul {
      padding-left: 22px;
      margin: 12px 0 18px;
    }

    li {
      margin-bottom: 10px;
    }

    a {
      color: var(--accent);
      text-decoration: none;
      font-weight: 600;
    }

    a:hover {
      text-decoration: underline;
    }

    code {
      background: #f3f4f6;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 6px;
      font-size: 0.95em;
    }

    .notice {
      margin: 22px 0;
      padding: 18px 20px;
      background: var(--accent-soft);
      border-left: 4px solid var(--accent);
      border-radius: 10px;
    }

    .meta {
      color: var(--muted);
      font-size: 0.95rem;
    }

    footer {
      margin-top: 36px;
      padding-top: 22px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 0.92rem;
    }

    @media (max-width: 640px) {
      .container {
        margin: 20px auto;
      }

      .card {
        padding: 26px 20px;
        border-radius: 14px;
      }
    }
  </style>
</head>

<body>
  <main class="container">
    <article class="card">
      <header>
        <h1>Política de Privacidade</h1>
        <p class="meta">${PROJECT_TITLE} — painel administrativo self-hosted, de uso pessoal.</p>
      </header>

      <section>
        <h2>1. Sobre esta aplicação</h2>
        <p>
          Este painel administrativo é uma aplicação self-hosted utilizada para fins pessoais e administrativos.
          Esta Política de Privacidade explica, de forma clara e objetiva, como funciona a integração do painel
          com o Google Drive para realização de backups.
        </p>
      </section>

      <section>
        <h2>2. Integração com o Google Drive</h2>
        <p>
          O painel utiliza a API do Google Drive exclusivamente para o recurso de backup automático.
        </p>

        <div class="notice">
          A integração utiliza o escopo <code>drive.file</code>, que permite acesso somente aos arquivos
          criados ou utilizados pelo próprio aplicativo. O painel não possui acesso geral aos demais arquivos
          armazenados no Google Drive do usuário.
        </div>

        <p>Os arquivos gerados pelo sistema podem incluir, entre outros:</p>

        <ul>
          <li>backup do banco de dados;</li>
          <li>backup das Edge Functions utilizadas pelo painel.</li>
        </ul>
      </section>

      <section>
        <h2>3. Finalidade do acesso</h2>
        <p>
          O acesso ao Google Drive é utilizado apenas para criar, armazenar e gerenciar os arquivos de backup
          produzidos pelo próprio painel administrativo.
        </p>

        <p>
          A integração não é utilizada para acessar documentos pessoais, fotografias, planilhas ou quaisquer
          outros arquivos que não estejam relacionados ao backup criado pelo aplicativo.
        </p>
      </section>

      <section>
        <h2>4. Compartilhamento de dados</h2>
        <p>
          Nenhum dado obtido por meio desta aplicação é vendido, comercializado, compartilhado ou repassado
          a terceiros para fins publicitários, comerciais ou de perfilamento.
        </p>
      </section>

      <section>
        <h2>5. Armazenamento dos backups</h2>
        <p>
          Os arquivos de backup permanecem armazenados somente na pasta do Google Drive selecionada pelo
          próprio usuário administrador.
        </p>
      </section>

      <section>
        <h2>6. Revogação do acesso</h2>
        <p>
          A conexão com o Google Drive pode ser interrompida a qualquer momento.
        </p>

        <ul>
          <li>
            Pelo próprio painel administrativo, na opção
            <strong>Backup → Desconectar</strong>.
          </li>
          <li>
            Diretamente pela conta Google, na página de permissões:
            <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">
              myaccount.google.com/permissions
            </a>.
          </li>
        </ul>

        <p>
          Ao revogar a autorização, o painel deixa de ter acesso aos recursos concedidos pela integração.
        </p>
      </section>

      <section>
        <h2>7. Segurança e controle</h2>
        <p>
          O uso da integração com o Google Drive é limitado à finalidade de backup do painel administrativo.
          O usuário administrador mantém o controle sobre a conexão e pode revogar o acesso sempre que desejar.
        </p>
      </section>

      <section>
        <h2>8. Alterações nesta política</h2>
        <p>
          Esta Política de Privacidade poderá ser atualizada caso o funcionamento da aplicação ou da integração
          com o Google Drive seja alterado. A versão mais recente estará sempre disponível nesta página.
        </p>
      </section>

      <section>
        <h2>9. Contato</h2>
        <p>
          Em caso de dúvidas sobre esta Política de Privacidade ou sobre o funcionamento da integração com o
          Google Drive, entre em contato pelo e-mail:
          <a href="mailto:luiz.primati@gmail.com">luiz.primati@gmail.com</a>.
        </p>
      </section>

      <footer>
        <p>Última atualização: setembro de 2026.</p>
      </footer>
    </article>
  </main>
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
  /* Barra lateral de arquivos da function (só aparece editando uma já
     existente - antes de salvar o index.ts pela 1a vez a pasta nem
     existe no disco ainda, então não tem onde listar/criar arquivo). */
  .editor-body { display: flex; gap: 16px; align-items: stretch; }
  .fn-files-sidebar {
    width: 180px; flex-shrink: 0; display: flex; flex-direction: column;
    border-right: 1px solid var(--border); padding-right: 12px; margin-bottom: 16px;
  }
  .fn-files-list { flex: 1; overflow-y: auto; max-height: 456px; display: flex; flex-direction: column; gap: 2px; }
  .fn-file-item { display: flex; align-items: center; justify-content: space-between; gap: 2px; border-radius: 6px; }
  .fn-file-item.active { background: var(--bg); }
  .fn-file-name {
    flex: 1; min-width: 0; text-align: left; background: none; border: none; padding: 6px 8px;
    font-size: 12px; font-family: ui-monospace, Menlo, monospace; color: var(--text-muted); cursor: pointer;
    border-radius: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .fn-file-item.active .fn-file-name { color: var(--text-strong); font-weight: 600; }
  .fn-file-name:hover { color: var(--text-strong); }
  .fn-file-del {
    background: none; border: none; padding: 4px; margin-right: 4px; color: var(--text-muted); cursor: pointer;
    border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .fn-file-del:hover { color: var(--danger-text); }
  .fn-new-file-btn { padding: 6px 8px; font-size: 12px; margin-top: 6px; }
  .fn-new-file-row input {
    width: 100%; padding: 6px 8px; margin-top: 4px; font-size: 12px; font-family: ui-monospace, Menlo, monospace;
  }
  .fn-editor-main { flex: 1; min-width: 0; }
  .settings-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 28px; max-width: 520px; }
  .backup-status {
    display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 8px;
    background: var(--bg); border: 1px solid var(--border); font-size: 13px; margin-bottom: 20px;
  }
  .backup-status .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .backup-status.connected .dot { background: var(--accent); }
  .backup-status.disconnected .dot { background: var(--text-muted); }
  .backup-connect-row { display: flex; gap: 10px; margin-bottom: 20px; }
  .subtabs { display: flex; gap: 8px; margin-bottom: 20px; }
  .subtab-btn {
    padding: 8px 16px; background: var(--bg); border: 1px solid var(--border); border-radius: 999px;
    color: var(--text-muted); font-size: 13px; font-weight: 500; cursor: pointer;
  }
  .subtab-btn.active { color: var(--text-strong); border-color: var(--accent); background: var(--bg-card); }
  .subtab-panel { display: none; }
  .subtab-panel.active { display: block; }
  .provider-row { display: flex; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
  .provider-btn {
    display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 10px;
    background: var(--bg-card); border: 1px solid var(--border); color: var(--text-muted);
    font-size: 13px; font-weight: 500; cursor: pointer;
  }
  .provider-btn:disabled { cursor: not-allowed; opacity: .5; }
  .provider-btn.active { border-color: var(--accent); color: var(--text-strong); }
  .provider-badge {
    background: rgba(62,207,142,.15); color: var(--accent); font-size: 11px; font-weight: 600;
    padding: 2px 8px; border-radius: 999px; margin-left: 4px;
  }
  .backup-breadcrumb { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; font-size: 13px; color: var(--text-muted); }
  .backup-breadcrumb button { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 13px; padding: 0; }
  #backupBrowserCard { max-width: 100%; }
  #backupBrowserCard table { max-width: 720px; }
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
  .card .close {
    position: absolute; top: 16px; right: 16px; background: none; border: none;
    color: var(--text-muted); font-size: 22px; line-height: 1; cursor: pointer; padding: 4px;
  }
  .card .close:hover { color: var(--text-strong); }
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
      <a class="btn btn-outline" href="/">Ir para Supabase</a>
      <a class="btn btn-outline" href="/login">Voltar</a>
      <a class="btn btn-outline" href="/logout">Sair</a>
    </div>
  </nav>

  <div class="wrap">
    <div class="tabs">
      <button class="tab-btn active" data-tab="users" type="button">Usuários</button>
      <button class="tab-btn" data-tab="functions" type="button">Edge Functions</button>
      <button class="tab-btn" data-tab="settings" type="button">Backup</button>
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

    <div class="tab-panel" id="settingsPanel">
      <div class="toolbar">
        <div>
          <h1>Backup</h1>
          <p class="sub">Backup automático do banco de dados e das Edge Functions.</p>
        </div>
      </div>

      <div class="subtabs">
        <button class="subtab-btn active" data-subtab="configure" type="button">Configurar</button>
        <button class="subtab-btn" data-subtab="manage" type="button">Gerenciar</button>
      </div>

      <div class="subtab-panel active" id="backupConfigurePanel">
        <div class="provider-row">
          <button type="button" class="provider-btn active" data-provider="google-drive">
            <svg width="20" height="20" viewBox="0 0 24 24"><path fill="#0F9D58" d="M8.5 3h7l7.5 13-3.5 6h-15z"/><path fill="#FFCF63" d="M8.5 3l-7.5 13 3.5 6h4l-7.5-13z"/><path fill="#4285F4" d="M12.5 16l-3.5 6h11l3.5-6z"/></svg>
            <span>Google Drive</span>
            <span class="provider-badge">Padrão</span>
          </button>
          <button type="button" class="provider-btn" data-provider="azure" disabled title="Em breve">
            <svg width="20" height="20" viewBox="0 0 24 24"><path fill="#0072C6" d="M7.5 2 2 19.5h6.5L14 8z"/><path fill="#0072C6" d="M13 2 6 22h16L15 9z" opacity=".55"/></svg>
            <span>Azure Storage</span>
          </button>
          <button type="button" class="provider-btn" data-provider="aws" disabled title="Em breve">
            <svg width="20" height="20" viewBox="0 0 24 24"><path fill="#FF9900" d="M4 15c4 3 12 3 16 0v2c-4 3-12 3-16 0z"/><circle cx="12" cy="10" r="7" fill="#232F3E"/></svg>
            <span>AWS Storage</span>
          </button>
        </div>
        <p class="hint">Google Drive é o local padrão de backup agora - outros destinos (Azure, AWS) chegam depois.</p>

        <div class="settings-card" id="googleDriveProviderPanel">
          <div class="msg" id="backupMsg"></div>
          <div class="backup-status" id="backupStatus"></div>

          <label for="backupClientId">Google Client ID</label>
          <input type="text" id="backupClientId" autocomplete="off" placeholder="xxxxxxxx.apps.googleusercontent.com">
          <label for="backupClientSecret">Google Client Secret</label>
          <input type="password" id="backupClientSecret" autocomplete="off" placeholder="cole o client secret">
          <p class="hint">Crie em console.cloud.google.com (veja o passo a passo no README) - a chave fica salva só no servidor, nunca é mostrada de volta aqui.</p>

          <label for="backupApiKey">Google API Key (só para o seletor de pastas)</label>
          <input type="text" id="backupApiKey" autocomplete="off" placeholder="AIza...">
          <p class="hint">Também criada em console.cloud.google.com - precisa ativar a "Google Picker API". Essa chave roda no navegador (restrinja por domínio lá no Cloud Console).</p>

          <div class="backup-connect-row">
            <button type="button" class="btn" id="backupConnectBtn">Conectar ao Google Drive</button>
            <button type="button" class="btn" id="backupDisconnectBtn" style="display:none;">Desconectar</button>
          </div>

          <label for="backupFolder">Pasta do Drive</label>
          <input type="text" id="backupFolder" autocomplete="off" placeholder="Nenhuma pasta selecionada - use os botões abaixo ou cole um link/ID">
          <div class="backup-connect-row">
            <button type="button" class="btn" id="backupPickFolderBtn">Escolher pasta no Drive</button>
            <button type="button" class="btn" id="backupNewFolderBtn">+ Criar nova pasta</button>
          </div>
          <div class="fn-new-file-row" id="backupNewFolderRow" style="display:none;">
            <input type="text" id="backupNewFolderInput" placeholder="Nome da nova pasta">
          </div>

          <label for="backupFrequency">Frequência</label>
          <select id="backupFrequency">
            <option value="6">A cada 6 horas</option>
            <option value="12">A cada 12 horas</option>
            <option value="24">Diariamente</option>
            <option value="48">A cada 2 dias</option>
            <option value="168">Semanalmente</option>
          </select>

          <label for="backupRetention">Retenção (quantos backups manter)</label>
          <input type="number" id="backupRetention" min="1" step="1">

          <div class="editor-actions">
            <div class="spacer"></div>
            <button type="button" class="btn" id="backupRunNowBtn">Rodar backup agora</button>
            <button type="button" class="btn btn-primary" id="backupSaveBtn">Salvar</button>
          </div>
        </div>
      </div>

      <div class="subtab-panel" id="backupManagePanel">
        <div class="settings-card" id="backupBrowserCard">
          <div class="msg" id="backupManageMsg"></div>
          <div class="backup-breadcrumb" id="backupBreadcrumb"></div>
          <table>
            <thead id="backupBrowserHead"></thead>
            <tbody id="backupBrowserBody"></tbody>
          </table>
        </div>
      </div>
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
      <button type="button" class="close" id="fnCloseBtn" aria-label="Fechar">&times;</button>
      <h2 id="fnFormTitle">Nova função</h2>
      <div class="msg" id="fnFormMsg"></div>
      <label for="fn-name">Nome da função</label>
      <input type="text" id="fn-name" autocomplete="off" placeholder="ex: minha-funcao">
      <p class="hint" id="fnNameHint">Letras minúsculas, números, "-" ou "_", começando com letra. Não pode ser alterado depois de criada.</p>
      <div class="editor-body">
        <div class="fn-files-sidebar" id="fnFilesSidebar" style="display:none;">
          <div class="fn-files-list" id="fnFileList"></div>
          <div class="fn-new-file-row" id="fnNewFileRow" style="display:none;">
            <input type="text" id="fnNewFileInput" placeholder="ex: utils.ts">
          </div>
          <button type="button" class="btn fn-new-file-btn" id="fnNewFileBtn">+ Novo arquivo</button>
        </div>
        <div class="fn-editor-main">
          <label for="fn-code" id="fnCodeLabel">Código (index.ts)</label>
          <textarea id="fn-code"></textarea>
        </div>
      </div>
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
              '<button data-action="edit" class="icon-only" title="Editar" aria-label="Editar">' + PENCIL_ICON + '</button>' +
              '<button data-action="delete" class="icon-only danger" title="Excluir" aria-label="Excluir">' + TRASH_ICON + '</button>' +
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
    var tabPanels = {
      users: document.getElementById('usersPanel'),
      functions: document.getElementById('functionsPanel'),
      settings: document.getElementById('settingsPanel'),
    };
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
        if (btn.dataset.tab === 'settings') {
          loadBackupConfig();
        }
      });
    });

    // --- Backup ---
    function backupShowMsg(text, kind) {
      var el = document.getElementById('backupMsg');
      el.textContent = text;
      el.className = 'msg ' + kind;
      el.style.display = 'block';
    }
    function backupHideMsg() { document.getElementById('backupMsg').style.display = 'none'; }

    var backupRunNowBtn = document.getElementById('backupRunNowBtn');

    function renderBackupConfig(cfg) {
      document.getElementById('backupClientId').value = cfg.googleClientId || '';
      document.getElementById('backupClientSecret').value = '';
      document.getElementById('backupClientSecret').placeholder = cfg.hasClientSecret ? 'deixe em branco para manter o valor salvo' : 'cole o client secret';
      document.getElementById('backupApiKey').value = cfg.googleApiKey || '';
      document.getElementById('backupFolder').value = cfg.driveFolderId || '';
      document.getElementById('backupFrequency').value = String(cfg.frequencyHours || 24);
      document.getElementById('backupRetention').value = cfg.retentionCount || 7;

      var statusEl = document.getElementById('backupStatus');
      var connectBtn = document.getElementById('backupConnectBtn');
      var disconnectBtn = document.getElementById('backupDisconnectBtn');
      if (cfg.connected) {
        statusEl.className = 'backup-status connected';
        var lastRun = cfg.lastRunAt ? new Date(cfg.lastRunAt).toLocaleString('pt-BR') : 'nunca rodou ainda';
        var lastStatus = cfg.lastRunStatus === 'error' ? ' - falhou: ' + (cfg.lastRunError || '') : cfg.lastRunStatus === 'ok' ? ' - ok' : '';
        statusEl.innerHTML = '<span class="dot"></span><span>Conectado ao Google Drive. Último backup: ' + lastRun + lastStatus + '</span>';
        connectBtn.style.display = 'none';
        disconnectBtn.style.display = 'inline-block';
      } else {
        statusEl.className = 'backup-status disconnected';
        statusEl.innerHTML = '<span class="dot"></span><span>Não conectado ao Google Drive.</span>';
        connectBtn.style.display = 'inline-block';
        disconnectBtn.style.display = 'none';
      }

      backupRunNowBtn.disabled = !!cfg.running;
      backupRunNowBtn.textContent = cfg.running ? 'Backup em andamento...' : 'Rodar backup agora';
    }

    function loadBackupConfig() {
      fetch('/admin/api/backup/config').then(function (r) { return r.json(); }).then(renderBackupConfig);
    }

    document.getElementById('backupSaveBtn').addEventListener('click', function () {
      backupHideMsg();
      var payload = {
        googleClientId: document.getElementById('backupClientId').value.trim(),
        googleClientSecret: document.getElementById('backupClientSecret').value,
        googleApiKey: document.getElementById('backupApiKey').value.trim(),
        driveFolderInput: document.getElementById('backupFolder').value.trim(),
        frequencyHours: Number(document.getElementById('backupFrequency').value),
        retentionCount: Number(document.getElementById('backupRetention').value),
      };
      fetch('/admin/api/backup/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) { backupShowMsg(res.d.error || 'Não foi possível salvar.', 'error'); return; }
          backupShowMsg('Salvo.', 'ok');
          setTimeout(backupHideMsg, 1500);
          renderBackupConfig(res.d);
        });
    });

    document.getElementById('backupConnectBtn').addEventListener('click', function () {
      window.location.href = '/admin/api/backup/oauth/start';
    });

    document.getElementById('backupDisconnectBtn').addEventListener('click', function (e) {
      showConfirmPopover(e.currentTarget, 'Desconectar o Google Drive? Os backups agendados param até você reconectar.', function () {
        fetch('/admin/api/backup/disconnect', { method: 'POST' }).then(function () { loadBackupConfig(); });
      });
    });

    // --- Seletor de pasta (Google Picker) ---
    function loadGooglePicker(callback) {
      if (window.google && window.google.picker) { callback(); return; }
      if (window.gapi) { gapi.load('picker', callback); return; }
      var script = document.createElement('script');
      script.src = 'https://apis.google.com/js/api.js';
      script.onload = function () { gapi.load('picker', callback); };
      script.onerror = function () { backupShowMsg('Não foi possível carregar o seletor do Google (sem internet ou CDN bloqueada).', 'error'); };
      document.head.appendChild(script);
    }

    document.getElementById('backupPickFolderBtn').addEventListener('click', function () {
      backupHideMsg();
      var apiKey = document.getElementById('backupApiKey').value.trim();
      if (!apiKey) { backupShowMsg('Salve a Google API Key antes de escolher uma pasta.', 'error'); return; }
      fetch('/admin/api/backup/drive/access-token').then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (res) {
        if (!res.ok) { backupShowMsg(res.d.error || 'Conecte o Google Drive primeiro.', 'error'); return; }
        loadGooglePicker(function () {
          // setSelectFolderEnabled(true) é o que faz uma pasta virar
          // selecionável (habilita o botão "Selecionar" ao clicar nela,
          // em vez de só navegar pra dentro) - o nome certo do método,
          // confirmado na documentação oficial (não é "setSelectFolderEnum").
          var view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
            .setIncludeFolders(true)
            .setSelectFolderEnabled(true);
          var picker = new google.picker.PickerBuilder()
            .addView(view)
            .setOAuthToken(res.d.accessToken)
            .setDeveloperKey(apiKey)
            .setCallback(function (data) {
              if (data.action === google.picker.Action.PICKED) {
                var folder = data.docs[0];
                document.getElementById('backupFolder').value = folder.id;
                backupShowMsg('Pasta selecionada: ' + folder.name + ' - clique em Salvar pra confirmar.', 'ok');
              }
            })
            .build();
          picker.setVisible(true);
        });
      });
    });

    var backupNewFolderBtn = document.getElementById('backupNewFolderBtn');
    var backupNewFolderRow = document.getElementById('backupNewFolderRow');
    var backupNewFolderInput = document.getElementById('backupNewFolderInput');

    function confirmNewBackupFolder() {
      var name = backupNewFolderInput.value.trim();
      if (!name) return;
      backupHideMsg();
      fetch('/admin/api/backup/drive/create-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) { backupShowMsg(res.d.error || 'Não foi possível criar a pasta.', 'error'); return; }
          backupNewFolderRow.style.display = 'none';
          document.getElementById('backupFolder').value = res.d.id;
          backupShowMsg('Pasta "' + res.d.name + '" criada - clique em Salvar pra confirmar.', 'ok');
        });
    }

    backupNewFolderBtn.addEventListener('click', function () {
      backupNewFolderRow.style.display = 'block';
      backupNewFolderInput.value = '';
      backupNewFolderInput.focus();
    });
    backupNewFolderInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); confirmNewBackupFolder(); }
      if (e.key === 'Escape') { backupNewFolderRow.style.display = 'none'; }
    });
    backupNewFolderInput.addEventListener('blur', function () {
      setTimeout(function () { backupNewFolderRow.style.display = 'none'; }, 150);
    });

    // --- Rodar agora, com acompanhamento de progresso ---
    function pollBackupStatus() {
      fetch('/admin/api/backup/config').then(function (r) { return r.json(); }).then(function (cfg) {
        renderBackupConfig(cfg);
        if (cfg.running) {
          setTimeout(pollBackupStatus, 2000);
        } else if (cfg.lastRunStatus === 'ok') {
          backupShowMsg('Backup concluído com sucesso.', 'ok');
          setTimeout(backupHideMsg, 4000);
        } else if (cfg.lastRunStatus === 'error') {
          backupShowMsg('Backup falhou: ' + (cfg.lastRunError || ''), 'error');
        }
      });
    }

    backupRunNowBtn.addEventListener('click', function () {
      backupHideMsg();
      fetch('/admin/api/backup/run-now', { method: 'POST' })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) { backupShowMsg(res.d.error || 'Não foi possível iniciar o backup.', 'error'); return; }
          backupShowMsg('Backup em andamento...', 'ok');
          pollBackupStatus();
        });
    });

    // --- Backup: subabas Configurar/Gerenciar ---
    var subtabButtons = document.querySelectorAll('.subtab-btn');
    var subtabPanels = {
      configure: document.getElementById('backupConfigurePanel'),
      manage: document.getElementById('backupManagePanel'),
    };
    subtabButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        subtabButtons.forEach(function (b) { b.classList.remove('active'); });
        Object.keys(subtabPanels).forEach(function (k) { subtabPanels[k].classList.remove('active'); });
        btn.classList.add('active');
        subtabPanels[btn.dataset.subtab].classList.add('active');
        if (btn.dataset.subtab === 'manage') { loadBackupManageRoot(); }
      });
    });

    // --- Backup: seletor de provedor (só Google Drive funciona por ora) ---
    document.querySelectorAll('.provider-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        document.querySelectorAll('.provider-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
      });
    });

    // --- Backup: navegador de pastas (aba Gerenciar) ---
    var backupBrowserFolder = null; // null = lista de rodadas; senão { id, name } da rodada aberta

    function backupManageShowMsg(text, kind) {
      var el = document.getElementById('backupManageMsg');
      el.textContent = text;
      el.className = 'msg ' + kind;
      el.style.display = 'block';
    }
    function backupManageHideMsg() { document.getElementById('backupManageMsg').style.display = 'none'; }

    // Sem regex de propósito: "\d" dentro do template literal do
    // renderAdminPage vira "d" de verdade quando o HTML é montado no
    // servidor (\d não é um escape especial de string/template literal
    // em JS, então o backslash some) - já pegou esse projeto antes com
    // sub_filter do Nginx, mesma família de bug. Fatiar string evita o
    // problema de vez.
    function formatBackupFolderName(name) {
      if (!name || name.length !== 12) return name;
      var year = name.slice(0, 4), month = name.slice(4, 6), day = name.slice(6, 8);
      var hour = name.slice(8, 10), minute = name.slice(10, 12);
      return day + '/' + month + '/' + year + ' ' + hour + ':' + minute;
    }

    function formatBytes(bytes) {
      bytes = Number(bytes) || 0;
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function renderBackupBreadcrumb() {
      var el = document.getElementById('backupBreadcrumb');
      el.innerHTML = '';
      var rootBtn = document.createElement('button');
      rootBtn.type = 'button';
      rootBtn.textContent = 'Backups';
      rootBtn.addEventListener('click', function () { loadBackupManageRoot(); });
      el.appendChild(rootBtn);
      if (backupBrowserFolder) {
        var sep = document.createElement('span');
        sep.textContent = '/';
        el.appendChild(sep);
        var current = document.createElement('span');
        current.textContent = formatBackupFolderName(backupBrowserFolder.name);
        el.appendChild(current);
      }
    }

    function loadBackupManageRoot() {
      backupBrowserFolder = null;
      backupManageHideMsg();
      renderBackupBreadcrumb();
      document.getElementById('backupBrowserHead').innerHTML = '<tr><th>Data/hora</th><th></th></tr>';
      var body = document.getElementById('backupBrowserBody');
      body.innerHTML = '<tr><td colspan="2">Carregando...</td></tr>';
      fetch('/admin/api/backup/drive/backups').then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (res) {
        if (!res.ok) { body.innerHTML = ''; backupManageShowMsg(res.d.error || 'Não foi possível listar os backups.', 'error'); return; }
        body.innerHTML = '';
        if (!res.d.length) { body.innerHTML = '<tr><td colspan="2">Nenhum backup ainda.</td></tr>'; return; }
        res.d.forEach(function (folder) {
          var tr = document.createElement('tr');

          var tdName = document.createElement('td');
          var openBtn = document.createElement('button');
          openBtn.type = 'button';
          openBtn.className = 'btn';
          openBtn.style.padding = '4px 10px';
          openBtn.style.fontSize = '13px';
          openBtn.textContent = formatBackupFolderName(folder.name);
          openBtn.addEventListener('click', function () { openBackupFolder(folder); });
          tdName.appendChild(openBtn);

          var tdActions = document.createElement('td');
          var delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'icon-only danger';
          delBtn.title = 'Excluir backup';
          delBtn.innerHTML = TRASH_ICON;
          delBtn.addEventListener('click', function () {
            showConfirmPopover(delBtn, 'Excluir todo o backup de ' + formatBackupFolderName(folder.name) + '? Essa ação não pode ser desfeita.', function () {
              fetch('/admin/api/backup/drive/item?id=' + encodeURIComponent(folder.id), { method: 'DELETE' })
                .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                .then(function (res2) {
                  if (!res2.ok) { backupManageShowMsg(res2.d.error || 'Não foi possível excluir.', 'error'); return; }
                  loadBackupManageRoot();
                });
            });
          });
          tdActions.appendChild(delBtn);

          tr.appendChild(tdName);
          tr.appendChild(tdActions);
          body.appendChild(tr);
        });
      });
    }

    function openBackupFolder(folder) {
      backupBrowserFolder = folder;
      backupManageHideMsg();
      renderBackupBreadcrumb();
      document.getElementById('backupBrowserHead').innerHTML = '<tr><th>Arquivo</th><th>Tamanho</th><th></th></tr>';
      var body = document.getElementById('backupBrowserBody');
      body.innerHTML = '<tr><td colspan="3">Carregando...</td></tr>';
      fetch('/admin/api/backup/drive/files?folderId=' + encodeURIComponent(folder.id)).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (res) {
        if (!res.ok) { body.innerHTML = ''; backupManageShowMsg(res.d.error || 'Não foi possível listar os arquivos.', 'error'); return; }
        body.innerHTML = '';
        if (!res.d.length) { body.innerHTML = '<tr><td colspan="3">Pasta vazia.</td></tr>'; return; }
        res.d.forEach(function (file) {
          var tr = document.createElement('tr');

          var tdName = document.createElement('td');
          tdName.textContent = file.name;

          var tdSize = document.createElement('td');
          tdSize.textContent = formatBytes(file.size);

          var tdActions = document.createElement('td');
          var actions = document.createElement('div');
          actions.className = 'row-actions';

          var downloadLink = document.createElement('a');
          downloadLink.className = 'icon-only';
          downloadLink.title = 'Baixar';
          downloadLink.setAttribute('aria-label', 'Baixar ' + file.name);
          downloadLink.href = '/admin/api/backup/drive/download?fileId=' + encodeURIComponent(file.id) + '&name=' + encodeURIComponent(file.name);
          downloadLink.innerHTML = DOWNLOAD_ICON;
          actions.appendChild(downloadLink);

          var delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'icon-only danger';
          delBtn.title = 'Excluir arquivo';
          delBtn.innerHTML = TRASH_ICON;
          delBtn.addEventListener('click', function () {
            showConfirmPopover(delBtn, 'Excluir o arquivo "' + file.name + '"?', function () {
              fetch('/admin/api/backup/drive/item?id=' + encodeURIComponent(file.id), { method: 'DELETE' })
                .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                .then(function (res2) {
                  if (!res2.ok) { backupManageShowMsg(res2.d.error || 'Não foi possível excluir.', 'error'); return; }
                  openBackupFolder(folder);
                });
            });
          });
          actions.appendChild(delBtn);

          tdActions.appendChild(actions);
          tr.appendChild(tdName);
          tr.appendChild(tdSize);
          tr.appendChild(tdActions);
          body.appendChild(tr);
        });
      });
    }

    // --- Edge Functions ---
    var fnOverlay = document.getElementById('fnOverlay');
    var fnNameField = document.getElementById('fn-name');
    var fnCodeArea = document.getElementById('fn-code');
    var fnFormMsg = document.getElementById('fnFormMsg');
    var fnUrlHint = document.getElementById('fnUrlHint');
    var fnFilesSidebar = document.getElementById('fnFilesSidebar');
    var fnFileList = document.getElementById('fnFileList');
    var fnNewFileBtn = document.getElementById('fnNewFileBtn');
    var fnNewFileRow = document.getElementById('fnNewFileRow');
    var fnNewFileInput = document.getElementById('fnNewFileInput');
    var fnCodeLabel = document.getElementById('fnCodeLabel');
    var editingFunctionName = null;
    var fnEditor = null;
    var fnFiles = [];
    var fnActiveFile = 'index.ts';
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

    // URL da API de arquivos de uma function (a raiz sempre é o index.ts,
    // que também é o único arquivo que já existe assim que a function é
    // criada - por isso a barra lateral só aparece editando uma existente).
    function fnFileUrl(name, relPath) {
      return '/admin/api/functions/' + encodeURIComponent(name) + '/files/' +
        relPath.split('/').map(encodeURIComponent).join('/');
    }

    function renderFnFileList() {
      fnFileList.innerHTML = '';
      fnFiles.forEach(function (relPath) {
        var row = document.createElement('div');
        row.className = 'fn-file-item' + (relPath === fnActiveFile ? ' active' : '');

        var nameBtn = document.createElement('button');
        nameBtn.type = 'button';
        nameBtn.className = 'fn-file-name';
        nameBtn.textContent = relPath;
        nameBtn.title = relPath;
        nameBtn.addEventListener('click', function () { switchFnFile(relPath); });
        row.appendChild(nameBtn);

        if (relPath !== 'index.ts') {
          var delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'fn-file-del';
          delBtn.title = 'Excluir arquivo';
          delBtn.setAttribute('aria-label', 'Excluir ' + relPath);
          delBtn.innerHTML = TRASH_ICON;
          delBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            showConfirmPopover(delBtn, 'Excluir o arquivo "' + relPath + '"?', function () {
              fetch(fnFileUrl(editingFunctionName, relPath), { method: 'DELETE' })
                .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                .then(function (res) {
                  if (!res.ok) { fnShowMsg(res.d.error || 'Não foi possível excluir o arquivo.', 'error'); return; }
                  fnFiles = fnFiles.filter(function (f) { return f !== relPath; });
                  if (fnActiveFile === relPath) { switchFnFile('index.ts'); }
                  else { renderFnFileList(); }
                });
            });
          });
          row.appendChild(delBtn);
        }
        fnFileList.appendChild(row);
      });
    }

    function switchFnFile(relPath) {
      fnActiveFile = relPath;
      fnCodeLabel.textContent = 'Código (' + relPath + ')';
      renderFnFileList();
      setCode('');
      fetch(fnFileUrl(editingFunctionName, relPath)).then(function (r) { return r.json(); }).then(function (d) {
        setCode(d.code || '');
        if (fnEditor) setTimeout(function () { fnEditor.refresh(); }, 10);
      });
    }

    function loadFnFileList() {
      fetch('/admin/api/functions/' + encodeURIComponent(editingFunctionName) + '/files')
        .then(function (r) { return r.json(); })
        .then(function (files) {
          fnFiles = files;
          renderFnFileList();
        });
    }

    function confirmNewFnFile() {
      var relPath = fnNewFileInput.value.trim();
      if (!relPath) return;
      if (fnFiles.indexOf(relPath) !== -1) { fnShowMsg('Já existe um arquivo com esse nome.', 'error'); return; }
      fetch(fnFileUrl(editingFunctionName, relPath), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '' }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) { fnShowMsg(res.d.error || 'Não foi possível criar o arquivo.', 'error'); return; }
          fnNewFileRow.style.display = 'none';
          fnFiles.push(relPath);
          switchFnFile(relPath);
        });
    }

    fnNewFileBtn.addEventListener('click', function () {
      fnNewFileRow.style.display = 'block';
      fnNewFileInput.value = '';
      fnNewFileInput.focus();
    });
    fnNewFileInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); confirmNewFnFile(); }
      if (e.key === 'Escape') { fnNewFileRow.style.display = 'none'; }
    });
    fnNewFileInput.addEventListener('blur', function () {
      setTimeout(function () { fnNewFileRow.style.display = 'none'; }, 150);
    });

    function openFunctionEditor(name) {
      fnHideMsg();
      ensureEditor();
      editingFunctionName = name;
      fnActiveFile = 'index.ts';
      fnCodeLabel.textContent = 'Código (index.ts)';
      if (name) {
        document.getElementById('fnFormTitle').textContent = 'Editar ' + name;
        fnNameField.value = name;
        fnNameField.disabled = true;
        fnUrlHint.textContent = window.location.origin + '/functions/v1/' + name;
        fnFilesSidebar.style.display = 'flex';
        fnFiles = ['index.ts'];
        renderFnFileList();
        setCode('');
        loadFnFileList();
        fetch(fnFileUrl(name, 'index.ts')).then(function (r) { return r.json(); }).then(function (d) {
          setCode(d.code || '');
        });
      } else {
        document.getElementById('fnFormTitle').textContent = 'Nova função';
        fnNameField.value = '';
        fnNameField.disabled = false;
        fnUrlHint.textContent = '';
        fnFilesSidebar.style.display = 'none';
        fnFiles = [];
        setCode(FUNCTION_TEMPLATE);
      }
      fnOverlay.classList.add('open');
      if (fnEditor) setTimeout(function () { fnEditor.refresh(); }, 10);
    }
    function closeFunctionEditor() { fnOverlay.classList.remove('open'); }

    document.getElementById('newFnBtn').addEventListener('click', function () { openFunctionEditor(null); });
    document.getElementById('fnCancelBtn').addEventListener('click', closeFunctionEditor);
    document.getElementById('fnCloseBtn').addEventListener('click', closeFunctionEditor);

    fnNameField.addEventListener('input', function () {
      if (!fnNameField.disabled) {
        fnUrlHint.textContent = fnNameField.value ? window.location.origin + '/functions/v1/' + fnNameField.value : '';
      }
    });

    document.getElementById('fnSaveBtn').addEventListener('click', function () {
      fnHideMsg();
      var name = (editingFunctionName || fnNameField.value.trim());
      if (!name) { fnShowMsg('Informe um nome para a função.', 'error'); return; }
      var url = editingFunctionName ? fnFileUrl(name, fnActiveFile) : ('/admin/api/functions/' + encodeURIComponent(name));
      fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: getCode() }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) { fnShowMsg(res.d.error || 'Não foi possível salvar.', 'error'); return; }
          if (editingFunctionName) {
            fnShowMsg('Salvo.', 'ok');
            setTimeout(fnHideMsg, 1500);
          } else {
            closeFunctionEditor();
            loadFunctions();
          }
        });
    });

    var PENCIL_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>';
    var TRASH_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>';
    var DOWNLOAD_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';

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

    // Volta do fluxo OAuth do Google (aba Backup).
    var backupParams = new URLSearchParams(window.location.search);
    if (backupParams.has('backupConnected') || backupParams.has('backupError')) {
      var settingsTabBtn = document.querySelector('.tab-btn[data-tab="settings"]');
      if (settingsTabBtn) settingsTabBtn.click();
      if (backupParams.has('backupError')) {
        backupShowMsg('Não foi possível conectar ao Google Drive: ' + backupParams.get('backupError'), 'error');
      } else {
        backupShowMsg('Conectado ao Google Drive.', 'ok');
        setTimeout(backupHideMsg, 2500);
      }
      window.history.replaceState({}, '', window.location.pathname);
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

  if (url.pathname === '/legal/privacidade' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPrivacyPage());
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
      const rest = decodeURIComponent(url.pathname.slice(fnPrefix.length));
      const filesMatch = rest.match(/^([^/]+)\/files(?:\/(.*))?$/);

      if (filesMatch) {
        const name = filesMatch[1];
        const relPath = filesMatch[2] || '';
        if (!isValidFunctionName(name)) { sendJson(res, 400, { error: 'Nome de função inválido.' }); return; }

        if (relPath === '') {
          if (req.method === 'GET') { sendJson(res, 200, listFunctionFiles(name)); return; }
          sendJson(res, 404, { error: 'Caminho de arquivo não informado.' });
          return;
        }

        if (!isValidRelFilePath(relPath)) { sendJson(res, 400, { error: 'Nome de arquivo inválido.' }); return; }

        if (req.method === 'GET') {
          const code = readFunctionFile(name, relPath);
          if (code === null) { sendJson(res, 404, { error: 'Arquivo não encontrado.' }); return; }
          sendJson(res, 200, { path: relPath, code });
          return;
        }

        if (req.method === 'PUT') {
          collectBody(req, (body) => {
            let data;
            try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'JSON inválido.' }); return; }
            const code = typeof data.code === 'string' ? data.code : '';
            if (relPath === 'index.ts' && !code.trim()) {
              sendJson(res, 400, { error: 'O código do index.ts não pode ficar vazio.' });
              return;
            }
            try {
              writeFunctionFile(name, relPath, code);
            } catch (e) {
              console.error(`Não foi possível gravar ${name}/${relPath}: ${e.message}`);
              sendJson(res, 500, { error: 'Não foi possível salvar - a pasta de functions está gravável no container?' });
              return;
            }
            sendJson(res, 200, { path: relPath });
          });
          return;
        }

        if (req.method === 'DELETE') {
          if (relPath === 'index.ts') {
            sendJson(res, 400, { error: 'Não é possível excluir o index.ts por aqui - exclua a função inteira se quiser removê-lo.' });
            return;
          }
          try {
            deleteFunctionFile(name, relPath);
          } catch (e) {
            sendJson(res, 500, { error: `Não foi possível excluir: ${e.message}` });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        return;
      }

      const name = rest;

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

  // --- Backup (aba Backup), também restrito a role === 'admin' ---
  if (url.pathname.startsWith('/admin/api/backup')) {
    const user = getSessionUser(req);
    if (!isAdmin(user)) {
      sendJson(res, user ? 403 : 401, { error: 'Acesso restrito a administradores.' });
      return;
    }

    if (url.pathname === '/admin/api/backup/config' && req.method === 'GET') {
      sendJson(res, 200, maskBackupConfig(readBackupConfig()));
      return;
    }

    if (url.pathname === '/admin/api/backup/config' && req.method === 'PUT') {
      collectBody(req, (body) => {
        let data;
        try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'JSON inválido.' }); return; }
        const next = readBackupConfig();

        if (typeof data.googleClientId === 'string') next.googleClientId = data.googleClientId.trim();
        if (typeof data.googleClientSecret === 'string' && data.googleClientSecret.trim()) {
          next.googleClientSecret = data.googleClientSecret.trim();
        }
        if (typeof data.googleApiKey === 'string') next.googleApiKey = data.googleApiKey.trim();
        if (typeof data.driveFolderInput === 'string' && data.driveFolderInput.trim()) {
          const id = extractDriveFolderId(data.driveFolderInput);
          if (!id) { sendJson(res, 400, { error: 'Não entendi essa pasta do Drive - cole o link ou o ID da pasta.' }); return; }
          next.driveFolderId = id;
        }
        const freq = Number(data.frequencyHours);
        if (Number.isFinite(freq) && freq > 0) next.frequencyHours = freq;
        const ret = Number(data.retentionCount);
        if (Number.isFinite(ret) && ret >= 1) next.retentionCount = Math.floor(ret);

        if (!tryWriteBackupConfig(res, next)) return;
        sendJson(res, 200, maskBackupConfig(next));
      });
      return;
    }

    if (url.pathname === '/admin/api/backup/oauth/start' && req.method === 'GET') {
      const config = readBackupConfig();
      if (!config.googleClientId || !config.googleClientSecret) {
        sendJson(res, 400, { error: 'Salve o Client ID e o Client Secret antes de conectar.' });
        return;
      }
      const state = crypto.randomBytes(16).toString('hex');
      pendingOAuthStates.add(state);
      const authUrl = buildGoogleAuthUrl(config.googleClientId, backupRedirectUri(req), state);
      res.writeHead(302, { Location: authUrl });
      res.end();
      return;
    }

    if (url.pathname === '/admin/api/backup/oauth/callback' && req.method === 'GET') {
      const errParam = url.searchParams.get('error');
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');

      if (errParam) {
        res.writeHead(302, { Location: `/admin?backupError=${encodeURIComponent(errParam)}` });
        res.end();
        return;
      }
      if (!state || !pendingOAuthStates.has(state)) {
        res.writeHead(302, { Location: `/admin?backupError=${encodeURIComponent('Estado inválido - tente conectar de novo.')}` });
        res.end();
        return;
      }
      pendingOAuthStates.delete(state);

      const config = readBackupConfig();
      exchangeGoogleCode(config.googleClientId, config.googleClientSecret, code, backupRedirectUri(req))
        .then((tokens) => {
          writeBackupConfig({ ...readBackupConfig(), googleRefreshToken: tokens.refresh_token || config.googleRefreshToken });
          res.writeHead(302, { Location: '/admin?backupConnected=1' });
          res.end();
        })
        .catch((e) => {
          res.writeHead(302, { Location: `/admin?backupError=${encodeURIComponent(e.message)}` });
          res.end();
        });
      return;
    }

    // Token de acesso de curta duração pro Google Picker rodar no
    // navegador do admin (escolher/navegar pastas do Drive) - nunca é
    // persistido, só passa por essa resposta.
    if (url.pathname === '/admin/api/backup/drive/access-token' && req.method === 'GET') {
      withDriveAccessToken(res, (accessToken) => sendJson(res, 200, { accessToken }));
      return;
    }

    // Botão "+ Criar nova pasta" do seletor - cria direto na raiz do
    // Drive (é só pra escolher o destino dos backups, não precisa
    // navegar/criar em subpastas específicas).
    if (url.pathname === '/admin/api/backup/drive/create-folder' && req.method === 'POST') {
      collectBody(req, (body) => {
        let data;
        try { data = JSON.parse(body); } catch { sendJson(res, 400, { error: 'JSON inválido.' }); return; }
        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!name) { sendJson(res, 400, { error: 'Informe um nome para a pasta.' }); return; }
        withDriveAccessToken(res, (accessToken) =>
          driveCreateFolder(accessToken, name).then((folder) => sendJson(res, 200, folder))
        );
      });
      return;
    }

    // Aba Gerenciar: lista as subpastas de backup (uma por rodada) dentro
    // da pasta configurada.
    if (url.pathname === '/admin/api/backup/drive/backups' && req.method === 'GET') {
      const config = readBackupConfig();
      if (!config.driveFolderId) { sendJson(res, 400, { error: 'Configure a pasta do Drive primeiro.' }); return; }
      withDriveAccessToken(res, (accessToken) =>
        driveListFolders(accessToken, config.driveFolderId).then((folders) => sendJson(res, 200, folders))
      );
      return;
    }

    // Aba Gerenciar: lista os arquivos dentro de uma subpasta de backup.
    if (url.pathname === '/admin/api/backup/drive/files' && req.method === 'GET') {
      const folderId = url.searchParams.get('folderId');
      if (!folderId) { sendJson(res, 400, { error: 'folderId não informado.' }); return; }
      withDriveAccessToken(res, (accessToken) =>
        driveListFiles(accessToken, folderId).then((files) => sendJson(res, 200, files))
      );
      return;
    }

    // Aba Gerenciar: baixa um arquivo (db.dump/edge-functions.tar.gz) de
    // dentro de uma subpasta de backup.
    if (url.pathname === '/admin/api/backup/drive/download' && req.method === 'GET') {
      const fileId = url.searchParams.get('fileId');
      const name = url.searchParams.get('name') || 'backup';
      if (!fileId) { sendJson(res, 400, { error: 'fileId não informado.' }); return; }
      withDriveAccessToken(res, (accessToken) =>
        driveDownloadFile(accessToken, fileId).then((buffer) => {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${name.replace(/[^A-Za-z0-9_.-]/g, '_')}"`,
            'Content-Length': buffer.length,
          });
          res.end(buffer);
        })
      );
      return;
    }

    // Aba Gerenciar: exclui um arquivo OU uma subpasta de backup inteira
    // (excluir a pasta já leva os arquivos de dentro junto).
    if (url.pathname === '/admin/api/backup/drive/item' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) { sendJson(res, 400, { error: 'id não informado.' }); return; }
      withDriveAccessToken(res, (accessToken) =>
        driveDeleteFile(accessToken, id).then(() => sendJson(res, 200, { ok: true }))
      );
      return;
    }

    if (url.pathname === '/admin/api/backup/disconnect' && req.method === 'POST') {
      if (!tryWriteBackupConfig(res, { ...readBackupConfig(), googleRefreshToken: '' })) return;
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/admin/api/backup/run-now' && req.method === 'POST') {
      if (backupRunning) { sendJson(res, 409, { error: 'Já tem um backup em andamento.' }); return; }
      const config = readBackupConfig();
      if (!config.googleRefreshToken) { sendJson(res, 400, { error: 'Conecte o Google Drive primeiro.' }); return; }
      if (!config.driveFolderId) { sendJson(res, 400, { error: 'Configure a pasta do Drive primeiro.' }); return; }
      runBackupInBackground();
      sendJson(res, 200, { started: true });
      return;
    }
  }

  res.writeHead(404);
  res.end('not found');
}

server.listen(PORT, () => console.log(`login-server ouvindo na porta ${PORT}`));
