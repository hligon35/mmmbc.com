/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const https = require('https');
const http = require('http');
const express = require('express');
const compression = require('compression');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const csrf = require('csurf');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const mime = require('mime-types');
const sharp = require('sharp');
const { OAuth2Client } = require('google-auth-library');

const { logger, audit, requestLogger, LOG_DIR, tailFile } = require('./lib/logger');
const { maybeEncrypt, maybeDecrypt } = require('./lib/crypto');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// Optional Postgres (for announcements + bulletins)
const POSTGRES_URL = String(process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();
let pgPool = null;
if (POSTGRES_URL) {
  try {
    // eslint-disable-next-line global-require
    const { Pool } = require('pg');
    const sslMode = String(process.env.PGSSLMODE || process.env.PGSSL || '').trim().toLowerCase();
    const ssl = ['1', 'true', 'yes', 'y', 'on', 'require'].includes(sslMode)
      ? { rejectUnauthorized: false }
      : undefined;
    pgPool = new Pool({ connectionString: POSTGRES_URL, ssl });
    console.log('[MMMBC Admin] Postgres enabled for announcements/bulletins');
  } catch (err) {
    console.warn('[MMMBC Admin] Postgres URL set but pg is not installed/usable. Falling back to JSON files.');
    pgPool = null;
  }
}

function hasPostgres() {
  return Boolean(pgPool);
}

async function pgQuery(text, params) {
  if (!pgPool) throw new Error('Postgres is not configured');
  return pgPool.query(text, params);
}

function toIsoOrEmpty(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  if (Number.isNaN(t)) return '';
  return d.toISOString();
}

const ROOT_DIR = path.resolve(__dirname, '..');
const ADMIN_DIR = path.resolve(__dirname);
const DATA_DIR = process.env.ADMIN_DATA_DIR
  ? path.resolve(process.env.ADMIN_DATA_DIR)
  : path.join(ADMIN_DIR, 'data');
const UPLOADS_DIR = process.env.ADMIN_UPLOADS_DIR
  ? path.resolve(process.env.ADMIN_UPLOADS_DIR)
  : path.join(ADMIN_DIR, 'uploads');
const DOCS_UPLOADS_DIR = path.join(UPLOADS_DIR, 'docs');
const BULLETINS_UPLOADS_DIR = path.join(UPLOADS_DIR, 'bulletins');
const ROOT_BULLETINS_DIR = path.join(ROOT_DIR, 'bulletins');
const GALLERY_DIR = path.join(ROOT_DIR, 'ConImg', 'gallery');
const PORT = Number(process.env.PORT || 8787);
const HOST = String(process.env.HOST || '').trim();

function envBool(name, defaultValue) {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) return defaultValue;
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return defaultValue;
}

const ENABLE_EXPORTS = envBool('ENABLE_EXPORTS', true);
// In production (e.g., Render) default to trusting a single reverse proxy.
// Override with TRUST_PROXY=false when running directly (to avoid header spoofing).
const TRUST_PROXY = envBool('TRUST_PROXY', process.env.NODE_ENV === 'production');
// Allow ENFORCE_HTTPS=false to override production defaults (useful for LAN-only Pi setups).
const ENFORCE_HTTPS = envBool('ENFORCE_HTTPS', process.env.NODE_ENV === 'production');
const ENABLE_CSP = String(process.env.ENABLE_CSP || '').toLowerCase() === 'true';
const SESSIONS_DIR = process.env.SESSIONS_DIR
  ? path.resolve(process.env.SESSIONS_DIR)
  : path.join(os.tmpdir(), 'mmmbc-admin-sessions');

function listenWithPortFallback(appInstance, startPort, { maxTries = 25, host } = {}) {
  return new Promise((resolve, reject) => {
    let port = Number(startPort);
    if (!Number.isFinite(port) || port <= 0) port = 8787;
    const endPort = port + Math.max(0, Number(maxTries) - 1);

    const tryListen = () => {
      const server = host
        ? appInstance.listen(port, host, () => resolve({ server, port }))
        : appInstance.listen(port, () => resolve({ server, port }));
      server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE' && port < endPort) {
          console.warn(`[MMMBC Admin] Port ${port} in use. Trying ${port + 1}…`);
          port += 1;
          setTimeout(tryListen, 50);
          return;
        }
        reject(err);
      });
    };

    tryListen();
  });
}

function mustGetEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return String(val);
}

const jsonCache = new Map();
function readJson(filePath, fallback) {
  try {
    const stat = fs.statSync(filePath);
    const cached = jsonCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.value;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    jsonCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value: parsed });
    return parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
  try { jsonCache.delete(filePath); } catch { /* ignore */ }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function newId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function timingSafeEqualString(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function getBearerToken(req) {
  const raw = String(req.headers.authorization || '').trim();
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? String(m[1] || '').trim() : '';
}

function hasValidSupportApiToken(req) {
  const expected = String(process.env.SUPPORT_API_TOKEN || '').trim();
  if (!expected) return false;
  const provided = String(req.headers['x-support-token'] || '').trim() || getBearerToken(req);
  if (!provided) return false;
  return timingSafeEqualString(provided, expected);
}

function getSupportActor(req) {
  const sessionEmail = String(req.session?.user?.email || '').trim();
  if (sessionEmail) return sessionEmail;
  const actor = String(req.headers['x-support-actor'] || '').trim();
  return actor.slice(0, 120) || 'support-api';
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function googleClientId() {
  return String(process.env.GOOGLE_CLIENT_ID || '').trim();
}

function isGoogleAuthEnabled() {
  return Boolean(googleClientId());
}

let cachedGoogleOauthClient = null;
let cachedGoogleOauthClientId = '';

function getGoogleOauthClient() {
  const cid = googleClientId();
  if (!cid) return null;
  if (!cachedGoogleOauthClient || cachedGoogleOauthClientId !== cid) {
    cachedGoogleOauthClient = new OAuth2Client(cid);
    cachedGoogleOauthClientId = cid;
  }
  return cachedGoogleOauthClient;
}

function googleApprovedEmailsFromEnv() {
  const raw = String(process.env.GOOGLE_ALLOWED_EMAILS || '').trim();
  if (!raw) return new Set();
  const values = raw
    .split(',')
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean);
  return new Set(values);
}

function getBaseUrl(req) {
  // Prefer explicit base URL for invite links (useful if accessed on LAN)
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function findUserByInviteToken(users, token) {
  const hash = sha256Hex(token);
  return users.find((u) => u.inviteTokenHash === hash);
}

function isInviteValid(user) {
  if (!user?.inviteTokenHash) return false;
  if (!user?.inviteExpiresAt) return false;
  const exp = Date.parse(user.inviteExpiresAt);
  if (!Number.isFinite(exp)) return false;
  return Date.now() < exp;
}

function normalizeTotp(code) {
  return String(code || '').replace(/\s+/g, '');
}

function mailchannelsSend(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.mailchannels.net',
        path: '/tx/v1/send',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
        }
      },
      (resp) => {
        let data = '';
        resp.on('data', (chunk) => { data += chunk; });
        resp.on('end', () => {
          resolve({ status: resp.statusCode || 0, body: data });
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function decodeHtmlEntities(input) {
  return String(input || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseVideoIdFromWatchUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const v = u.searchParams.get('v');
    return v ? String(v).trim() : '';
  } catch {
    return '';
  }
}

function httpGetFollow(urlStr, { headers = {}, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      reject(e);
      return;
    }

    const lib = url.protocol === 'http:' ? http : https;

    const req = lib.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        headers
      },
      (resp) => {
        const status = resp.statusCode || 0;
        const location = String(resp.headers.location || '').trim();

        if ([301, 302, 303, 307, 308].includes(status) && location && maxRedirects > 0) {
          const nextUrl = new URL(location, url).toString();
          resp.resume();
          httpGetFollow(nextUrl, { headers, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
          return;
        }

        let data = '';
        resp.setEncoding('utf8');
        resp.on('data', (chunk) => { data += chunk; });
        resp.on('end', () => {
          resolve({ status, headers: resp.headers || {}, body: data, finalUrl: url.toString() });
        });
      }
    );

    req.on('error', reject);
    req.end();
  });
}

async function detectYoutubeLiveVideo(channelId) {
  const url = `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/live`;
  const res = await httpGetFollow(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': 'MMMBC-Local/1.0'
    }
  });

  const fromUrl = parseVideoIdFromWatchUrl(res.finalUrl);
  if (fromUrl) return { isLive: true, videoId: fromUrl, source: 'redirect' };

  const html = String(res.body || '');
  const fromHtml = (html.match(/\"videoId\"\s*:\s*\"([a-zA-Z0-9_-]{11})\"/) || [])[1];
  if (fromHtml) {
    const indicatesLive = /isLiveContent\"\s*:\s*true|\"LIVE\"/i.test(html);
    if (indicatesLive) return { isLive: true, videoId: fromHtml, source: 'html' };
  }

  return { isLive: false, videoId: '', source: 'none' };
}

async function fetchYoutubeFeed(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const res = await httpGetFollow(url, {
    headers: {
      Accept: 'application/atom+xml,text/xml;q=0.9,*/*;q=0.1',
      'User-Agent': 'MMMBC-Local/1.0'
    }
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`YouTube feed fetch failed (${res.status})`);
  const xml = String(res.body || '');

  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml))) {
    const chunk = m[1] || '';
    const id = (chunk.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    if (!id) continue;
    const titleRaw = (chunk.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const published = (chunk.match(/<published>([^<]+)<\/published>/) || [])[1] || '';
    entries.push({
      id: String(id).trim(),
      title: decodeHtmlEntities(titleRaw).trim(),
      published: String(published).trim()
    });
    if (entries.length >= 30) break;
  }
  return entries;
}

function sanitizeSegment(input) {
  return String(input || '')
    .trim()
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

const ROLE = Object.freeze({
  ADMINISTRATOR: 'administrator',
  WEBSITE_EDITOR: 'website_editor',
  FINANCE_ENTRY: 'finance_entry',
  TREASURER: 'treasurer',
  AUDITOR: 'auditor'
});

const PERMISSIONS = Object.freeze({
  WEBSITE_WRITE: 'website.write',
  COMMUNICATIONS_MANAGE: 'communications.manage',
  FINANCE_READ: 'finance.read',
  FINANCE_WRITE: 'finance.write',
  FINANCE_META: 'finance.meta',
  REPORTS_READ: 'reports.read',
  USERS_MANAGE: 'users.manage',
  SUPPORT_SEND: 'support.send',
  EXPORTS_RUN: 'exports.run'
});

const ROLE_PERMISSIONS = Object.freeze({
  [ROLE.ADMINISTRATOR]: Object.values(PERMISSIONS),
  [ROLE.WEBSITE_EDITOR]: [
    PERMISSIONS.WEBSITE_WRITE,
    PERMISSIONS.COMMUNICATIONS_MANAGE,
    PERMISSIONS.SUPPORT_SEND
  ],
  [ROLE.FINANCE_ENTRY]: [
    PERMISSIONS.FINANCE_READ,
    PERMISSIONS.FINANCE_WRITE,
    PERMISSIONS.SUPPORT_SEND
  ],
  [ROLE.TREASURER]: [
    PERMISSIONS.FINANCE_READ,
    PERMISSIONS.FINANCE_WRITE,
    PERMISSIONS.FINANCE_META,
    PERMISSIONS.REPORTS_READ,
    PERMISSIONS.EXPORTS_RUN,
    PERMISSIONS.SUPPORT_SEND
  ],
  [ROLE.AUDITOR]: [
    PERMISSIONS.FINANCE_READ,
    PERMISSIONS.REPORTS_READ,
    PERMISSIONS.SUPPORT_SEND
  ]
});

function normalizeRole(inputRole) {
  const raw = String(inputRole || '').trim().toLowerCase();
  if (!raw) return ROLE.WEBSITE_EDITOR;
  if (raw === 'admin') return ROLE.ADMINISTRATOR;
  if (raw === 'website' || raw === 'editor' || raw === 'website editor') return ROLE.WEBSITE_EDITOR;
  if (raw === 'finance' || raw === 'financeentry' || raw === 'finance_entry') return ROLE.FINANCE_ENTRY;
  if (raw === 'treasurer') return ROLE.TREASURER;
  if (raw === 'auditor' || raw === 'read-only' || raw === 'readonly') return ROLE.AUDITOR;
  if (Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, raw)) return raw;
  return ROLE.WEBSITE_EDITOR;
}

function permissionsForRole(role) {
  const normalized = normalizeRole(role);
  return ROLE_PERMISSIONS[normalized] || [];
}

function hasPermission(role, permission) {
  const allowed = permissionsForRole(role);
  return allowed.includes(String(permission || ''));
}

function sessionUser(req) {
  const user = req.session?.user;
  if (!user || !user.id) return null;
  return {
    ...user,
    role: normalizeRole(user.role)
  };
}

function requireAuth(req, res, next) {
  const user = sessionUser(req);
  if (user) {
    req.session.user.role = user.role;
    return next();
  }
  audit('auth_denied', {
    at: new Date().toISOString(),
    ip: req.ip,
    path: req.originalUrl,
    reason: 'no_session'
  });
  return res.status(401).json({ error: 'Unauthorized' });
}

function requirePermission(permission) {
  return (req, res, next) => {
    const user = sessionUser(req);
    if (!user) {
      audit('auth_denied', {
        at: new Date().toISOString(),
        ip: req.ip,
        path: req.originalUrl,
        reason: 'no_session'
      });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (hasPermission(user.role, permission)) return next();
    audit('authz_denied', {
      at: new Date().toISOString(),
      ip: req.ip,
      path: req.originalUrl,
      userId: user.id,
      userEmail: user.email,
      role: user.role,
      permission
    });
    return res.status(403).json({ error: 'Forbidden' });
  };
}

function requireAnyPermission(permissions) {
  const list = Array.isArray(permissions) ? permissions : [];
  return (req, res, next) => {
    const user = sessionUser(req);
    if (!user) {
      audit('auth_denied', {
        at: new Date().toISOString(),
        ip: req.ip,
        path: req.originalUrl,
        reason: 'no_session'
      });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const ok = list.some((perm) => hasPermission(user.role, perm));
    if (ok) return next();
    audit('authz_denied', {
      at: new Date().toISOString(),
      ip: req.ip,
      path: req.originalUrl,
      userId: user.id,
      userEmail: user.email,
      role: user.role,
      permissions: list
    });
    return res.status(403).json({ error: 'Forbidden' });
  };
}

function isAllowedImage(mimeType) {
  return ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType);
}

const app = express();
app.set('trust proxy', TRUST_PROXY ? 1 : false);

app.disable('x-powered-by');

// Optional HTTPS enforcement (recommended when deployed behind TLS).
// Local dev stays HTTP unless ENFORCE_HTTPS=true.
app.use((req, res, next) => {
  if (!ENFORCE_HTTPS) return next();
  const xfProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  const isHttps = req.secure || xfProto === 'https';
  if (isHttps) return next();
  if (req.method === 'GET' || req.method === 'HEAD') {
    const host = req.get('host');
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }
  return res.status(403).json({ error: 'HTTPS required' });
});

// Public YouTube status/feed (used by Pages/live_praise.html)
app.get(['/public/youtube.json', '/public/youtube'], async (req, res) => {
  // If a Worker origin is configured, prefer it to keep behavior identical to production.
  if (String(process.env.WORKER_ORIGIN || '').trim()) return proxyToWorker(req, res);

  const channelId = String(process.env.YOUTUBE_CHANNEL_ID || 'UCkAaHiYmUKIdKePifg1D2pg').trim();
  let live = { isLive: false, videoId: '', source: 'none' };
  let videos = [];
  let errors = [];

  try {
    live = await detectYoutubeLiveVideo(channelId);
  } catch (e) {
    errors.push({ type: 'live', error: String(e?.message || e).slice(0, 200) });
  }

  try {
    videos = await fetchYoutubeFeed(channelId);
  } catch (e) {
    errors.push({ type: 'feed', error: String(e?.message || e).slice(0, 200) });
  }

  // YouTube feeds can include scheduled/upcoming livestream entries, which show
  // as "offline" when embedded. Prefer already-published videos.
  if (Array.isArray(videos) && videos.length) {
    const now = Date.now();
    const graceMs = 5 * 60 * 1000;
    const published = videos.filter((v) => {
      const t = Date.parse(String(v?.published || ''));
      return Number.isFinite(t) && t <= (now + graceMs);
    });
    if (published.length) videos = published;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.end(JSON.stringify({ ok: true, channelId, live, videos, fetchedAt: new Date().toISOString(), errors }));
});

// Security headers (CSP is opt-in to avoid breaking existing inline patterns)
app.use(helmet({
  contentSecurityPolicy: ENABLE_CSP ? {
    useDefaults: true,
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "default-src": ["'self'"],
      "img-src": ["'self'", 'data:', 'blob:'],
      "style-src": ["'self'", "'unsafe-inline'"],
      "script-src": ["'self'", "'unsafe-inline'"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "frame-ancestors": ["'none'"],
      ...(ENFORCE_HTTPS ? { "upgrade-insecure-requests": [] } : {})
    }
  } : false,
  crossOriginEmbedderPolicy: false,
  // YouTube embeds can fail with "Error 153" if the browser does not send a referrer.
  // Helmet's default can be very strict; use a modern policy that still sends origin.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// HSTS should only be sent over HTTPS.
if (ENFORCE_HTTPS) {
  app.use(helmet.hsts({ maxAge: 15552000, includeSubDomains: true }));
}

app.use(requestLogger);
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(rateLimit({ windowMs: 60 * 1000, limit: 120 }));

// Brute-force protection for login endpoints (IP-based)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Try again later.' }
});

// Store sessions outside OneDrive-backed folders to avoid EPERM rename issues on Windows.
ensureDir(SESSIONS_DIR);

app.use(
  session({
    name: 'mmmbc_admin',
    secret: mustGetEnv('SESSION_SECRET'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // In production behind TLS, set Secure automatically (requires trust proxy).
      secure: (process.env.NODE_ENV === 'production' && TRUST_PROXY) ? 'auto' : false
    },
    // When session storage location changes, existing browser cookies may reference
    // session IDs whose files no longer exist. session-file-store can log noisy
    // ENOENT retries in that case. Treat missing sessions as normal.
    store: new FileStore({
      path: SESSIONS_DIR,
      // Windows can intermittently throw EPERM on atomic rename (AV/OneDrive/file indexer).
      // Allow a few retries and avoid writing on every request.
      retries: 5,
      touchAfter: 60,
      logFn: () => {}
    })
  })
);

// CSRF protection for state-changing API requests.
// Exempt login/invite flows and let the admin UI fetch a token after login.
const csrfProtection = csrf({ ignoreMethods: ['GET', 'HEAD', 'OPTIONS'] });
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const p = req.path;
  if (p === '/api/auth/login' || p === '/api/auth/logout' || p === '/api/auth/recover') return next();
  if (p === '/api/auth/google' || p === '/api/auth/providers') return next();
  if (p.startsWith('/api/invites/')) return next();
  if (p === '/api/csrf') return next();
  // Support emailer automation: allow server-to-server calls with a shared secret
  // without requiring browser CSRF cookies.
  if (p === '/api/support/message' && hasValidSupportApiToken(req)) return next();
  return csrfProtection(req, res, next);
});

app.get('/api/csrf', requireAuth, csrfProtection, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ csrfToken: req.csrfToken() });
});

// Audit trail for non-GET admin API calls (avoid logging secrets)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (!req.path.startsWith('/api/')) return;
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const user = req.session?.user;
    if (!user?.id) return;

    const redact = new Set(['password', 'newPassword', 'currentPassword', 'twoFactorCode', 'recoveryCode']);
    const bodyKeys = (req.body && typeof req.body === 'object')
      ? Object.keys(req.body).filter((k) => !redact.has(k))
      : [];

    audit('admin_action', {
      at: new Date().toISOString(),
      userId: user.id,
      userEmail: user.email,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - start,
      bodyKeys
    });
  });
  next();
});

// Serve theme.css dynamically so an authenticated admin can preview theme changes
// without writing the real theme.css file.
// NOTE: This MUST be registered before the root static middleware.
app.get('/theme.css', (req, res) => {
  const preview = req.session?.themePreview;
  if (preview) {
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buildThemeCss(preview));
  }

  // If an exported theme.css exists, serve it. Otherwise, build from saved settings.
  const themePath = path.join(ROOT_DIR, 'theme.css');
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  if (fs.existsSync(themePath)) {
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(fs.readFileSync(themePath, 'utf8'));
  }

  const settings = loadSettings();
  res.setHeader('Cache-Control', 'no-cache');
  return res.send(buildThemeCss(settings.theme));
});

// Serve the existing site (repo root)
app.use('/', express.static(ROOT_DIR, { extensions: ['html'] }));
// Serve admin UI under /admin/
app.get('/admin', (req, res, next) => {
  // Express routing matches both "/admin" and "/admin/" unless strict routing is enabled.
  // Only redirect when the request is truly missing the trailing slash.
  if (req.originalUrl === '/admin') return res.redirect(302, '/admin/');
  return next();
});

// Cloudflare Access is expected to gate /admin/* in deployments that use it.
// Remove the custom login page from all served versions by returning 404.
app.get(['/admin/login', '/admin/login.html', '/admin/login.js', '/admin/login_legacy.html'], (req, res) => {
  res.status(404).send('Not found');
});

app.use('/admin', express.static(path.join(ADMIN_DIR, 'public'), {
  extensions: ['html'],
  setHeaders: (res) => {
    // During admin work we frequently tweak CSS/JS; prevent stale assets.
    res.setHeader('Cache-Control', 'no-store');
  }
}));

// Expose gallery images and uploaded docs
// Standard gallery path (compatible with existing gallery.json)
app.use('/ConImg/gallery', express.static(GALLERY_DIR));

// CDN-style path with aggressive caching (optional; set GALLERY_URL_PREFIX="/cdn" to emit these URLs)
app.use('/cdn/ConImg/gallery', express.static(GALLERY_DIR, {
  immutable: true,
  maxAge: '365d',
  setHeaders: (res) => {
    // Allow embedding across origins if later fronted by a CDN domain.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));
app.use('/admin-uploads/docs', express.static(DOCS_UPLOADS_DIR));
app.use('/admin-uploads/bulletins', express.static(BULLETINS_UPLOADS_DIR));

const USERS_PATH = path.join(DATA_DIR, 'users.json');
const GALLERY_DATA_PATH = path.join(DATA_DIR, 'gallery.json');
const EVENTS_DATA_PATH = path.join(DATA_DIR, 'events.json');
const ANNOUNCEMENTS_DATA_PATH = path.join(DATA_DIR, 'announcements.json');
const DOCUMENTS_DATA_PATH = path.join(DATA_DIR, 'documents.json');
const BULLETINS_DATA_PATH = path.join(DATA_DIR, 'bulletins.json');
const LIVESTREAM_DATA_PATH = path.join(DATA_DIR, 'livestream.json');
const SETTINGS_DATA_PATH = path.join(DATA_DIR, 'settings.json');
const FINANCES_DATA_PATH = path.join(DATA_DIR, 'finances.json');

function normalizeDateOnly(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return '';
  return new Date(t).toISOString().slice(0, 10);
}

function normalizeMoneyToCents(value) {
  const raw = String(value ?? '').trim().replace(/[$,\s]/g, '');
  const n = Number(raw);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

function normalizeFinanceText(value, maxLen) {
  return String(value || '').trim().slice(0, maxLen);
}

function uniqNonEmptyStrings(list) {
  const out = [];
  const seen = new Set();
  for (const raw of (list || [])) {
    const v = String(raw || '').trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function loadFinances() {
  const stored = readJson(FINANCES_DATA_PATH, { entries: [], meta: { categories: [], funds: [] } });
  const entries = Array.isArray(stored.entries) ? stored.entries : [];
  const metaRaw = stored.meta && typeof stored.meta === 'object' ? stored.meta : {};
  const meta = {
    categories: uniqNonEmptyStrings(metaRaw.categories || []),
    funds: uniqNonEmptyStrings(metaRaw.funds || [])
  };
  return { entries, meta };
}

function saveFinances(data) {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const metaRaw = data?.meta && typeof data.meta === 'object' ? data.meta : {};
  const meta = {
    categories: uniqNonEmptyStrings(metaRaw.categories || []),
    funds: uniqNonEmptyStrings(metaRaw.funds || [])
  };
  writeJsonAtomic(FINANCES_DATA_PATH, { entries, meta });
}

function sortFinanceEntries(entries) {
  (entries || []).sort((a, b) => {
    const ad = String(a?.date || '');
    const bd = String(b?.date || '');
    if (bd !== ad) return bd.localeCompare(ad);
    const at = String(a?.createdAt || '');
    const bt = String(b?.createdAt || '');
    return bt.localeCompare(at);
  });
}

function loadUsers() {
  const data = readJson(USERS_PATH, { users: [] });
  const users = Array.isArray(data.users) ? data.users : [];
  // Decrypt at rest (optional) for sensitive secrets.
  for (const u of users) {
    if (!u || typeof u !== 'object') continue;
    u.role = normalizeRole(u.role);
    if (u.twoFactorSecret) u.twoFactorSecret = maybeDecrypt(u.twoFactorSecret);
    if (u.twoFactorPendingSecret) u.twoFactorPendingSecret = maybeDecrypt(u.twoFactorPendingSecret);
  }
  return { users };
}
function saveUsers(data) {
  const users = Array.isArray(data?.users) ? data.users : [];
  const out = users.map((u) => {
    if (!u || typeof u !== 'object') return u;
    const copy = { ...u };
    if (copy.twoFactorSecret) copy.twoFactorSecret = maybeEncrypt(copy.twoFactorSecret);
    if (copy.twoFactorPendingSecret) copy.twoFactorPendingSecret = maybeEncrypt(copy.twoFactorPendingSecret);
    return copy;
  });
  writeJsonAtomic(USERS_PATH, { users: out });
}

function passwordPolicyError(password) {
  const p = String(password || '');
  if (p.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(p)) return 'Password must include at least 1 capital letter.';
  if (!/[^A-Za-z0-9]/.test(p)) return 'Password must include at least 1 special character.';
  return '';
}

function requireStrongPassword(password) {
  const err = passwordPolicyError(password);
  if (err) {
    const e = new Error(err);
    e.statusCode = 400;
    throw e;
  }
}

async function ensureMasterAdmin() {
  const email = mustGetEnv('ADMIN_EMAIL').toLowerCase();
  const password = mustGetEnv('ADMIN_PASSWORD');

  const policyErr = passwordPolicyError(password);
  if (policyErr) {
    console.warn(`[MMMBC Admin] WARNING: ADMIN_PASSWORD does not meet policy: ${policyErr}`);
  }

  const usersData = loadUsers();
  const users = Array.isArray(usersData.users) ? usersData.users : [];

  let user = users.find((u) => String(u.email).toLowerCase() === email);
  const passwordHash = await bcrypt.hash(password, 12);

  if (!user) {
    user = {
      id: newId(),
      email,
      passwordHash,
      role: ROLE.ADMINISTRATOR,
      createdAt: new Date().toISOString(),
      isMaster: true,
      name: 'Master Admin',
      mustOnboard: false,
      onboardedAt: new Date().toISOString(),
      twoFactorEnabled: false,
      twoFactorSecret: ''
    };
    users.push(user);
  } else {
    // Keep env vars as source of truth for master password.
    user.passwordHash = passwordHash;
    user.role = ROLE.ADMINISTRATOR;
    user.isMaster = true;
    if (!user.name) user.name = 'Master Admin';
    if (typeof user.mustOnboard !== 'boolean') user.mustOnboard = false;
    if (typeof user.twoFactorEnabled !== 'boolean') user.twoFactorEnabled = false;
    if (!user.twoFactorSecret) user.twoFactorSecret = '';
  }

  saveUsers({ users });
}

// ----------------- AUTH -----------------
app.get('/api/me', (req, res) => {
  const sessionUser = req.session?.user;
  if (!sessionUser?.id) return res.json({ user: null });

  const usersData = loadUsers();
  const user = (usersData.users || []).find((u) => u.id === sessionUser.id);
  if (!user) return res.json({ user: null });

  // Keep session in sync with stored user.
  req.session.user = {
    id: user.id,
    email: user.email,
      role: normalizeRole(user.role),
    name: user.name || '',
    isMaster: !!user.isMaster,
    mustOnboard: !!user.mustOnboard,
    twoFactorEnabled: !!user.twoFactorEnabled
  };
  res.json({ user: req.session.user, permissions: permissionsForRole(req.session.user.role) });
});

// ----------------- ADMIN DEBUG (secured) -----------------
app.get('/api/admin/health', requirePermission(PERMISSIONS.USERS_MANAGE), (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    pid: process.pid,
    env: process.env.NODE_ENV || 'development',
    enforceHttps: ENFORCE_HTTPS,
    trustProxy: TRUST_PROXY,
    memory: process.memoryUsage(),
    loadavg: os.loadavg(),
    dataDir: DATA_DIR,
    sessionsDir: SESSIONS_DIR
  });
});

app.get('/api/admin/logs', requirePermission(PERMISSIONS.USERS_MANAGE), (req, res) => {
  const type = String(req.query.type || 'app');
  const maxLines = Math.min(1000, Math.max(50, Number(req.query.lines || 300)));
  const prefix = type === 'audit' ? 'audit' : 'app';

  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.log'))
      .map((f) => ({
        name: f,
        path: path.join(LOG_DIR, f),
        mtimeMs: fs.statSync(path.join(LOG_DIR, f)).mtimeMs
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (!files.length) return res.json({ ok: true, type: prefix, file: null, lines: '' });
    const latest = files[0];
    const lines = tailFile(latest.path, maxLines);
    res.json({ ok: true, type: prefix, file: latest.name, lines });
  } catch (e) {
    logger.error('log_tail_failed', { err: e });
    res.status(500).json({ error: 'Unable to read logs.' });
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  const usersData = loadUsers();
  const user = (usersData.users || []).find((u) => String(u.email).toLowerCase() === email);
  if (!user) {
    audit('auth_login_failed', { at: new Date().toISOString(), email, ip: req.ip, reason: 'no_user' });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (user.mustOnboard) {
    audit('auth_login_failed', { at: new Date().toISOString(), email, ip: req.ip, reason: 'must_onboard' });
    return res.status(403).json({ error: 'Account setup required. Use your invite link to finish setup.' });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    audit('auth_login_failed', { at: new Date().toISOString(), email, ip: req.ip, reason: 'bad_password' });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // 2FA is disabled in this admin build (UI removed).

  // Prevent session fixation by regenerating the session on login.
  req.session.regenerate((err) => {
    if (err) {
      logger.error('session_regenerate_failed', { err, email, ip: req.ip });
      return res.status(500).json({ error: 'Login failed. Try again.' });
    }

    req.session.user = {
      id: user.id,
      email: user.email,
      role: normalizeRole(user.role),
      name: user.name || '',
      isMaster: !!user.isMaster,
      mustOnboard: !!user.mustOnboard,
      twoFactorEnabled: false
    };
    audit('auth_login_success', { at: new Date().toISOString(), email, ip: req.ip, userId: user.id });
    res.json({ ok: true });
  });
});

app.get('/api/auth/providers', (req, res) => {
  const cid = googleClientId();
  res.json({
    google: {
      enabled: Boolean(cid),
      clientId: cid || ''
    }
  });
});

app.post('/api/auth/google', loginLimiter, async (req, res) => {
  if (!isGoogleAuthEnabled()) {
    return res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
  }

  const idToken = String(req.body?.idToken || '').trim();
  if (!idToken) return res.status(400).json({ error: 'Missing Google ID token.' });

  const oauthClient = getGoogleOauthClient();
  if (!oauthClient) {
    return res.status(503).json({ error: 'Google sign-in client is unavailable.' });
  }

  let payload = null;
  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken,
      audience: googleClientId()
    });
    payload = ticket.getPayload() || null;
  } catch (err) {
    audit('auth_login_failed', {
      at: new Date().toISOString(),
      ip: req.ip,
      reason: 'google_token_invalid',
      error: String(err?.message || err || '').slice(0, 200)
    });
    return res.status(401).json({ error: 'Invalid Google sign-in token.' });
  }

  const email = String(payload?.email || '').trim().toLowerCase();
  const emailVerified = Boolean(payload?.email_verified);
  if (!email || !emailVerified) {
    audit('auth_login_failed', {
      at: new Date().toISOString(),
      ip: req.ip,
      reason: 'google_unverified_email',
      email
    });
    return res.status(403).json({ error: 'Google account email is not verified.' });
  }

  const usersData = loadUsers();
  const users = Array.isArray(usersData.users) ? usersData.users : [];
  let user = users.find((u) => String(u.email).toLowerCase() === email);

  if (!user) {
    const approvedEmails = googleApprovedEmailsFromEnv();
    if (!approvedEmails.has(email)) {
      audit('auth_login_failed', {
        at: new Date().toISOString(),
        ip: req.ip,
        email,
        reason: 'google_not_approved'
      });
      return res.status(403).json({ error: 'This Google account is not approved for admin access.' });
    }

    user = {
      id: newId(),
      email,
      passwordHash: await bcrypt.hash(randomToken(), 12),
      role: ROLE.WEBSITE_EDITOR,
      createdAt: new Date().toISOString(),
      isMaster: false,
      name: String(payload?.name || '').trim().slice(0, 120),
      mustOnboard: false,
      onboardedAt: new Date().toISOString(),
      twoFactorEnabled: false,
      twoFactorSecret: ''
    };
    users.push(user);
    saveUsers({ users });
    audit('auth_user_created_google', {
      at: new Date().toISOString(),
      email,
      userId: user.id,
      role: user.role,
      ip: req.ip
    });
  }

  if (user.mustOnboard) {
    audit('auth_login_failed', { at: new Date().toISOString(), email, ip: req.ip, reason: 'must_onboard' });
    return res.status(403).json({ error: 'Account setup required. Use your invite link to finish setup.' });
  }

  req.session.regenerate((err) => {
    if (err) {
      logger.error('session_regenerate_failed', { err, email, ip: req.ip });
      return res.status(500).json({ error: 'Login failed. Try again.' });
    }

    req.session.user = {
      id: user.id,
      email: user.email,
      role: normalizeRole(user.role),
      name: user.name || String(payload?.name || '').trim().slice(0, 120),
      isMaster: !!user.isMaster,
      mustOnboard: !!user.mustOnboard,
      twoFactorEnabled: false
    };
    audit('auth_login_success', {
      at: new Date().toISOString(),
      email,
      ip: req.ip,
      userId: user.id,
      method: 'google'
    });
    return res.json({ ok: true });
  });
});

// Recovery-code based reset (no email sending required)
app.post('/api/auth/recover', async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const recoveryCode = String(req.body.recoveryCode || '').trim();
  const newPassword = String(req.body.newPassword || '');

  const expected = process.env.ADMIN_RECOVERY_CODE;
  if (!expected) return res.status(503).json({ error: 'Recovery is not enabled on this server.' });
  if (!email || !recoveryCode || !newPassword) return res.status(400).json({ error: 'Missing fields.' });
  if (recoveryCode !== String(expected)) return res.status(401).json({ error: 'Invalid recovery code.' });

  try {
    requireStrongPassword(newPassword);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message || 'Invalid password.' });
  }

  const usersData = loadUsers();
  const users = Array.isArray(usersData.users) ? usersData.users : [];
  const user = users.find((u) => String(u.email).toLowerCase() === email);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.isMaster) return res.status(400).json({ error: 'Master admin password is controlled by environment variables.' });

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  saveUsers({ users });
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  const user = sessionUser(req);
  if (user) {
    audit('auth_logout', {
      at: new Date().toISOString(),
      userId: user.id,
      userEmail: user.email,
      ip: req.ip
    });
  }
  req.session.destroy(() => res.json({ ok: true }));
});

// ----------------- SUPPORT -----------------
app.post('/api/support/message', (req, res, next) => {
  // Allow either an authenticated admin session OR a support API token.
  const user = sessionUser(req);
  if (user && hasPermission(user.role, PERMISSIONS.SUPPORT_SEND)) return next();
  if (hasValidSupportApiToken(req)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}, async (req, res) => {
  if (envBool('SUPPORT_DISABLE_SEND', false) || process.env.NODE_ENV === 'test') {
    const subjectRaw = String(req.body?.subject || '').trim();
    const messageRaw = String(req.body?.message || '').trim();
    if (!subjectRaw || !messageRaw) return res.status(400).json({ error: 'Subject and message are required.' });
    logger.info('support_email_disabled', { subject: subjectRaw.slice(0, 140), actor: getSupportActor(req) });
    return res.json({ ok: true, disabled: true });
  }

  // MailChannels is intended to be called from Cloudflare (Workers). When local admin is
  // configured with WORKER_ORIGIN, proxy this request to the Worker so sending works.
  if (String(process.env.WORKER_ORIGIN || '').trim()) {
    return proxyToWorker(req, res);
  }

  const subjectRaw = String(req.body?.subject || '').trim();
  const messageRaw = String(req.body?.message || '').trim();
  const replyToRaw = String(req.body?.replyTo || '').trim();
  if (!subjectRaw || !messageRaw) return res.status(400).json({ error: 'Subject and message are required.' });

  const subject = subjectRaw.slice(0, 140);
  const message = messageRaw.slice(0, 5000);
  const replyTo = replyToRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyToRaw) ? replyToRaw : '';

  const toEmail = String(process.env.SUPPORT_TO_EMAIL || 'support@hldesignedit.com').trim();
  const fromEmail = String(process.env.SUPPORT_FROM_EMAIL || 'no-reply@mmmbc.com').trim();
  const fromName = String(process.env.SUPPORT_FROM_NAME || 'MMMBC Admin Support').trim() || 'MMMBC Admin Support';

  const composedSubject = `[MMMBC Support] ${subject}`;
  const textBody = [
    `From: ${getSupportActor(req)}`,
    replyTo ? `Reply-To: ${replyTo}` : 'Reply-To: (not provided)',
    '',
    message
  ].join('\n');

  try {
    const payload = {
      personalizations: [{ to: [{ email: toEmail }], subject: composedSubject }],
      from: { email: fromEmail, name: fromName },
      ...(replyTo ? { reply_to: { email: replyTo } } : {}),
      content: [{ type: 'text/plain', value: textBody }]
    };
    const out = await mailchannelsSend(payload);
    if (out.status < 200 || out.status >= 300) {
      logger.error('support_email_failed', { status: out.status, body: String(out.body || '').slice(0, 2000) });
      return res.status(502).json({ error: `Email send failed (${out.status}).` });
    }
    res.json({ ok: true });
  } catch (e) {
    logger.error('support_email_error', { err: e });
    res.status(502).json({ error: 'Email send failed.' });
  }
});

// ----------------- USERS (admin) -----------------
app.get('/api/users', requirePermission(PERMISSIONS.USERS_MANAGE), (req, res) => {
  const usersData = loadUsers();
  const safe = (usersData.users || []).map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name || '',
    role: u.role,
    createdAt: u.createdAt,
    isMaster: !!u.isMaster
  }));
  res.json({ users: safe });
});

app.post('/api/users', requirePermission(PERMISSIONS.USERS_MANAGE), async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    requireStrongPassword(password);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message || 'Invalid password.' });
  }

  const usersData = loadUsers();
  const users = usersData.users || [];
  if (users.some((u) => String(u.email).toLowerCase() === email)) {
    return res.status(409).json({ error: 'User already exists' });
  }

  users.push({
    id: newId(),
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role: ROLE.WEBSITE_EDITOR,
    createdAt: new Date().toISOString(),
    isMaster: false,
    name: ''
  });

  saveUsers({ users });
  res.json({ ok: true });
});

// Create an invite link for a new admin (recommended flow)
app.post('/api/users/invite', requirePermission(PERMISSIONS.USERS_MANAGE), async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const usersData = loadUsers();
  const users = Array.isArray(usersData.users) ? usersData.users : [];
  if (users.some((u) => String(u.email).toLowerCase() === email)) {
    return res.status(409).json({ error: 'User already exists' });
  }

  const token = randomToken();
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const placeholderPassword = randomToken();

  users.push({
    id: newId(),
    email,
    passwordHash: await bcrypt.hash(placeholderPassword, 12),
    role: ROLE.WEBSITE_EDITOR,
    createdAt: new Date().toISOString(),
    isMaster: false,
    name: '',
    mustOnboard: true,
    onboardedAt: '',
    inviteTokenHash: tokenHash,
    inviteExpiresAt: expiresAt,
    twoFactorEnabled: false,
    twoFactorSecret: '',
    twoFactorPendingSecret: ''
  });

  saveUsers({ users });

  const base = getBaseUrl(req);
  const inviteLink = `${base}/admin/#invite=${token}`;
  res.json({ ok: true, inviteLink, expiresAt });
});

// Invite details
app.get('/api/invites/:token', async (req, res) => {
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const usersData = loadUsers();
  const users = Array.isArray(usersData.users) ? usersData.users : [];
  const user = findUserByInviteToken(users, token);
  if (!user || !isInviteValid(user)) return res.status(404).json({ error: 'Invite link is invalid or expired.' });

  res.json({
    email: user.email,
    expiresAt: user.inviteExpiresAt
  });
});

// Complete onboarding (name + password)
app.post('/api/invites/:token/complete', async (req, res) => {
  const token = String(req.params.token || '').trim();
  const name = String(req.body?.name || '').trim();
  const newPassword = String(req.body?.newPassword || '');
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const usersData = loadUsers();
  const users = Array.isArray(usersData.users) ? usersData.users : [];
  const user = findUserByInviteToken(users, token);
  if (!user || !isInviteValid(user)) return res.status(404).json({ error: 'Invite link is invalid or expired.' });

  try {
    requireStrongPassword(newPassword);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message || 'Invalid password.' });
  }

  user.name = name;
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.mustOnboard = false;
  user.onboardedAt = new Date().toISOString();
  user.twoFactorEnabled = false;
  user.twoFactorSecret = '';
  user.twoFactorPendingSecret = '';
  user.inviteTokenHash = '';
  user.inviteExpiresAt = '';

  saveUsers({ users });

  // Log them in immediately after successful onboarding
  req.session.user = {
    id: user.id,
    email: user.email,
    role: normalizeRole(user.role),
    name: user.name || '',
    isMaster: !!user.isMaster,
    mustOnboard: !!user.mustOnboard,
    twoFactorEnabled: false
  };

  res.json({ ok: true });
});

// ----------------- ACCOUNT (self service) -----------------
app.put('/api/account', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const nextName = String(req.body?.name || '').trim();
  const nextEmail = String(req.body?.email || '').toLowerCase().trim();
  if (!nextEmail) return res.status(400).json({ error: 'Email is required.' });

  const usersData = loadUsers();
  const users = Array.isArray(usersData.users) ? usersData.users : [];
  const user = users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Not found' });

  if (user.isMaster) {
    return res.status(400).json({ error: 'Master admin email is controlled by environment variables.' });
  }

  if (users.some((u) => u.id !== user.id && String(u.email).toLowerCase() === nextEmail)) {
    return res.status(409).json({ error: 'Email is already in use.' });
  }

  user.name = nextName;
  user.email = nextEmail;
  saveUsers({ users });
  req.session.user = {
    id: user.id,
    email: user.email,
    role: normalizeRole(user.role),
    name: user.name || '',
    isMaster: !!user.isMaster
  };
  res.json({ ok: true });
});

app.put('/api/account/password', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields.' });

  try {
    requireStrongPassword(newPassword);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message || 'Invalid password.' });
  }

  const usersData = loadUsers();
  const users = Array.isArray(usersData.users) ? usersData.users : [];
  const user = users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (user.isMaster) return res.status(400).json({ error: 'Master admin password is controlled by environment variables.' });

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  saveUsers({ users });
  res.json({ ok: true });
});

app.delete('/api/users/:id', requirePermission(PERMISSIONS.USERS_MANAGE), (req, res) => {
  const usersData = loadUsers();
  const users = usersData.users || [];
  const id = String(req.params.id);
  const user = users.find((u) => u.id === id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (user.isMaster) return res.status(400).json({ error: 'Cannot delete master admin' });

  const next = users.filter((u) => u.id !== id);
  saveUsers({ users: next });
  res.json({ ok: true });
});

// ----------------- GALLERY -----------------
function loadGallery() {
  const data = readJson(GALLERY_DATA_PATH, { items: [] });
  if (!data || typeof data !== 'object') return { items: [] };
  if (!Array.isArray(data.items)) data.items = [];
  return data;
}
function saveGallery(data) {
  writeJsonAtomic(GALLERY_DATA_PATH, data);
}

function galleryUrlPrefix() {
  const raw = String(process.env.GALLERY_URL_PREFIX || '').trim();
  if (!raw) return '';
  // Allow absolute URLs (e.g. https://cdn.example.com) or path prefixes (/cdn)
  return raw.replace(/\/$/, '');
}

function withPrefix(prefix, pathWithLeadingSlash) {
  const p = String(pathWithLeadingSlash || '');
  if (!prefix) return p;
  if (/^https?:\/\//i.test(prefix)) return `${prefix}${p}`;
  // Treat as path prefix
  return `${prefix}${p}`;
}

const galleryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 }
});

function proxyToWorker(req, res) {
  const base = String(process.env.WORKER_ORIGIN || '').trim().replace(/\/$/, '');
  if (!base) {
    return res.status(501).json({
      error: 'This endpoint is provided by the Cloudflare Worker. Set WORKER_ORIGIN to your Worker URL (and optionally CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET for Access-protected Workers).'
    });
  }

  // IMPORTANT: req.originalUrl is absolute-path (starts with "/").
  // Using new URL(req.originalUrl, base) would drop any path prefix on base.
  // Concatenation preserves base path prefixes like "https://example.com/admin".
  const target = new URL(`${base}${req.originalUrl}`);
  const method = String(req.method || 'GET').toUpperCase();

  const headers = {
    accept: 'application/json'
  };

  const id = String(process.env.CF_ACCESS_CLIENT_ID || '').trim();
  const secret = String(process.env.CF_ACCESS_CLIENT_SECRET || '').trim();
  if (id && secret) {
    headers['CF-Access-Client-Id'] = id;
    headers['CF-Access-Client-Secret'] = secret;
  }

  let body = null;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(req.body ?? {});
    headers['content-length'] = Buffer.byteLength(body);
  }

  const client = target.protocol === 'http:' ? http : https;
  const proxyReq = client.request(
    {
      method,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: `${target.pathname}${target.search}`,
      headers
    },
    (proxyRes) => {
      res.status(proxyRes.statusCode || 502);
      const ct = proxyRes.headers['content-type'];
      if (ct) res.setHeader('content-type', ct);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', (e) => {
    logger.error('worker_proxy_failed', { err: e, url: target.toString() });
    res.status(502).json({ error: 'Proxy to Worker failed.' });
  });
  if (body) proxyReq.write(body);
  proxyReq.end();
}

function proxyToWorkerStream(req, res, { forceAccept } = {}) {
  const base = String(process.env.WORKER_ORIGIN || '').trim().replace(/\/$/, '');
  if (!base) {
    res.status(501);
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('This endpoint is provided by the Cloudflare Worker. Set WORKER_ORIGIN to your Worker URL.');
    return;
  }

  const target = new URL(`${base}${req.originalUrl}`);
  const method = String(req.method || 'GET').toUpperCase();

  const headers = {};
  const accept = String(forceAccept || req.headers.accept || '').trim();
  if (accept) headers.accept = accept;

  const passReqHeaders = ['content-type', 'content-length', 'range', 'if-none-match', 'if-modified-since'];
  for (const h of passReqHeaders) {
    const v = req.headers[h];
    if (v) headers[h] = v;
  }

  const id = String(process.env.CF_ACCESS_CLIENT_ID || '').trim();
  const secret = String(process.env.CF_ACCESS_CLIENT_SECRET || '').trim();
  if (id && secret) {
    headers['CF-Access-Client-Id'] = id;
    headers['CF-Access-Client-Secret'] = secret;
  }

  const client = target.protocol === 'http:' ? http : https;
  const proxyReq = client.request(
    {
      method,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: `${target.pathname}${target.search}`,
      headers
    },
    (proxyRes) => {
      res.status(proxyRes.statusCode || 502);

      const passResHeaders = [
        'content-type',
        'content-length',
        'cache-control',
        'etag',
        'last-modified',
        'accept-ranges',
        'content-range',
        'content-disposition',
        'cross-origin-resource-policy',
        'access-control-allow-origin'
      ];
      for (const h of passResHeaders) {
        const v = proxyRes.headers[h];
        if (v) res.setHeader(h, v);
      }

      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (e) => {
    logger.error('worker_proxy_failed', { err: e, url: target.toString() });
    res.status(502);
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Proxy to Worker failed.');
  });

  if (method === 'GET' || method === 'HEAD') {
    proxyReq.end();
    return;
  }

  req.pipe(proxyReq);
}

// Worker-backed R2 gallery APIs (for bucket browsing/sync)
app.get('/api/gallery/r2tree', requirePermission(PERMISSIONS.WEBSITE_WRITE), (req, res) => proxyToWorker(req, res));
app.delete('/api/gallery/r2object', requirePermission(PERMISSIONS.WEBSITE_WRITE), (req, res) => proxyToWorker(req, res));
app.post('/api/gallery/sync', requirePermission(PERMISSIONS.WEBSITE_WRITE), (req, res) => proxyToWorker(req, res));

// Worker-backed CDN gallery objects (for previewing /cdn/gallery/* when running locally)
app.use('/cdn/gallery', (req, res) => proxyToWorkerStream(req, res));

app.get('/api/gallery', requirePermission(PERMISSIONS.WEBSITE_WRITE), (req, res) => {
  if (String(process.env.WORKER_ORIGIN || '').trim()) return proxyToWorker(req, res);
  return res.json(loadGallery());
});

app.post(
  '/api/gallery/upload',
  requirePermission(PERMISSIONS.WEBSITE_WRITE),
  (req, res, next) => {
    if (String(process.env.WORKER_ORIGIN || '').trim()) return proxyToWorkerStream(req, res, { forceAccept: 'application/json' });
    return next();
  },
  galleryUpload.array('images', 20),
  async (req, res) => {
  const album = sanitizeSegment(req.body.album || 'General') || 'General';
  const label = sanitizeSegment(req.body.label || '') || '';
  const tagsRaw = String(req.body.tags || '');
  const tags = tagsRaw
    .split(',')
    .map((t) => sanitizeSegment(t).toLowerCase())
    .filter(Boolean)
    .slice(0, 25);

  ensureDir(path.join(GALLERY_DIR, album));
  ensureDir(path.join(GALLERY_DIR, album, '_thumbs'));

  const gallery = loadGallery();
  const items = Array.isArray(gallery.items) ? gallery.items : [];

  const files = req.files || [];
  const added = [];

  for (const file of files) {
    const mimeType = file.mimetype;
    if (!isAllowedImage(mimeType)) continue;

    const ext = mime.extension(mimeType) || 'jpg';
    const id = newId();
    const safeBase = sanitizeSegment(path.parse(file.originalname).name).replace(/\s+/g, '-') || 'image';
    const fileName = `${new Date().toISOString().slice(0, 10)}_${safeBase}_${id}.${ext}`;
    const relPath = path.posix.join('ConImg', 'gallery', album, fileName);
    const absPath = path.join(GALLERY_DIR, album, fileName);

    fs.writeFileSync(absPath, file.buffer);

    // Thumbnail
    const thumbName = fileName.replace(/\.[^.]+$/, '.jpg');
    const relThumb = path.posix.join('ConImg', 'gallery', album, '_thumbs', thumbName);
    const absThumb = path.join(GALLERY_DIR, album, '_thumbs', thumbName);

    try {
      await sharp(file.buffer)
        .rotate()
        .resize(420, 420, { fit: 'cover' })
        .jpeg({ quality: 80 })
        .toFile(absThumb);
    } catch {
      // If sharp fails, skip thumbnail.
    }

    const createdAt = new Date().toISOString();

    const prefix = galleryUrlPrefix();

    const item = {
      id,
      album,
      label,
      tags,
      file: withPrefix(prefix, `/${relPath.replace(/\\/g, '/')}`),
      thumb: fs.existsSync(absThumb)
        ? withPrefix(prefix, `/${relThumb.replace(/\\/g, '/')}`)
        : withPrefix(prefix, `/${relPath.replace(/\\/g, '/')}`),
      originalName: file.originalname,
      createdAt,
      position: null
    };

    items.unshift(item);
    added.push(item);
  }

  const nextGallery = { ...gallery, items };
  saveGallery(nextGallery);

  if (ENABLE_EXPORTS) {
    writeJsonAtomic(path.join(ROOT_DIR, 'gallery.json'), nextGallery);
  }

  res.json({ ok: true, added });
  }
);

app.put('/api/gallery/order', requirePermission(PERMISSIONS.WEBSITE_WRITE), (req, res) => {
  if (String(process.env.WORKER_ORIGIN || '').trim()) return proxyToWorker(req, res);
  const album = sanitizeSegment(req.body?.album || '');
  const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds.map((x) => String(x)) : [];
  if (!album) return res.status(400).json({ error: 'Album is required.' });
  if (!orderedIds.length) return res.status(400).json({ error: 'orderedIds is required.' });

  const gallery = loadGallery();
  const items = Array.isArray(gallery.items) ? gallery.items : [];
  const byId = new Map(items.map((it) => [String(it.id), it]));

  // Validate: all ids exist and belong to album
  for (const id of orderedIds) {
    const it = byId.get(id);
    if (!it) return res.status(400).json({ error: 'One or more ids do not exist.' });
    if (String(it.album) !== album) return res.status(400).json({ error: 'All ids must belong to the selected album.' });
  }

  // Apply positions in the provided order.
  orderedIds.forEach((id, idx) => {
    const it = byId.get(id);
    if (it) it.position = idx;
  });

  // Any remaining items in the album not included get appended (stable-ish by createdAt desc).
  const remaining = items
    .filter((it) => String(it.album) === album && !orderedIds.includes(String(it.id)))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  let nextPos = orderedIds.length;
  for (const it of remaining) {
    it.position = nextPos;
    nextPos += 1;
  }

  saveGallery({ ...gallery, items });
  if (ENABLE_EXPORTS) writeJsonAtomic(path.join(ROOT_DIR, 'gallery.json'), { ...gallery, items });
  res.json({ ok: true });
});

app.put('/api/gallery/:id', requirePermission(PERMISSIONS.WEBSITE_WRITE), (req, res) => {
  if (String(process.env.WORKER_ORIGIN || '').trim()) return proxyToWorker(req, res);
  const id = String(req.params.id);
  const gallery = loadGallery();
  const items = Array.isArray(gallery.items) ? gallery.items : [];
  const item = items.find((x) => x.id === id);
  if (!item) return res.status(404).json({ error: 'Not found' });

  if (req.body.album) item.album = sanitizeSegment(req.body.album) || item.album;
  if (typeof req.body.label === 'string') item.label = sanitizeSegment(req.body.label);
  if (typeof req.body.tags === 'string') {
    item.tags = String(req.body.tags)
      .split(',')
      .map((t) => sanitizeSegment(t).toLowerCase())
      .filter(Boolean)
      .slice(0, 25);
  }

  const nextGallery = { ...gallery, items };
  saveGallery(nextGallery);
  if (ENABLE_EXPORTS) writeJsonAtomic(path.join(ROOT_DIR, 'gallery.json'), nextGallery);

  res.json({ ok: true, item });
});

app.delete('/api/gallery/:id', requirePermission(PERMISSIONS.WEBSITE_WRITE), (req, res) => {
  if (String(process.env.WORKER_ORIGIN || '').trim()) return proxyToWorker(req, res);
  const id = String(req.params.id);
  const gallery = loadGallery();
  const items = Array.isArray(gallery.items) ? gallery.items : [];
  const idx = items.findIndex((x) => x.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const [removed] = items.splice(idx, 1);

  // Best-effort delete image + thumbnail
  try {
    if (removed?.file) {
      const abs = path.join(ROOT_DIR, removed.file.replace(/^\//, ''));
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    }
    if (removed?.thumb && removed.thumb.includes('/_thumbs/')) {
      const absT = path.join(ROOT_DIR, removed.thumb.replace(/^\//, ''));
      if (fs.existsSync(absT)) fs.unlinkSync(absT);
    }
  } catch {
    // ignore
  }

  const nextGallery = { ...gallery, items };
  saveGallery(nextGallery);
  if (ENABLE_EXPORTS) writeJsonAtomic(path.join(ROOT_DIR, 'gallery.json'), nextGallery);

  res.json({ ok: true });
});

// ----------------- ANNOUNCEMENTS -----------------
function loadAnnouncementsFile() {
  const data = readJson(ANNOUNCEMENTS_DATA_PATH, { posts: [] });
  return pruneAndPersistAnnouncements(data);
}
function saveAnnouncementsFile(data) {
  writeJsonAtomic(ANNOUNCEMENTS_DATA_PATH, data);
}

function parseExpiresAtFromBody(body) {
  const now = Date.now();

  // Explicit never-expire
  if (body?.expiresInDays === null) return null;

  // Explicit ISO timestamp wins
  if (typeof body?.expiresAt === 'string' && body.expiresAt.trim()) {
    const t = Date.parse(body.expiresAt);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }

  // Days-based lifecycle
  if (body?.expiresInDays !== undefined && body?.expiresInDays !== null && String(body.expiresInDays).trim() !== '') {
    const n = Number(body.expiresInDays);
    if (Number.isFinite(n) && n > 0) return new Date(now + n * 24 * 60 * 60 * 1000).toISOString();
    return null; // 0/invalid => never
  }

  // Default lifecycle to reduce clutter
  return new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
}

function isAnnouncementExpired(post) {
  if (!post?.expiresAt) return false;
  const t = Date.parse(post.expiresAt);
  if (Number.isNaN(t)) return false;
  return t <= Date.now();
}

function pruneAndPersistAnnouncements(data) {
  const posts = Array.isArray(data?.posts) ? data.posts : [];
  const next = posts.filter((p) => p && (p.title || p.body) && !isAnnouncementExpired(p));
  if (next.length !== posts.length) {
    const cleaned = { posts: next };
    saveAnnouncementsFile(cleaned);
    if (ENABLE_EXPORTS) writeJsonAtomic(path.join(ROOT_DIR, 'announcements.json'), cleaned);
    return cleaned;
  }
  return { posts };
}

async function pruneExpiredAnnouncementsPg() {
  if (!hasPostgres()) return;
  await pgQuery('DELETE FROM announcements WHERE expires_at IS NOT NULL AND expires_at <= NOW()');
}

function mapAnnouncementRow(row) {
  return {
    id: String(row.id),
    title: String(row.title || ''),
    body: String(row.body || ''),
    createdAt: toIsoOrEmpty(row.created_at) || new Date().toISOString(),
    startsAt: toIsoOrEmpty(row.starts_at) || undefined,
    expiresAt: toIsoOrEmpty(row.expires_at) || undefined,
    source: row.source ? String(row.source) : undefined
  };
}

async function loadAnnouncementsPg() {
  await pruneExpiredAnnouncementsPg();
  const r = await pgQuery(
    'SELECT id, title, body, created_at, starts_at, expires_at, source FROM announcements ORDER BY created_at DESC'
  );
  const posts = (r.rows || []).map(mapAnnouncementRow);
  return { posts };
}

async function loadAnnouncementsUnified() {
  if (hasPostgres()) return loadAnnouncementsPg();
  return loadAnnouncementsFile();
}

async function createAnnouncementUnified({ title, body, startsAt, expiresAt, source } = {}) {
  const post = {
    id: newId(),
    title,
    body,
    createdAt: new Date().toISOString(),
    startsAt: startsAt || undefined,
    expiresAt: expiresAt || undefined,
    source: source || undefined
  };

  if (hasPostgres()) {
    await pgQuery(
      'INSERT INTO announcements (id, title, body, created_at, starts_at, expires_at, source) VALUES ($1,$2,$3,NOW(),$4,$5,$6)',
      [
        post.id,
        post.title,
        post.body,
        post.startsAt || null,
        post.expiresAt || null,
        post.source || null
      ]
    );
    return post;
  }

  const data = loadAnnouncementsFile();
  const posts = Array.isArray(data.posts) ? data.posts : [];
  posts.unshift(post);
  pruneAndPersistAnnouncements({ posts });
  return post;
}

async function deleteAnnouncementUnified(id) {
  if (hasPostgres()) {
    await pgQuery('DELETE FROM announcements WHERE id = $1', [String(id)]);
    return;
  }
  const data = loadAnnouncementsFile();
  const posts = Array.isArray(data.posts) ? data.posts : [];
  const next = posts.filter((p) => p.id !== String(id));
  saveAnnouncementsFile({ posts: next });
}

async function exportAnnouncementsUnifiedToRoot() {
  if (!ENABLE_EXPORTS) return;
  const data = await loadAnnouncementsUnified();
  writeJsonAtomic(path.join(ROOT_DIR, 'announcements.json'), data);
}

app.get('/api/announcements', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), async (req, res) => {
  try {
    res.json(await loadAnnouncementsUnified());
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load announcements' });
  }
});

app.post('/api/announcements', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), async (req, res) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, 120);
    const body = String(req.body.body || '').trim().slice(0, 5000);
    if (!title || !body) return res.status(400).json({ error: 'Title and body required' });

    const startsAt = typeof req.body.startsAt === 'string' ? parseIsoMaybe(req.body.startsAt) : '';
    const expiresAt = parseExpiresAtFromBody(req.body);

    const post = await createAnnouncementUnified({
      title,
      body,
      startsAt: startsAt || undefined,
      expiresAt: expiresAt || undefined,
      source: 'admin'
    });

    await exportAnnouncementsUnifiedToRoot();
    res.json({ ok: true, post });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to create announcement' });
  }
});

app.delete('/api/announcements/:id', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), async (req, res) => {
  try {
    const id = String(req.params.id);
    await deleteAnnouncementUnified(id);
    await exportAnnouncementsUnifiedToRoot();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete announcement' });
  }
});

// ----------------- EVENTS (exports to schedule.json) -----------------
function stableEventId(title, date, time) {
  const key = `${String(title || '').trim().toLowerCase()}|${String(date || '').trim()}|${String(time || '').trim()}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function normalizeTimeValue(value) {
  const t = String(value || '').trim();
  if (!t) return '';
  const m = t.match(/^([0-2]\d):([0-5]\d)/);
  return m ? `${m[1]}:${m[2]}` : '';
}

function normalizeAndSortScheduleLike(events) {
  return (events || [])
    .filter((ev) => ev && ev.title && ev.date)
    .map((ev) => ({
      title: String(ev.title).trim().slice(0, 120),
      date: String(ev.date).trim(),
      time: normalizeTimeValue(ev.time)
    }))
    .sort((a, b) => new Date(`${a.date}T${a.time || '00:00'}`) - new Date(`${b.date}T${b.time || '00:00'}`));
}

function isPastEvent(ev, now) {
  const date = String(ev?.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;

  // If time is blank, keep the event visible until the end of that day.
  const time = normalizeTimeValue(ev?.time) || '23:59';
  const t = Date.parse(`${date}T${time}:00`);
  if (Number.isNaN(t)) return false;
  return t < now.getTime();
}

function prunePastEvents(events) {
  const now = new Date();
  const kept = [];
  let removed = 0;
  for (const ev of (events || [])) {
    if (isPastEvent(ev, now)) {
      removed += 1;
      continue;
    }
    kept.push(ev);
  }
  return { kept, removed };
}

function loadEvents() {
  const stored = readJson(EVENTS_DATA_PATH, { events: [] });
  const storedEvents = Array.isArray(stored.events) ? stored.events : [];

  // If schedule.json exists, treat it as the source of truth for what the website scheduler shows.
  const schedulePath = path.join(ROOT_DIR, 'schedule.json');
  if (!ENABLE_EXPORTS || !fs.existsSync(schedulePath)) {
    return { events: storedEvents };
  }

  const scheduleArray = readJson(schedulePath, null);
  if (!Array.isArray(scheduleArray)) {
    return { events: storedEvents };
  }

  const normalized = normalizeAndSortScheduleLike(scheduleArray);
  const keyOf = (e) => `${String(e.title || '').trim().toLowerCase()}|${String(e.date || '').trim()}|${String(e.time || '').trim()}`;
  const existingByKey = new Map(storedEvents.map((e) => [keyOf(e), e]));

  const merged = normalized.map((ev) => {
    const existing = existingByKey.get(keyOf(ev));
    const id = existing?.id || stableEventId(ev.title, ev.date, ev.time);
    return {
      id,
      title: ev.title,
      date: ev.date,
      time: ev.time,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: existing?.updatedAt
    };
  });

  const storedComparable = JSON.stringify(storedEvents.map((e) => ({ id: e.id, title: e.title, date: e.date, time: e.time })));
  const mergedComparable = JSON.stringify(merged.map((e) => ({ id: e.id, title: e.title, date: e.date, time: e.time })));

  if (storedComparable !== mergedComparable) {
    saveEvents({ events: merged });
  }

  const { kept, removed } = prunePastEvents(merged);
  if (removed) {
    saveEvents({ events: kept });
    // Keep the public scheduler in sync when it exists (or when exports are enabled).
    if (ENABLE_EXPORTS || fs.existsSync(schedulePath)) exportScheduleJson(kept);
    return { events: kept };
  }

  return { events: merged };
}
function saveEvents(data) {
  writeJsonAtomic(EVENTS_DATA_PATH, data);
}

function exportScheduleJson(events) {
  // Existing site expects: [{title,date,time}]
  const schedule = (events || []).map((e) => ({
    title: e.title,
    date: e.date,
    time: e.time || ''
  }));
  const schedulePath = path.join(ROOT_DIR, 'schedule.json');
  const backupPath = path.join(ROOT_DIR, 'schedule.json.bak');
  try {
    if (fs.existsSync(schedulePath) && !fs.existsSync(backupPath)) {
      fs.copyFileSync(schedulePath, backupPath);
    }
  } catch {
    // ignore backup failures
  }
  writeJsonAtomic(schedulePath, schedule);
}

app.get('/api/events', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), (req, res) => {
  res.json(loadEvents());
});

app.post('/api/events', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const date = String(req.body.date || '').trim();
  const time = normalizeTimeValue(req.body.time);
  if (!title || !date) return res.status(400).json({ error: 'Title and date required' });

  const data = loadEvents();
  const events = Array.isArray(data.events) ? data.events : [];
  const ev = { id: newId(), title, date, time, createdAt: new Date().toISOString() };
  events.push(ev);
  events.sort((a, b) => new Date(`${a.date}T${a.time || '00:00'}`) - new Date(`${b.date}T${b.time || '00:00'}`));

  const pruned = prunePastEvents(events);
  saveEvents({ events: pruned.kept });
  if (ENABLE_EXPORTS) exportScheduleJson(pruned.kept);

  res.json({ ok: true, event: ev, events: pruned.kept });
});

app.put('/api/events/:id', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), (req, res) => {
  const id = String(req.params.id);
  const title = String(req.body.title || '').trim().slice(0, 120);
  const date = String(req.body.date || '').trim();
  const time = normalizeTimeValue(req.body.time);
  if (!title || !date) return res.status(400).json({ error: 'Title and date required' });

  const data = loadEvents();
  const events = Array.isArray(data.events) ? data.events : [];
  const ev = events.find((e) => e.id === id);
  if (!ev) return res.status(404).json({ error: 'Not found' });

  ev.title = title;
  ev.date = date;
  ev.time = time;
  ev.updatedAt = new Date().toISOString();

  events.sort((a, b) => new Date(`${a.date}T${a.time || '00:00'}`) - new Date(`${b.date}T${b.time || '00:00'}`));

  const pruned = prunePastEvents(events);
  saveEvents({ events: pruned.kept });
  if (ENABLE_EXPORTS) exportScheduleJson(pruned.kept);

  res.json({ ok: true, event: ev, events: pruned.kept });
});

app.delete('/api/events/:id', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), (req, res) => {
  const id = String(req.params.id);
  const data = loadEvents();
  const events = Array.isArray(data.events) ? data.events : [];
  const next = events.filter((e) => e.id !== id);
  const pruned = prunePastEvents(next);
  saveEvents({ events: pruned.kept });
  if (ENABLE_EXPORTS) exportScheduleJson(pruned.kept);
  res.json({ ok: true });
});

// ----------------- FINANCES (internal only) -----------------
app.get('/api/finances', requirePermission(PERMISSIONS.FINANCE_READ), (req, res) => {
  res.json(loadFinances());
});

app.put('/api/finances/meta', requirePermission(PERMISSIONS.FINANCE_META), (req, res) => {
  const categories = uniqNonEmptyStrings(req.body?.categories || []);
  const funds = uniqNonEmptyStrings(req.body?.funds || []);
  const data = loadFinances();
  const next = {
    entries: Array.isArray(data.entries) ? data.entries : [],
    meta: { categories, funds }
  };
  saveFinances(next);
  res.json({ ok: true, data: next });
});

app.post('/api/finances/entries', requirePermission(PERMISSIONS.FINANCE_WRITE), (req, res) => {
  const date = normalizeDateOnly(req.body?.date);
  const type = String(req.body?.type || '').trim().toLowerCase();
  const category = normalizeFinanceText(req.body?.category, 80);
  const fund = normalizeFinanceText(req.body?.fund, 80);
  const method = normalizeFinanceText(req.body?.method, 24).toLowerCase();
  const party = normalizeFinanceText(req.body?.party, 120);
  const memo = normalizeFinanceText(req.body?.memo, 200);
  const amountCents = normalizeMoneyToCents(req.body?.amount);

  if (!date) return res.status(400).json({ error: 'Valid date required.' });
  if (type !== 'income' && type !== 'expense') return res.status(400).json({ error: 'Type must be income or expense.' });
  if (!category) return res.status(400).json({ error: 'Category required.' });
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'Amount must be greater than 0.' });

  const data = loadFinances();
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const meta = data.meta && typeof data.meta === 'object' ? data.meta : { categories: [], funds: [] };

  const entry = {
    id: newId(),
    date,
    type,
    category,
    fund,
    method,
    party,
    memo,
    amountCents,
    createdAt: new Date().toISOString()
  };

  entries.push(entry);
  sortFinanceEntries(entries);

  const nextMeta = {
    categories: uniqNonEmptyStrings([...(meta.categories || []), category]),
    funds: uniqNonEmptyStrings([...(meta.funds || []), fund])
  };
  const next = { entries, meta: nextMeta };
  saveFinances(next);
  res.json({ ok: true, entry, data: next });
});

app.put('/api/finances/entries/:id', requirePermission(PERMISSIONS.FINANCE_WRITE), (req, res) => {
  const id = String(req.params.id);
  const date = normalizeDateOnly(req.body?.date);
  const type = String(req.body?.type || '').trim().toLowerCase();
  const category = normalizeFinanceText(req.body?.category, 80);
  const fund = normalizeFinanceText(req.body?.fund, 80);
  const method = normalizeFinanceText(req.body?.method, 24).toLowerCase();
  const party = normalizeFinanceText(req.body?.party, 120);
  const memo = normalizeFinanceText(req.body?.memo, 200);
  const amountCents = normalizeMoneyToCents(req.body?.amount);

  if (!date) return res.status(400).json({ error: 'Valid date required.' });
  if (type !== 'income' && type !== 'expense') return res.status(400).json({ error: 'Type must be income or expense.' });
  if (!category) return res.status(400).json({ error: 'Category required.' });
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'Amount must be greater than 0.' });

  const data = loadFinances();
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const entry = entries.find((e) => e.id === id);
  if (!entry) return res.status(404).json({ error: 'Not found' });

  entry.date = date;
  entry.type = type;
  entry.category = category;
  entry.fund = fund;
  entry.method = method;
  entry.party = party;
  entry.memo = memo;
  entry.amountCents = amountCents;
  entry.updatedAt = new Date().toISOString();

  sortFinanceEntries(entries);
  const meta = data.meta && typeof data.meta === 'object' ? data.meta : { categories: [], funds: [] };
  const nextMeta = {
    categories: uniqNonEmptyStrings([...(meta.categories || []), category]),
    funds: uniqNonEmptyStrings([...(meta.funds || []), fund])
  };
  const next = { entries, meta: nextMeta };
  saveFinances(next);
  res.json({ ok: true, entry, data: next });
});

app.delete('/api/finances/entries/:id', requirePermission(PERMISSIONS.FINANCE_WRITE), (req, res) => {
  const id = String(req.params.id);
  const data = loadFinances();
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const nextEntries = entries.filter((e) => e.id !== id);
  const next = { entries: nextEntries, meta: data.meta || { categories: [], funds: [] } };
  saveFinances(next);
  res.json({ ok: true, data: next });
});

// ----------------- DOCUMENTS -----------------
function loadDocuments() {
  return readJson(DOCUMENTS_DATA_PATH, { documents: [] });
}
function saveDocuments(data) {
  writeJsonAtomic(DOCUMENTS_DATA_PATH, data);
}

// ----------------- BULLETINS -----------------
function loadBulletinsFile() {
  return readJson(BULLETINS_DATA_PATH, { bulletins: [] });
}
function saveBulletinsFile(data) {
  writeJsonAtomic(BULLETINS_DATA_PATH, data);
}

function mapBulletinRow(row) {
  return {
    id: String(row.id),
    title: String(row.title || 'Bulletin'),
    originalName: row.original_name ? String(row.original_name) : '',
    fileName: String(row.file_name || ''),
    mimeType: row.mime_type ? String(row.mime_type) : '',
    url: String(row.url || ''),
    startsAt: toIsoOrEmpty(row.starts_at) || '',
    endsAt: toIsoOrEmpty(row.ends_at) || '',
    linkedAnnouncementId: row.linked_announcement_id ? String(row.linked_announcement_id) : '',
    createdAt: toIsoOrEmpty(row.created_at) || new Date().toISOString()
  };
}

async function loadBulletinsPg() {
  const r = await pgQuery(
    'SELECT id, title, original_name, file_name, mime_type, url, starts_at, ends_at, linked_announcement_id, created_at FROM bulletins ORDER BY created_at DESC'
  );
  const bulletins = (r.rows || []).map(mapBulletinRow);
  return { bulletins };
}

async function loadBulletinsUnified() {
  if (hasPostgres()) return loadBulletinsPg();
  return loadBulletinsFile();
}

async function createBulletinUnified(bulletin) {
  if (hasPostgres()) {
    await pgQuery(
      'INSERT INTO bulletins (id, title, original_name, file_name, mime_type, url, starts_at, ends_at, linked_announcement_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())',
      [
        bulletin.id,
        bulletin.title,
        bulletin.originalName || null,
        bulletin.fileName,
        bulletin.mimeType || null,
        bulletin.url,
        bulletin.startsAt,
        bulletin.endsAt,
        bulletin.linkedAnnouncementId || null
      ]
    );
    return;
  }

  const data = loadBulletinsFile();
  const bulletins = Array.isArray(data.bulletins) ? data.bulletins : [];
  bulletins.unshift(bulletin);
  saveBulletinsFile({ bulletins });
}

async function getBulletinByIdUnified(id) {
  const key = String(id);
  if (hasPostgres()) {
    const r = await pgQuery(
      'SELECT id, title, original_name, file_name, mime_type, url, starts_at, ends_at, linked_announcement_id, created_at FROM bulletins WHERE id = $1',
      [key]
    );
    const row = r.rows?.[0];
    return row ? mapBulletinRow(row) : null;
  }
  const data = loadBulletinsFile();
  const bulletins = Array.isArray(data.bulletins) ? data.bulletins : [];
  return bulletins.find((b) => String(b.id) === key) || null;
}

async function deleteBulletinByIdUnified(id) {
  const key = String(id);
  if (hasPostgres()) {
    await pgQuery('DELETE FROM bulletins WHERE id = $1', [key]);
    return;
  }
  const data = loadBulletinsFile();
  const bulletins = Array.isArray(data.bulletins) ? data.bulletins : [];
  const next = bulletins.filter((b) => String(b.id) !== key);
  saveBulletinsFile({ bulletins: next });
}

function parseIsoMaybe(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  const t = Date.parse(v);
  if (Number.isNaN(t)) return '';
  return new Date(t).toISOString();
}

function ensureRootBulletinsDir() {
  ensureDir(ROOT_BULLETINS_DIR);
}

function exportBulletins(bulletins) {
  if (!ENABLE_EXPORTS) return;
  ensureRootBulletinsDir();
  writeJsonAtomic(path.join(ROOT_DIR, 'bulletins.json'), { bulletins });
}

async function exportBulletinsUnifiedToRoot() {
  if (!ENABLE_EXPORTS) return;
  const data = await loadBulletinsUnified();
  exportBulletins(Array.isArray(data?.bulletins) ? data.bulletins : []);
}

function copyBulletinToRoot(fileName) {
  if (!ENABLE_EXPORTS) return;
  ensureRootBulletinsDir();
  const src = path.join(BULLETINS_UPLOADS_DIR, fileName);
  const dst = path.join(ROOT_BULLETINS_DIR, fileName);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  }
}

function deleteBulletinFromRoot(fileName) {
  try {
    const dst = path.join(ROOT_BULLETINS_DIR, fileName);
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
  } catch {
    // ignore
  }
}

const bulletinsUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      ensureDir(BULLETINS_UPLOADS_DIR);
      cb(null, BULLETINS_UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
      const safeBase = sanitizeSegment(path.parse(file.originalname).name).replace(/\s+/g, '-') || 'bulletin';
      const ext = path.extname(file.originalname).toLowerCase() || '.bin';
      cb(null, `${new Date().toISOString().slice(0, 10)}_${safeBase}_${newId()}${ext}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.get('/api/bulletins', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), async (req, res) => {
  try {
    res.json(await loadBulletinsUnified());
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load bulletins' });
  }
});

app.post('/api/bulletins/upload', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), bulletinsUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const title = String(req.body.title || 'Bulletin').trim().slice(0, 120) || 'Bulletin';
  const startsAt = parseIsoMaybe(req.body.startsAt);
  const endsAt = parseIsoMaybe(req.body.endsAt);
  if (!startsAt || !endsAt) return res.status(400).json({ error: 'Show from and show until are required' });
  if (Date.parse(endsAt) <= Date.parse(startsAt)) return res.status(400).json({ error: 'Show until must be after show from' });

  const createAnnouncement = String(req.body.createAnnouncement || 'false').toLowerCase() === 'true';

  let linkedAnnouncementId = '';
  const finalize = async (bulletin) => {
    await createBulletinUnified(bulletin);
    await exportBulletinsUnifiedToRoot();
    await exportAnnouncementsUnifiedToRoot();
    res.json({ ok: true, bulletin });
  };

  const handle = async () => {
    if (createAnnouncement) {
      const aTitle = String(req.body.announcementTitle || '').trim().slice(0, 120) || `Bulletin: ${title}`;
      const aBody = String(req.body.announcementBody || '').trim().slice(0, 5000)
        || 'A new bulletin has been posted. Click the bulletin frame on the homepage to view it.';

      const post = await createAnnouncementUnified({
        title: aTitle,
        body: aBody,
        startsAt: startsAt || undefined,
        expiresAt: endsAt || undefined,
        source: 'bulletin'
      });
      linkedAnnouncementId = post.id;
    }

    // Copy file into the public /bulletins/ folder (for static hosting) and point exported URLs there.
    if (ENABLE_EXPORTS) copyBulletinToRoot(req.file.filename);

    const url = ENABLE_EXPORTS ? `/bulletins/${req.file.filename}` : `/admin-uploads/bulletins/${req.file.filename}`;
    const bulletin = {
      id: newId(),
      title,
      originalName: req.file.originalname,
      fileName: req.file.filename,
      mimeType: req.file.mimetype,
      url,
      startsAt,
      endsAt,
      linkedAnnouncementId,
      createdAt: new Date().toISOString()
    };

    await finalize(bulletin);
  };

  handle().catch((err) => {
    res.status(500).json({ error: err.message || 'Failed to upload bulletin' });
  });

  return;

});

app.delete('/api/bulletins/:id', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), async (req, res) => {
  try {
    const id = String(req.params.id);
    const bulletin = await getBulletinByIdUnified(id);
    await deleteBulletinByIdUnified(id);
    await exportBulletinsUnifiedToRoot();

    // Remove uploaded file(s)
    try {
      if (bulletin?.fileName) {
        const abs = path.join(BULLETINS_UPLOADS_DIR, bulletin.fileName);
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
        if (ENABLE_EXPORTS) deleteBulletinFromRoot(bulletin.fileName);
      }
    } catch {
      // ignore
    }

    // If this bulletin created a coordinated announcement, remove it too.
    try {
      if (bulletin?.linkedAnnouncementId) {
        await deleteAnnouncementUnified(bulletin.linkedAnnouncementId);
        await exportAnnouncementsUnifiedToRoot();
      }
    } catch {
      // ignore
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete bulletin' });
  }
});

const docsUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      ensureDir(DOCS_UPLOADS_DIR);
      cb(null, DOCS_UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
      const safeBase = sanitizeSegment(path.parse(file.originalname).name).replace(/\s+/g, '-') || 'document';
      const ext = path.extname(file.originalname).toLowerCase() || '.bin';
      cb(null, `${new Date().toISOString().slice(0, 10)}_${safeBase}_${newId()}${ext}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.get('/api/documents', requireAnyPermission([PERMISSIONS.COMMUNICATIONS_MANAGE, PERMISSIONS.FINANCE_READ]), (req, res) => {
  res.json(loadDocuments());
});

app.post('/api/documents/upload', requireAnyPermission([PERMISSIONS.COMMUNICATIONS_MANAGE, PERMISSIONS.FINANCE_WRITE]), docsUpload.single('file'), (req, res) => {
  const kind = String(req.body.kind || 'document').trim().slice(0, 30);
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const data = loadDocuments();
  const documents = Array.isArray(data.documents) ? data.documents : [];

  const doc = {
    id: newId(),
    kind,
    originalName: req.file.originalname,
    fileName: req.file.filename,
    url: `/admin-uploads/docs/${req.file.filename}`,
    createdAt: new Date().toISOString()
  };

  documents.unshift(doc);
  saveDocuments({ documents });
  if (ENABLE_EXPORTS) writeJsonAtomic(path.join(ROOT_DIR, 'documents.json'), { documents });

  res.json({ ok: true, doc });
});

app.delete('/api/documents/:id', requireAnyPermission([PERMISSIONS.COMMUNICATIONS_MANAGE, PERMISSIONS.FINANCE_WRITE]), (req, res) => {
  const id = String(req.params.id);
  const data = loadDocuments();
  const documents = Array.isArray(data.documents) ? data.documents : [];
  const doc = documents.find((d) => d.id === id);
  const next = documents.filter((d) => d.id !== id);
  saveDocuments({ documents: next });
  if (ENABLE_EXPORTS) writeJsonAtomic(path.join(ROOT_DIR, 'documents.json'), { documents: next });

  try {
    if (doc?.fileName) {
      const abs = path.join(DOCS_UPLOADS_DIR, doc.fileName);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    }
  } catch {
    // ignore
  }

  res.json({ ok: true });
});

// ----------------- LIVESTREAM -----------------
function loadLivestream() {
  return readJson(LIVESTREAM_DATA_PATH, readJson(LIVESTREAM_DATA_PATH, {
    active: { platform: 'website', platforms: ['website'], status: 'offline' },
    embeds: { youtube: '', facebook: '', website: '' },
    recurring: []
  }));
}
function saveLivestream(data) {
  writeJsonAtomic(LIVESTREAM_DATA_PATH, data);
}

app.get('/api/livestream', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), (req, res) => {
  res.json(loadLivestream());
});

app.put('/api/livestream', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), (req, res) => {
  const data = loadLivestream();

  const allowedPlatforms = new Set(['website', 'youtube', 'facebook']);
  const platform = sanitizeSegment(req.body.active?.platform || data.active.platform).toLowerCase();
  const status = sanitizeSegment(req.body.active?.status || data.active.status).toLowerCase();

  const rawPlatforms = Array.isArray(req.body.active?.platforms)
    ? req.body.active.platforms
    : Array.isArray(data.active?.platforms)
      ? data.active.platforms
      : [];

  const platforms = Array.from(new Set(
    rawPlatforms
      .map((p) => sanitizeSegment(p).toLowerCase())
      .filter((p) => allowedPlatforms.has(p))
  ));

  if (!platforms.length && allowedPlatforms.has(platform)) platforms.push(platform);
  if (platform && allowedPlatforms.has(platform) && !platforms.includes(platform)) platforms.unshift(platform);

  const next = {
    ...data,
    active: {
      platform,
      platforms,
      status
    },
    embeds: {
      youtube: String(req.body.embeds?.youtube ?? data.embeds.youtube).trim(),
      facebook: String(req.body.embeds?.facebook ?? data.embeds.facebook).trim(),
      website: String(req.body.embeds?.website ?? data.embeds.website).trim()
    },
    recurring: Array.isArray(req.body.recurring) ? req.body.recurring : data.recurring
  };

  saveLivestream(next);
  if (ENABLE_EXPORTS) writeJsonAtomic(path.join(ROOT_DIR, 'livestream.json'), next);

  res.json({ ok: true, data: next });
});

// ----------------- SETTINGS / THEME EXPORT -----------------
function loadSettings() {
  return readJson(SETTINGS_DATA_PATH, {
    social: {},
    theme: { accent: '#c46123', text: '#ffffff', background: '#000000', logoPath: '' }
  });
}
function saveSettings(data) {
  writeJsonAtomic(SETTINGS_DATA_PATH, data);
}

function buildThemeCss(theme) {
  const accent = theme?.accent || '#c46123';
  const text = theme?.text || '#ffffff';
  const background = theme?.background || '#000000';

  return `:root{\n  --mmmbc-accent:${accent};\n  --mmmbc-text:${text};\n  --mmmbc-bg:${background};\n}\n\n/* Optional theme overrides using variables */\n.top-nav .menu-button span{background-color:var(--mmmbc-accent);} \n.nav-links a:hover{background-color:var(--mmmbc-accent);} \n.home section h2{color:var(--mmmbc-accent);} \n.btn-contact{background-color:var(--mmmbc-accent);}\n`;
}

function sanitizeThemeInput(theme) {
  const t = theme || {};
  const pick = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  return {
    accent: pick(t.accent, '#c46123'),
    text: pick(t.text, '#ffffff'),
    background: pick(t.background, '#000000')
  };
}

// Theme preview is stored per-session for the logged-in admin only.
app.post('/api/theme/preview', requirePermission(PERMISSIONS.WEBSITE_WRITE), (req, res) => {
  req.session.themePreview = sanitizeThemeInput(req.body?.theme);
  res.json({ ok: true });
});

app.post('/api/theme/preview/clear', requirePermission(PERMISSIONS.WEBSITE_WRITE), (req, res) => {
  delete req.session.themePreview;
  res.json({ ok: true });
});

app.get('/api/settings', requirePermission(PERMISSIONS.WEBSITE_WRITE), (req, res) => {
  res.json(loadSettings());
});

app.put('/api/settings', requirePermission(PERMISSIONS.WEBSITE_WRITE), (req, res) => {
  const current = loadSettings();
  const next = {
    social: {
      ...current.social,
      ...(req.body.social || {})
    },
    theme: {
      ...current.theme,
      ...(req.body.theme || {})
    }
  };

  saveSettings(next);

  if (ENABLE_EXPORTS) {
    writeJsonAtomic(path.join(ROOT_DIR, 'site-settings.json'), next.social);
    fs.writeFileSync(path.join(ROOT_DIR, 'theme.css'), buildThemeCss(next.theme), 'utf8');
  }

  res.json({ ok: true, data: next });
});

// ----------------- EXPORT ALL -----------------
app.post('/api/export', requirePermission(PERMISSIONS.EXPORTS_RUN), async (req, res) => {
  try {
    if (!ENABLE_EXPORTS) return res.status(400).json({ error: 'Exports disabled' });

    const gallery = loadGallery();
    writeJsonAtomic(path.join(ROOT_DIR, 'gallery.json'), gallery);

    const announcements = await loadAnnouncementsUnified();
    writeJsonAtomic(path.join(ROOT_DIR, 'announcements.json'), announcements);

    const documents = loadDocuments();
    writeJsonAtomic(path.join(ROOT_DIR, 'documents.json'), documents);

    const bulletins = await loadBulletinsUnified();
    writeJsonAtomic(path.join(ROOT_DIR, 'bulletins.json'), bulletins);
    // Ensure bulletin files are present in /bulletins
    ensureRootBulletinsDir();
    for (const b of (bulletins.bulletins || [])) {
      if (b?.fileName) {
        try { copyBulletinToRoot(b.fileName); } catch { /* ignore */ }
      }
    }

    const settings = loadSettings();
    writeJsonAtomic(path.join(ROOT_DIR, 'site-settings.json'), settings.social);
    fs.writeFileSync(path.join(ROOT_DIR, 'theme.css'), buildThemeCss(settings.theme), 'utf8');

    const events = loadEvents();
    exportScheduleJson(events.events || []);

    const livestream = loadLivestream();
    writeJsonAtomic(path.join(ROOT_DIR, 'livestream.json'), livestream);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Export failed' });
  }
});

// ----------------- ERROR HANDLING -----------------
app.use((err, req, res, next) => {
  if (!err) return next();

  // If something already started sending a response, don't attempt to write headers/body again.
  if (res.headersSent) return next(err);

  if (err.code === 'EBADCSRFTOKEN') {
    audit('csrf_rejected', { at: new Date().toISOString(), ip: req.ip, path: req.originalUrl });
    return res.status(403).json({ error: 'Invalid CSRF token.' });
  }

  const status = Number(err.statusCode || err.status || 500);
  logger.error('request_error', {
    status,
    path: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userId: req.session?.user?.id || null,
    message: err.message,
    stack: err.stack
  });

  const safeMessage = process.env.NODE_ENV === 'production'
    ? 'Server error.'
    : (err.message || 'Server error.');
  res.status(status).json({ error: safeMessage });
});

// ----------------- BOOT -----------------
async function boot({ listen = true } = {}) {
  ensureDir(DATA_DIR);
  ensureDir(UPLOADS_DIR);
  ensureDir(DOCS_UPLOADS_DIR);
  ensureDir(BULLETINS_UPLOADS_DIR);
  ensureDir(ROOT_BULLETINS_DIR);
  ensureDir(GALLERY_DIR);

  await ensureMasterAdmin();

  if (!listen) return { port: null };

  const { port } = await listenWithPortFallback(app, PORT, { maxTries: 25, host: HOST || undefined });
  logger.info('server_started', { port, host: HOST || null, enforceHttps: ENFORCE_HTTPS, trustProxy: TRUST_PROXY });
  // Keep console messages for local dev convenience.
  console.log(`MMMBC Admin server running on http://localhost:${port}`);
  console.log(`Admin dashboard: http://localhost:${port}/admin/`);
  return { port };
}

if (require.main === module) {
  boot().catch((err) => {
    logger.error('boot_failed', { err, stack: err?.stack });
    console.error(err);
    process.exit(1);
  });
}

module.exports = { app, boot };
