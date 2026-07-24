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
const WEBPAGE_IMAGES_DIR = path.join(ROOT_DIR, 'ConImg', 'webPages');
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
function isPathInside(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveSessionsDir() {
  const defaultDir = path.join(os.tmpdir(), 'mmmbc-admin-sessions');
  const configured = String(process.env.SESSIONS_DIR || '').trim();
  if (!configured) return defaultDir;

  const resolved = path.resolve(configured);
  const unsafeWindowsRepoPath = process.platform === 'win32'
    && (isPathInside(ROOT_DIR, resolved) || isPathInside(ADMIN_DIR, resolved));

  if (unsafeWindowsRepoPath) {
    console.warn(`[MMMBC Admin] Ignoring SESSIONS_DIR=${configured} on Windows; using ${defaultDir} to avoid EPERM rename failures.`);
    return defaultDir;
  }

  return resolved;
}

const SESSIONS_DIR = resolveSessionsDir();

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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildSupportEmailTemplate({ subject, message, actor, replyTo }) {
  const safeSubject = escapeHtml(subject);
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');
  const safeActor = escapeHtml(actor || 'Unknown');
  const safeReplyTo = replyTo ? escapeHtml(replyTo) : 'Not provided';

  return {
    text: [
      'MMMBC Support Message',
      `Subject: ${subject}`,
      `From: ${actor}`,
      `Reply-To: ${replyTo || 'Not provided'}`,
      '',
      message
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2937;background:#f8fafc;padding:24px">
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:24px">
          <div style="font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#92400e;margin-bottom:12px">MMMBC Support</div>
          <h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:#111827">${safeSubject}</h1>
          <p style="margin:0 0 8px"><strong>From:</strong> ${safeActor}</p>
          <p style="margin:0 0 20px"><strong>Reply-to:</strong> ${safeReplyTo}</p>
          <div style="white-space:normal;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:16px;color:#111827">${safeMessage}</div>
        </div>
      </div>
    `
  };
}

function buildNewsletterEmailTemplate({ subject, message }) {
  const safeSubject = escapeHtml(subject);
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');

  return {
    text: `${message}\n\n---\nYou are receiving this message from MMMBC Admin.`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#1f2937;background:#f8fafc;padding:24px">
        <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:20px;overflow:hidden">
          <div style="padding:24px 28px;background:linear-gradient(135deg,#7f1d1d,#b45309);color:#ffffff">
            <div style="font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;opacity:.9">MMMBC Newsletter</div>
            <h1 style="margin:10px 0 0;font-size:30px;line-height:1.15">${safeSubject}</h1>
          </div>
          <div style="padding:28px;color:#111827;font-size:16px">
            <div style="white-space:normal">${safeMessage}</div>
            <div style="margin-top:28px;padding-top:18px;border-top:1px solid #e5e7eb;font-size:13px;color:#6b7280">
              Sent from the MMMBC admin newsletter editor.
            </div>
          </div>
        </div>
      </div>
    `
  };
}

function roleDisplayName(role) {
  const normalized = normalizeRole(role);
  if (normalized === ROLE.ADMINISTRATOR) return 'Administrator';
  if (normalized === ROLE.FINANCE_ENTRY) return 'Finance Entry';
  if (normalized === ROLE.TREASURER) return 'Treasurer';
  if (normalized === ROLE.AUDITOR) return 'Auditor';
  return 'Website Editor';
}

function buildAdminInviteEmailTemplate({ inviteLink, expiresAt, role }) {
  const roleLabel = roleDisplayName(role);
  const safeRoleLabel = escapeHtml(roleLabel);
  const safeInviteLink = escapeHtml(inviteLink);
  const expiresText = Number.isNaN(Date.parse(expiresAt))
    ? 'in 7 days'
    : new Date(expiresAt).toLocaleString();
  const safeExpiresText = escapeHtml(expiresText);

  return {
    text: [
      'Mt. Moriah Missionary Baptist Church Admin Invite',
      `Role: ${roleLabel}`,
      `Invite link: ${inviteLink}`,
      `Expires: ${expiresText}`,
      '',
      'Open the link to complete your account setup.'
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#1f2937;background:#f8fafc;padding:24px">
        <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:18px;overflow:hidden">
          <div style="padding:24px 28px;background:linear-gradient(135deg,#7a2f16,#c46123);color:#ffffff">
            <div style="font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;opacity:.92">Mt. Moriah MBC</div>
            <h1 style="margin:10px 0 0;font-size:28px;line-height:1.15">You are invited to Admin</h1>
          </div>
          <div style="padding:24px 28px;color:#111827;font-size:16px">
            <p style="margin:0 0 10px">You have been invited to join the church admin system.</p>
            <p style="margin:0 0 10px"><strong>Role:</strong> ${safeRoleLabel}</p>
            <p style="margin:0 0 18px"><strong>Expires:</strong> ${safeExpiresText}</p>
            <a href="${safeInviteLink}" style="display:inline-block;padding:12px 18px;border-radius:12px;background:#8b3f1f;color:#ffffff;text-decoration:none;font-weight:700">Complete Setup</a>
            <p style="margin:18px 0 0;font-size:13px;color:#6b7280;word-break:break-word">If the button does not work, copy this link:<br>${safeInviteLink}</p>
          </div>
        </div>
      </div>
    `
  };
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
  FINANCE_FUNDS_MANAGE: 'finance.funds.manage',
  DONOR_READ: 'donor.read',
  DONOR_WRITE: 'donor.write',
  DONOR_MERGE: 'donor.merge',
  STATEMENTS_MANAGE: 'statements.manage',
  STATEMENTS_APPROVE: 'statements.approve',
  BOARD_REPORTS_MANAGE: 'boardReports.manage',
  CONTROLS_VERIFY: 'controls.verify',
  CONTROLS_APPROVE_EXCEPTION: 'controls.approveException',
  HOUSING_MANAGE: 'housing.manage',
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
    PERMISSIONS.DONOR_READ,
    PERMISSIONS.DONOR_WRITE,
    PERMISSIONS.SUPPORT_SEND
  ],
  [ROLE.TREASURER]: [
    PERMISSIONS.FINANCE_READ,
    PERMISSIONS.FINANCE_WRITE,
    PERMISSIONS.FINANCE_META,
    PERMISSIONS.FINANCE_FUNDS_MANAGE,
    PERMISSIONS.DONOR_READ,
    PERMISSIONS.DONOR_WRITE,
    PERMISSIONS.DONOR_MERGE,
    PERMISSIONS.STATEMENTS_MANAGE,
    PERMISSIONS.STATEMENTS_APPROVE,
    PERMISSIONS.BOARD_REPORTS_MANAGE,
    PERMISSIONS.CONTROLS_VERIFY,
    PERMISSIONS.CONTROLS_APPROVE_EXCEPTION,
    PERMISSIONS.HOUSING_MANAGE,
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

function hasRole(user, roles) {
  const wanted = new Set((Array.isArray(roles) ? roles : [roles]).map((r) => normalizeRole(r)));
  return wanted.has(normalizeRole(user?.role));
}

function requireRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
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
    if (hasRole(user, allowed)) return next();
    audit('authz_denied', {
      at: new Date().toISOString(),
      ip: req.ip,
      path: req.originalUrl,
      userId: user.id,
      userEmail: user.email,
      role: user.role,
      roles: allowed
    });
    return res.status(403).json({ error: 'Forbidden' });
  };
}

function auditMetaFromRequest(req) {
  const user = sessionUser(req);
  return {
    at: new Date().toISOString(),
    ip: req.ip,
    userId: user?.id || '',
    userEmail: user?.email || '',
    role: normalizeRole(user?.role || '')
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
  crossOriginOpenerPolicy: false,
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
// Keep legacy login URLs working by redirecting users to the current admin entry point.
app.get(['/admin/login', '/admin/login.html', '/admin/login.js', '/admin/login_legacy.html'], (req, res) => {
  return res.redirect(302, '/admin/');
});

function sendAdminFinancePage(res, fileName) {
  return res.sendFile(path.join(ADMIN_DIR, 'public', fileName));
}

app.get('/admin/finances/funds', requirePermission(PERMISSIONS.FINANCE_READ), (req, res) => {
  return sendAdminFinancePage(res, 'finances_funds.html');
});
app.get('/admin/finances/dashboard', requirePermission(PERMISSIONS.FINANCE_READ), (req, res) => {
  return sendAdminFinancePage(res, 'finances_dashboard.html');
});

app.get('/admin/finances/donors', requirePermission(PERMISSIONS.DONOR_READ), (req, res) => {
  return sendAdminFinancePage(res, 'finances_donors.html');
});

app.get('/admin/finances/reports/board', requirePermission(PERMISSIONS.REPORTS_READ), (req, res) => {
  return sendAdminFinancePage(res, 'finances_reports_board.html');
});

app.get('/admin/finances/controls', requirePermission(PERMISSIONS.CONTROLS_VERIFY), (req, res) => {
  return sendAdminFinancePage(res, 'finances_controls.html');
});

app.get('/admin/finances/clergy-housing', requirePermission(PERMISSIONS.HOUSING_MANAGE), (req, res) => {
  return sendAdminFinancePage(res, 'finances_clergy_housing.html');
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
const PROFILES_DATA_PATH = path.join(DATA_DIR, 'profiles.json');
const NEWSLETTER_RECORDS_DATA_PATH = path.join(DATA_DIR, 'newsletter_records.json');
const FUNDS_DATA_PATH = path.join(DATA_DIR, 'funds.json');
const DONORS_DATA_PATH = path.join(DATA_DIR, 'donors.json');
const STATEMENTS_DATA_PATH = path.join(DATA_DIR, 'contribution_statements.json');
const CONTROLS_DATA_PATH = path.join(DATA_DIR, 'internal_controls.json');
const HOUSING_DATA_PATH = path.join(DATA_DIR, 'housing_allowance.json');
const FINANCE_MIGRATION_REPORT_PATH = path.join(DATA_DIR, 'finance_migration_report.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

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

const DEFAULT_FUND_TYPES = Object.freeze([
  'General Operating',
  'Savings',
  'Emergency Reserve',
  'Building',
  'Missions',
  'Benevolence',
  'Youth Ministry',
  'Scholarship',
  'Memorial',
  'Capital Project',
  'Board Designated',
  'Donor Restricted',
  'Other'
]);

function ensureBackupsDir() {
  ensureDir(BACKUP_DIR);
}

function writeBackupFile(baseName, payload) {
  ensureBackupsDir();
  const safeName = sanitizeSegment(baseName).replace(/[^a-z0-9_-]/gi, '_') || 'backup';
  const stamp = new Date().toISOString().replace(/[.:]/g, '-');
  const fileName = `${safeName}_${stamp}.json`;
  const abs = path.join(BACKUP_DIR, fileName);
  writeJsonAtomic(abs, payload);
  return abs;
}

function parseMoneyCents(value) {
  if (Number.isFinite(value)) return Math.round(Number(value));
  return normalizeMoneyToCents(value);
}

function normalizeFundType(value) {
  const v = String(value || '').trim();
  if (!v) return 'Other';
  const match = DEFAULT_FUND_TYPES.find((t) => t.toLowerCase() === v.toLowerCase());
  return match || v.slice(0, 80);
}

function normalizeRestrictionStatus(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'unrestricted') return 'unrestricted';
  if (v === 'board_designated') return 'board_designated';
  if (v === 'temporarily_restricted') return 'temporarily_restricted';
  if (v === 'permanently_restricted') return 'permanently_restricted';
  if (v === 'needs_treasurer_review') return 'needs_treasurer_review';
  return 'needs_treasurer_review';
}

function normalizeFundRecord(raw, actor) {
  const now = new Date().toISOString();
  const openingBalanceCents = parseMoneyCents(raw?.openingBalanceCents ?? raw?.openingBalance);
  const minimumBalanceWarningCents = parseMoneyCents(raw?.minimumBalanceWarningCents ?? raw?.minimumBalanceWarning);
  const budgetAmountCents = parseMoneyCents(raw?.budgetAmountCents ?? raw?.budgetAmount);
  const active = raw?.active !== false;

  return {
    id: String(raw?.id || newId()).trim() || newId(),
    fundName: String(raw?.fundName || raw?.name || '').trim().slice(0, 120),
    fundCode: String(raw?.fundCode || '').trim().slice(0, 30),
    description: String(raw?.description || '').trim().slice(0, 500),
    fundType: normalizeFundType(raw?.fundType),
    restrictionStatus: normalizeRestrictionStatus(raw?.restrictionStatus),
    restrictionType: String(raw?.restrictionType || 'none').trim().toLowerCase().slice(0, 60),
    restrictionPurpose: String(raw?.restrictionPurpose || '').trim().slice(0, 300),
    restrictionSource: String(raw?.restrictionSource || '').trim().slice(0, 160),
    effectiveDate: normalizeDateOnly(raw?.effectiveDate),
    endDate: normalizeDateOnly(raw?.endDate),
    openingBalanceCents: Number.isFinite(openingBalanceCents) ? openingBalanceCents : 0,
    minimumBalanceWarningCents: Number.isFinite(minimumBalanceWarningCents) ? Math.max(0, minimumBalanceWarningCents) : 0,
    budgetAmountCents: Number.isFinite(budgetAmountCents) ? Math.max(0, budgetAmountCents) : 0,
    associatedBudget: String(raw?.associatedBudget || '').trim().slice(0, 120),
    responsibleMinistry: String(raw?.responsibleMinistry || '').trim().slice(0, 120),
    responsibleAdministrator: String(raw?.responsibleAdministrator || '').trim().slice(0, 120),
    defaultIncomeCategory: String(raw?.defaultIncomeCategory || '').trim().slice(0, 80),
    defaultExpenseCategory: String(raw?.defaultExpenseCategory || '').trim().slice(0, 80),
    publicGivingAvailable: raw?.publicGivingAvailable === true,
    displayOrder: Number.isFinite(Number(raw?.displayOrder)) ? Number(raw.displayOrder) : 999,
    active,
    archivedAt: active ? '' : String(raw?.archivedAt || now),
    notes: String(raw?.notes || '').trim().slice(0, 3000),
    attachments: Array.isArray(raw?.attachments) ? raw.attachments.slice(0, 50) : [],
    bankAccounts: Array.isArray(raw?.bankAccounts) ? uniqNonEmptyStrings(raw.bankAccounts).slice(0, 20) : [],
    createdAt: String(raw?.createdAt || now),
    createdBy: String(raw?.createdBy || actor?.id || '').slice(0, 120),
    updatedAt: now,
    updatedBy: String(actor?.id || raw?.updatedBy || '').slice(0, 120)
  };
}

function loadFundsData() {
  const data = readJson(FUNDS_DATA_PATH, {
    funds: [],
    customFundTypes: [],
    transfers: [],
    releases: [],
    audit: []
  });
  return {
    funds: Array.isArray(data?.funds) ? data.funds : [],
    customFundTypes: uniqNonEmptyStrings(data?.customFundTypes || []),
    transfers: Array.isArray(data?.transfers) ? data.transfers : [],
    releases: Array.isArray(data?.releases) ? data.releases : [],
    audit: Array.isArray(data?.audit) ? data.audit : []
  };
}

function saveFundsData(data) {
  writeJsonAtomic(FUNDS_DATA_PATH, {
    funds: Array.isArray(data?.funds) ? data.funds : [],
    customFundTypes: uniqNonEmptyStrings(data?.customFundTypes || []),
    transfers: Array.isArray(data?.transfers) ? data.transfers : [],
    releases: Array.isArray(data?.releases) ? data.releases : [],
    audit: Array.isArray(data?.audit) ? data.audit : []
  });
}

function findFundByAnyKey(funds, key) {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return null;
  return (funds || []).find((f) => {
    const id = String(f?.id || '').toLowerCase();
    const name = String(f?.fundName || '').toLowerCase();
    const code = String(f?.fundCode || '').toLowerCase();
    return k === id || k === name || k === code;
  }) || null;
}

function getApprovedTransfers(transfers) {
  return (transfers || []).filter((t) => String(t?.status || '') === 'approved');
}

function getFundBalances() {
  const finance = loadFinances();
  const fundsData = loadFundsData();
  const funds = fundsData.funds || [];

  const byFund = new Map();
  for (const f of funds) {
    byFund.set(String(f.id), {
      fundId: String(f.id),
      currentBalanceCents: Number(f.openingBalanceCents || 0),
      availableBalanceCents: Number(f.openingBalanceCents || 0),
      pendingDepositsCents: 0,
      pendingExpensesCents: 0,
      ytdIncomeCents: 0,
      ytdExpenseCents: 0,
      lastActivityDate: '',
      assignedCount: 0
    });
  }

  const thisYear = new Date().getUTCFullYear();
  const entries = Array.isArray(finance.entries) ? finance.entries : [];
  for (const e of entries) {
    const fund = findFundByAnyKey(funds, e.fundId || e.fund);
    if (!fund) continue;
    const id = String(fund.id);
    const row = byFund.get(id);
    if (!row) continue;

    const amount = Math.abs(Number(e.amountCents || 0));
    if (!amount) continue;
    const type = String(e.type || '').toLowerCase();
    const status = String(e.status || 'posted').toLowerCase();
    const entryDate = normalizeDateOnly(e.date);

    row.assignedCount += 1;
    if (!row.lastActivityDate || entryDate > row.lastActivityDate) row.lastActivityDate = entryDate;

    if (type === 'income') {
      if (status === 'pending') row.pendingDepositsCents += amount;
      else row.currentBalanceCents += amount;
      if (entryDate.startsWith(`${thisYear}-`)) row.ytdIncomeCents += amount;
    } else if (type === 'expense') {
      if (status === 'pending') row.pendingExpensesCents += amount;
      else row.currentBalanceCents -= amount;
      if (entryDate.startsWith(`${thisYear}-`)) row.ytdExpenseCents += amount;
    }
  }

  for (const t of getApprovedTransfers(fundsData.transfers)) {
    const amount = Math.abs(Number(t?.amountCents || 0));
    if (!amount) continue;
    const from = byFund.get(String(t?.fromFundId || ''));
    const to = byFund.get(String(t?.toFundId || ''));
    if (from) {
      from.currentBalanceCents -= amount;
      if (!from.lastActivityDate || String(t.approvedAt || '') > from.lastActivityDate) {
        from.lastActivityDate = normalizeDateOnly(t.approvedAt);
      }
    }
    if (to) {
      to.currentBalanceCents += amount;
      if (!to.lastActivityDate || String(t.approvedAt || '') > to.lastActivityDate) {
        to.lastActivityDate = normalizeDateOnly(t.approvedAt);
      }
    }
  }

  for (const f of funds) {
    const row = byFund.get(String(f.id));
    if (!row) continue;
    row.availableBalanceCents = row.currentBalanceCents - row.pendingExpensesCents;
    if (['temporarily_restricted', 'permanently_restricted'].includes(String(f.restrictionStatus))) {
      row.availableBalanceCents = Math.max(0, row.availableBalanceCents);
    }
  }

  return { fundsData, balances: byFund };
}

function normalizeDonor(raw, actor) {
  const now = new Date().toISOString();
  return {
    id: String(raw?.id || newId()).trim() || newId(),
    firstName: String(raw?.firstName || '').trim().slice(0, 80),
    middleName: String(raw?.middleName || '').trim().slice(0, 80),
    lastName: String(raw?.lastName || '').trim().slice(0, 80),
    preferredName: String(raw?.preferredName || '').trim().slice(0, 80),
    householdId: String(raw?.householdId || '').trim().slice(0, 80),
    spouseDonorId: String(raw?.spouseDonorId || '').trim().slice(0, 80),
    mailingAddress: String(raw?.mailingAddress || '').trim().slice(0, 300),
    email: String(raw?.email || '').trim().toLowerCase().slice(0, 254),
    phone: String(raw?.phone || '').trim().slice(0, 30),
    envelopeNumber: String(raw?.envelopeNumber || '').trim().slice(0, 30),
    preferredStatementDelivery: String(raw?.preferredStatementDelivery || 'mail').trim().toLowerCase().slice(0, 30),
    active: raw?.active !== false,
    anonymousGiving: raw?.anonymousGiving === true,
    statementEligible: raw?.statementEligible !== false,
    taxReviewStatus: String(raw?.taxReviewStatus || 'needs_review').trim().toLowerCase().slice(0, 40),
    restrictedNotes: String(raw?.restrictedNotes || '').trim().slice(0, 4000),
    documents: Array.isArray(raw?.documents) ? raw.documents.slice(0, 50) : [],
    createdAt: String(raw?.createdAt || now),
    updatedAt: now,
    createdBy: String(raw?.createdBy || actor?.id || '').slice(0, 120),
    updatedBy: String(actor?.id || raw?.updatedBy || '').slice(0, 120)
  };
}

function loadDonorsData() {
  const data = readJson(DONORS_DATA_PATH, { donors: [], households: [], merges: [] });
  return {
    donors: Array.isArray(data?.donors) ? data.donors : [],
    households: Array.isArray(data?.households) ? data.households : [],
    merges: Array.isArray(data?.merges) ? data.merges : []
  };
}

function saveDonorsData(data) {
  writeJsonAtomic(DONORS_DATA_PATH, {
    donors: Array.isArray(data?.donors) ? data.donors : [],
    households: Array.isArray(data?.households) ? data.households : [],
    merges: Array.isArray(data?.merges) ? data.merges : []
  });
}

function donorDisplayName(d) {
  const first = String(d?.preferredName || d?.firstName || '').trim();
  const last = String(d?.lastName || '').trim();
  return `${first} ${last}`.trim();
}

function findDonorByAnyKey(donors, donorRef) {
  const key = String(donorRef || '').trim();
  if (!key) return null;
  const down = key.toLowerCase();
  return (donors || []).find((d) => {
    const id = String(d?.id || '').trim();
    const envelope = String(d?.envelopeNumber || '').trim();
    const name = donorDisplayName(d).toLowerCase();
    return id === key
      || (envelope && envelope.toLowerCase() === down)
      || (name && name === down);
  }) || null;
}

function resolveEntryDonor(donors, donorRef, type, strict = false) {
  const donor = findDonorByAnyKey(donors, donorRef);
  if (!donorRef) return { donorId: '', donorName: '' };
  if (!donor) {
    if (strict || String(type || '').toLowerCase() === 'income') {
      return { error: 'The selected donor could not be found. Choose a valid donor profile.' };
    }
    return { donorId: String(donorRef).trim(), donorName: '' };
  }
  return {
    donorId: String(donor.id),
    donorName: donorDisplayName(donor)
  };
}

function syncEntryDonorSnapshots(entries, donors) {
  let changed = false;
  for (const entry of (entries || [])) {
    const donorId = String(entry?.donorId || '').trim();
    if (!donorId) {
      if (entry?.donorName) {
        entry.donorName = '';
        changed = true;
      }
      continue;
    }
    const donor = findDonorByAnyKey(donors, donorId);
    if (!donor) continue;
    const nextName = donorDisplayName(donor);
    if (String(entry?.donorId || '') !== String(donor.id)) {
      entry.donorId = String(donor.id);
      changed = true;
    }
    if (String(entry?.donorName || '') !== nextName) {
      entry.donorName = nextName;
      changed = true;
    }
  }
  return changed;
}

function syncStatementDonorSnapshots(statements, donors) {
  let changed = false;
  for (const stmt of (statements || [])) {
    const donor = findDonorByAnyKey(donors, stmt?.donorId || '');
    if (!donor) continue;
    const nextName = donorDisplayName(donor);
    const nextAddress = String(donor?.mailingAddress || '');
    if (String(stmt?.donorId || '') !== String(donor.id)) {
      stmt.donorId = String(donor.id);
      changed = true;
    }
    if (String(stmt?.donorName || '') !== nextName) {
      stmt.donorName = nextName;
      changed = true;
    }
    if (String(stmt?.donorMailingAddress || '') !== nextAddress) {
      stmt.donorMailingAddress = nextAddress;
      changed = true;
    }
  }
  return changed;
}

function findPossibleDonorDuplicates(donors, candidate) {
  const nameKey = donorDisplayName(candidate).toLowerCase();
  const email = String(candidate?.email || '').toLowerCase();
  const phone = String(candidate?.phone || '').replace(/\D/g, '');
  const envelope = String(candidate?.envelopeNumber || '').toLowerCase();
  const address = String(candidate?.mailingAddress || '').toLowerCase();
  const householdId = String(candidate?.householdId || '').toLowerCase();

  return (donors || []).filter((d) => {
    if (candidate?.id && String(d.id) === String(candidate.id)) return false;
    const dName = donorDisplayName(d).toLowerCase();
    const dEmail = String(d?.email || '').toLowerCase();
    const dPhone = String(d?.phone || '').replace(/\D/g, '');
    const dEnvelope = String(d?.envelopeNumber || '').toLowerCase();
    const dAddress = String(d?.mailingAddress || '').toLowerCase();
    const dHousehold = String(d?.householdId || '').toLowerCase();
    return (
      (nameKey && dName && dName === nameKey)
      || (email && dEmail && dEmail === email)
      || (phone && dPhone && dPhone === phone)
      || (envelope && dEnvelope && dEnvelope === envelope)
      || (address && dAddress && dAddress === address)
      || (householdId && dHousehold && dHousehold === householdId)
    );
  }).slice(0, 20);
}

function loadStatementsData() {
  const data = readJson(STATEMENTS_DATA_PATH, {
    templates: {
      acknowledgmentLanguage: 'Thank you for your faithful giving and support.',
      intangibleReligiousBenefitLanguage: 'No goods or services were provided in exchange for these contributions other than intangible religious benefits.'
    },
    statements: [],
    deliveries: []
  });
  return {
    templates: data?.templates && typeof data.templates === 'object' ? data.templates : {},
    statements: Array.isArray(data?.statements) ? data.statements : [],
    deliveries: Array.isArray(data?.deliveries) ? data.deliveries : []
  };
}

function saveStatementsData(data) {
  writeJsonAtomic(STATEMENTS_DATA_PATH, {
    templates: data?.templates && typeof data.templates === 'object' ? data.templates : {},
    statements: Array.isArray(data?.statements) ? data.statements : [],
    deliveries: Array.isArray(data?.deliveries) ? data.deliveries : []
  });
}

function loadControlsData() {
  const data = readJson(CONTROLS_DATA_PATH, {
    twoPersonVerificationEnabled: true,
    collections: [],
    exceptions: []
  });
  return {
    twoPersonVerificationEnabled: data?.twoPersonVerificationEnabled !== false,
    collections: Array.isArray(data?.collections) ? data.collections : [],
    exceptions: Array.isArray(data?.exceptions) ? data.exceptions : []
  };
}

function saveControlsData(data) {
  writeJsonAtomic(CONTROLS_DATA_PATH, {
    twoPersonVerificationEnabled: data?.twoPersonVerificationEnabled !== false,
    collections: Array.isArray(data?.collections) ? data.collections : [],
    exceptions: Array.isArray(data?.exceptions) ? data.exceptions : []
  });
}

function loadHousingData() {
  const data = readJson(HOUSING_DATA_PATH, { profiles: [], annualRecords: [] });
  return {
    profiles: Array.isArray(data?.profiles) ? data.profiles : [],
    annualRecords: Array.isArray(data?.annualRecords) ? data.annualRecords : []
  };
}

function saveHousingData(data) {
  writeJsonAtomic(HOUSING_DATA_PATH, {
    profiles: Array.isArray(data?.profiles) ? data.profiles : [],
    annualRecords: Array.isArray(data?.annualRecords) ? data.annualRecords : []
  });
}

function normalizeFinanceStatementPeriod(rawFrom, rawTo) {
  const from = normalizeDateOnly(rawFrom);
  const to = normalizeDateOnly(rawTo);
  if (!from || !to || from > to) return null;
  return { from, to };
}

function migrateLegacyFundsAndAssignments() {
  const finance = loadFinances();
  const fundsData = loadFundsData();
  const entries = Array.isArray(finance.entries) ? finance.entries : [];
  let changed = false;

  if (!fundsData.funds.length) {
    const names = uniqNonEmptyStrings([
      ...(finance.meta?.funds || []),
      ...entries.map((e) => String(e?.fund || '').trim())
    ]);
    const now = new Date().toISOString();
    for (const name of names) {
      fundsData.funds.push(normalizeFundRecord({
        id: newId(),
        fundName: name,
        fundCode: name.replace(/\s+/g, '_').toUpperCase().slice(0, 20),
        description: 'Migrated from existing finance records. Needs Treasurer Review.',
        fundType: 'Other',
        restrictionStatus: 'needs_treasurer_review',
        restrictionType: 'none',
        openingBalanceCents: 0,
        active: true,
        createdAt: now,
        updatedAt: now
      }, { id: 'migration' }));
    }
    changed = names.length > 0;
  }

  for (const entry of entries) {
    if (entry.fundId) continue;
    const found = findFundByAnyKey(fundsData.funds, entry.fund);
    if (!found) continue;
    entry.fundId = String(found.id);
    changed = true;
  }

  if (!changed) return { changed: false, report: null };

  const beforeBackup = writeBackupFile('finances_before_fund_migration', finance);
  saveFinances(finance);
  saveFundsData(fundsData);

  const report = {
    migratedAt: new Date().toISOString(),
    beforeBackup,
    fundsCreated: fundsData.funds.length,
    entriesUpdated: entries.filter((e) => !!e.fundId).length,
    notes: [
      'Restriction classifications with unclear legacy values were marked as Needs Treasurer Review.',
      'Original fund names were preserved while adding stable fund IDs.'
    ]
  };
  writeJsonAtomic(FINANCE_MIGRATION_REPORT_PATH, report);
  return { changed: true, report };
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

  const toEmail = String(process.env.SUPPORT_TO_EMAIL || 'support@alphazonelabs.com').trim();
  const fromEmail = String(process.env.SUPPORT_FROM_EMAIL || 'no-reply@mmmbc.com').trim();
  const fromName = String(process.env.SUPPORT_FROM_NAME || 'MMMBC Admin Support').trim() || 'MMMBC Admin Support';

  const composedSubject = `[MMMBC Support] ${subject}`;
  const supportTemplate = buildSupportEmailTemplate({
    subject: composedSubject,
    message,
    actor: getSupportActor(req),
    replyTo
  });

  try {
    const payload = {
      personalizations: [{ to: [{ email: toEmail }], subject: composedSubject }],
      from: { email: fromEmail, name: fromName },
      ...(replyTo ? { reply_to: { email: replyTo } } : {}),
      content: [
        { type: 'text/plain', value: supportTemplate.text },
        { type: 'text/html', value: supportTemplate.html }
      ]
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
  const role = normalizeRole(req.body.role || ROLE.WEBSITE_EDITOR);
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
    role,
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

  if (envBool('SUPPORT_DISABLE_SEND', false) || process.env.NODE_ENV === 'test') {
    return res.json({ ok: true, inviteLink, expiresAt, emailSent: false, disabled: true });
  }

  const fromEmail = String(process.env.SUPPORT_FROM_EMAIL || 'no-reply@mmmbc.com').trim();
  const fromName = String(process.env.SUPPORT_FROM_NAME || 'MMMBC Admin').trim() || 'MMMBC Admin';
  const subject = `MMMBC Admin Invite (${roleDisplayName(role)})`;
  const template = buildAdminInviteEmailTemplate({ inviteLink, expiresAt, role });

  try {
    const payload = {
      personalizations: [{ to: [{ email }], subject }],
      from: { email: fromEmail, name: fromName },
      content: [
        { type: 'text/plain', value: template.text },
        { type: 'text/html', value: template.html }
      ]
    };

    const out = await mailchannelsSend(payload);
    if (out.status < 200 || out.status >= 300) {
      logger.error('admin_invite_email_failed', { status: out.status, body: String(out.body || '').slice(0, 2000), email, role });
      return res.json({ ok: true, inviteLink, expiresAt, emailSent: false });
    }

    return res.json({ ok: true, inviteLink, expiresAt, emailSent: true });
  } catch (e) {
    logger.error('admin_invite_email_error', { err: e, email, role });
    return res.json({ ok: true, inviteLink, expiresAt, emailSent: false });
  }
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
const siteImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 }
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

app.post('/api/site-editor/upload-image', requirePermission(PERMISSIONS.WEBSITE_WRITE), siteImageUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image was uploaded.' });
  const mimeType = String(req.file.mimetype || '').trim().toLowerCase();
  if (!isAllowedImage(mimeType)) return res.status(400).json({ error: 'Only image uploads are allowed.' });

  const page = sanitizeSegment(req.body?.page || 'page').toLowerCase() || 'page';
  const profileId = sanitizeSegment(req.body?.profileId || '') || newId();
  const ext = mime.extension(mimeType) || 'jpg';
  const fileName = `${new Date().toISOString().slice(0, 10)}_${page}_${profileId}_${newId()}.${ext}`;

  ensureDir(WEBPAGE_IMAGES_DIR);
  const abs = path.join(WEBPAGE_IMAGES_DIR, fileName);
  fs.writeFileSync(abs, req.file.buffer);

  // Optional optimization for large images while preserving broad format support.
  try {
    const isLarge = Number(req.file.size || 0) > (2 * 1024 * 1024);
    if (isLarge && ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(mimeType)) {
      const optimized = await sharp(req.file.buffer)
        .rotate()
        .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
        .toBuffer();
      fs.writeFileSync(abs, optimized);
    }
  } catch {
    // Keep original upload if optimization fails.
  }

  return res.json({ ok: true, path: `/ConImg/webPages/${fileName}` });
});

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
  const fundIdInput = String(req.body?.fundId || '').trim();
  const method = normalizeFinanceText(req.body?.method, 24).toLowerCase();
  const party = normalizeFinanceText(req.body?.party, 120);
  const memo = normalizeFinanceText(req.body?.memo, 200);
  const amountCents = normalizeMoneyToCents(req.body?.amount);
  const donorId = String(req.body?.donorId || '').trim();
  const statementReviewStatus = String(req.body?.statementReviewStatus || 'needs_review').trim().toLowerCase();
  const goodsServicesValueCents = parseMoneyCents(req.body?.goodsServicesValueCents ?? req.body?.goodsServicesValue);

  if (!date) return res.status(400).json({ error: 'Valid date required.' });
  if (type !== 'income' && type !== 'expense') return res.status(400).json({ error: 'Type must be income or expense.' });
  if (!category) return res.status(400).json({ error: 'Category required.' });
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'Amount must be greater than 0.' });
  if (!fund && !fundIdInput) return res.status(400).json({ error: 'Please select a fund before saving this transaction.' });

  const { fundsData, balances } = getFundBalances();
  const donorsData = loadDonorsData();
  const selectedFund = findFundByAnyKey(fundsData.funds, fundIdInput || fund);
  if (!selectedFund) return res.status(400).json({ error: 'The selected fund could not be found. Choose a valid fund.' });
  if (selectedFund.active === false) return res.status(400).json({ error: 'This fund is archived. Reactivate it before posting transactions.' });

  const donorResolution = resolveEntryDonor(donorsData.donors, donorId, type, true);
  if (donorResolution.error) return res.status(400).json({ error: donorResolution.error });

  const fundBalance = balances.get(String(selectedFund.id));
  const available = Number(fundBalance?.availableBalanceCents || 0);
  const isRestricted = ['temporarily_restricted', 'permanently_restricted'].includes(String(selectedFund.restrictionStatus));
  if (type === 'expense' && amountCents > available) {
    const base = 'The selected fund does not have enough available money.';
    if (isRestricted) return res.status(400).json({ error: `${base} This expense would use money from a restricted fund.` });
    return res.status(400).json({ error: base });
  }

  const data = loadFinances();
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const meta = data.meta && typeof data.meta === 'object' ? data.meta : { categories: [], funds: [] };

  const entry = {
    id: newId(),
    date,
    type,
    category,
    fund: selectedFund.fundName,
    fundId: selectedFund.id,
    method,
    party,
    memo,
    donorId: donorResolution.donorId,
    donorName: donorResolution.donorName,
    statementReviewStatus,
    goodsServicesValueCents: Number.isFinite(goodsServicesValueCents) ? Math.max(0, goodsServicesValueCents) : 0,
    status: String(req.body?.status || 'posted').trim().toLowerCase() === 'pending' ? 'pending' : 'posted',
    amountCents,
    createdAt: new Date().toISOString()
  };

  entries.push(entry);
  sortFinanceEntries(entries);

  const nextMeta = {
    categories: uniqNonEmptyStrings([...(meta.categories || []), category]),
    funds: uniqNonEmptyStrings([...(meta.funds || []), selectedFund.fundName])
  };
  const next = { entries, meta: nextMeta };
  saveFinances(next);
  audit('finance_entry_created', {
    ...auditMetaFromRequest(req),
    recordType: 'finance_entry',
    recordId: entry.id,
    newValues: {
      date: entry.date,
      type: entry.type,
      fundId: entry.fundId,
      amountCents: entry.amountCents
    }
  });
  res.json({ ok: true, entry, data: next });
});

app.put('/api/finances/entries/:id', requirePermission(PERMISSIONS.FINANCE_WRITE), (req, res) => {
  const id = String(req.params.id);
  const date = normalizeDateOnly(req.body?.date);
  const type = String(req.body?.type || '').trim().toLowerCase();
  const category = normalizeFinanceText(req.body?.category, 80);
  const fund = normalizeFinanceText(req.body?.fund, 80);
  const fundIdInput = String(req.body?.fundId || '').trim();
  const method = normalizeFinanceText(req.body?.method, 24).toLowerCase();
  const party = normalizeFinanceText(req.body?.party, 120);
  const memo = normalizeFinanceText(req.body?.memo, 200);
  const amountCents = normalizeMoneyToCents(req.body?.amount);
  const donorId = String(req.body?.donorId || '').trim();
  const statementReviewStatus = String(req.body?.statementReviewStatus || 'needs_review').trim().toLowerCase();
  const goodsServicesValueCents = parseMoneyCents(req.body?.goodsServicesValueCents ?? req.body?.goodsServicesValue);

  if (!date) return res.status(400).json({ error: 'Valid date required.' });
  if (type !== 'income' && type !== 'expense') return res.status(400).json({ error: 'Type must be income or expense.' });
  if (!category) return res.status(400).json({ error: 'Category required.' });
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'Amount must be greater than 0.' });
  if (!fund && !fundIdInput) return res.status(400).json({ error: 'Please select a fund before saving this transaction.' });

  const { fundsData, balances } = getFundBalances();
  const donorsData = loadDonorsData();
  const selectedFund = findFundByAnyKey(fundsData.funds, fundIdInput || fund);
  if (!selectedFund) return res.status(400).json({ error: 'The selected fund could not be found. Choose a valid fund.' });
  if (selectedFund.active === false) return res.status(400).json({ error: 'This fund is archived. Reactivate it before posting transactions.' });

  const donorResolution = resolveEntryDonor(donorsData.donors, donorId, type, true);
  if (donorResolution.error) return res.status(400).json({ error: donorResolution.error });

  const fundBalance = balances.get(String(selectedFund.id));
  const available = Number(fundBalance?.availableBalanceCents || 0);
  const isRestricted = ['temporarily_restricted', 'permanently_restricted'].includes(String(selectedFund.restrictionStatus));
  if (type === 'expense' && amountCents > available) {
    const base = 'The selected fund does not have enough available money.';
    if (isRestricted) return res.status(400).json({ error: `${base} This expense would use money from a restricted fund.` });
    return res.status(400).json({ error: base });
  }

  const data = loadFinances();
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const entry = entries.find((e) => e.id === id);
  if (!entry) return res.status(404).json({ error: 'Not found' });

  const prev = {
    date: entry.date,
    type: entry.type,
    category: entry.category,
    fundId: entry.fundId || '',
    amountCents: entry.amountCents
  };

  entry.date = date;
  entry.type = type;
  entry.category = category;
  entry.fund = selectedFund.fundName;
  entry.fundId = selectedFund.id;
  entry.method = method;
  entry.party = party;
  entry.memo = memo;
  entry.donorId = donorResolution.donorId;
  entry.donorName = donorResolution.donorName;
  entry.statementReviewStatus = statementReviewStatus;
  entry.goodsServicesValueCents = Number.isFinite(goodsServicesValueCents) ? Math.max(0, goodsServicesValueCents) : 0;
  entry.status = String(req.body?.status || entry.status || 'posted').trim().toLowerCase() === 'pending' ? 'pending' : 'posted';
  entry.amountCents = amountCents;
  entry.updatedAt = new Date().toISOString();

  sortFinanceEntries(entries);
  const meta = data.meta && typeof data.meta === 'object' ? data.meta : { categories: [], funds: [] };
  const nextMeta = {
    categories: uniqNonEmptyStrings([...(meta.categories || []), category]),
    funds: uniqNonEmptyStrings([...(meta.funds || []), selectedFund.fundName])
  };
  const next = { entries, meta: nextMeta };
  saveFinances(next);
  audit('finance_entry_edited', {
    ...auditMetaFromRequest(req),
    recordType: 'finance_entry',
    recordId: entry.id,
    previousValues: prev,
    newValues: {
      date: entry.date,
      type: entry.type,
      category: entry.category,
      fundId: entry.fundId,
      amountCents: entry.amountCents
    }
  });
  res.json({ ok: true, entry, data: next });
});

app.delete('/api/finances/entries/:id', requirePermission(PERMISSIONS.FINANCE_WRITE), (req, res) => {
  const id = String(req.params.id);
  const data = loadFinances();
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const nextEntries = entries.filter((e) => e.id !== id);
  const next = { entries: nextEntries, meta: data.meta || { categories: [], funds: [] } };
  saveFinances(next);
  audit('finance_entry_deleted', {
    ...auditMetaFromRequest(req),
    recordType: 'finance_entry',
    recordId: id
  });
  res.json({ ok: true, data: next });
});

app.get('/api/finances/migration-report', requirePermission(PERMISSIONS.FINANCE_READ), (req, res) => {
  res.json(readJson(FINANCE_MIGRATION_REPORT_PATH, { migratedAt: '', notes: [] }));
});

app.get('/api/finances/funds/types', requirePermission(PERMISSIONS.FINANCE_READ), (req, res) => {
  const data = loadFundsData();
  res.json({
    defaultFundTypes: DEFAULT_FUND_TYPES,
    customFundTypes: data.customFundTypes || []
  });
});

app.post('/api/finances/funds/types', requirePermission(PERMISSIONS.FINANCE_FUNDS_MANAGE), (req, res) => {
  const user = sessionUser(req);
  if (!hasRole(user, [ROLE.ADMINISTRATOR, ROLE.TREASURER])) {
    return res.status(403).json({ error: 'Only an Administrator or Treasurer can add custom fund types.' });
  }

  const type = String(req.body?.type || '').trim().slice(0, 80);
  if (!type) return res.status(400).json({ error: 'Fund type name is required.' });
  const data = loadFundsData();
  data.customFundTypes = uniqNonEmptyStrings([...(data.customFundTypes || []), type]);
  saveFundsData(data);
  audit('fund_type_added', {
    ...auditMetaFromRequest(req),
    action: 'fund_type_added',
    newValues: { type }
  });
  res.json({ ok: true, customFundTypes: data.customFundTypes });
});

app.get('/api/finances/funds', requirePermission(PERMISSIONS.FINANCE_READ), (req, res) => {
  const data = loadFundsData();
  const { balances } = getFundBalances();
  const funds = data.funds.map((f) => {
    const b = balances.get(String(f.id)) || {
      currentBalanceCents: Number(f.openingBalanceCents || 0),
      availableBalanceCents: Number(f.openingBalanceCents || 0),
      pendingDepositsCents: 0,
      pendingExpensesCents: 0,
      ytdIncomeCents: 0,
      ytdExpenseCents: 0,
      lastActivityDate: ''
    };
    return { ...f, ...b, remainingBudgetCents: Number(f.budgetAmountCents || 0) - Number(b.ytdExpenseCents || 0) };
  });
  res.json({
    funds: funds.sort((a, b) => Number(a.displayOrder || 999) - Number(b.displayOrder || 999) || String(a.fundName).localeCompare(String(b.fundName))),
    customFundTypes: data.customFundTypes || []
  });
});

app.get('/api/finances/funds/dashboard', requirePermission(PERMISSIONS.FINANCE_READ), (req, res) => {
  const finance = loadFinances();
  const { fundsData, balances } = getFundBalances();
  const funds = fundsData.funds || [];
  const summary = {
    totalUnrestrictedFundsCents: 0,
    totalRestrictedFundsCents: 0,
    generalOperatingBalanceCents: 0,
    savingsAndReservesCents: 0,
    undepositedRestrictedContributionsCents: 0,
    lowBalanceFundIds: [],
    overspendingFundIds: [],
    transactionsRequiringFundAssignment: 0
  };

  const rows = funds.map((f) => {
    const b = balances.get(String(f.id)) || {
      currentBalanceCents: Number(f.openingBalanceCents || 0),
      availableBalanceCents: Number(f.openingBalanceCents || 0),
      pendingDepositsCents: 0,
      pendingExpensesCents: 0,
      ytdIncomeCents: 0,
      ytdExpenseCents: 0,
      lastActivityDate: ''
    };

    const isRestricted = ['temporarily_restricted', 'permanently_restricted'].includes(String(f.restrictionStatus));
    const isUnrestricted = ['unrestricted', 'board_designated', 'needs_treasurer_review'].includes(String(f.restrictionStatus));
    if (isRestricted) summary.totalRestrictedFundsCents += Number(b.currentBalanceCents || 0);
    if (isUnrestricted) summary.totalUnrestrictedFundsCents += Number(b.currentBalanceCents || 0);
    if (String(f.fundType).toLowerCase() === 'general operating') summary.generalOperatingBalanceCents += Number(b.currentBalanceCents || 0);
    if (['savings', 'emergency reserve'].includes(String(f.fundType).toLowerCase())) {
      summary.savingsAndReservesCents += Number(b.currentBalanceCents || 0);
    }
    if (isRestricted) summary.undepositedRestrictedContributionsCents += Number(b.pendingDepositsCents || 0);
    if (Number(f.minimumBalanceWarningCents || 0) > 0 && Number(b.availableBalanceCents || 0) <= Number(f.minimumBalanceWarningCents || 0)) {
      summary.lowBalanceFundIds.push(String(f.id));
    }
    if (Number(f.budgetAmountCents || 0) > 0 && Number(b.ytdExpenseCents || 0) > Number(f.budgetAmountCents || 0)) {
      summary.overspendingFundIds.push(String(f.id));
    }

    return {
      ...f,
      ...b,
      remainingBudgetCents: Number(f.budgetAmountCents || 0) - Number(b.ytdExpenseCents || 0)
    };
  });

  summary.transactionsRequiringFundAssignment = (Array.isArray(finance.entries) ? finance.entries : [])
    .filter((e) => !String(e?.fundId || '').trim() && !String(e?.fund || '').trim()).length;

  const warnings = [
    'This expense would use money from a restricted fund.',
    'The selected fund does not have enough available money.',
    'This contribution is restricted to the Building Fund.',
    'General operating money cannot be substituted without authorization.'
  ];

  res.json({ summary, funds: rows, warnings });
});

app.post('/api/finances/funds', requirePermission(PERMISSIONS.FINANCE_FUNDS_MANAGE), (req, res) => {
  const user = sessionUser(req);
  const data = loadFundsData();
  const fund = normalizeFundRecord(req.body || {}, user);
  if (!fund.fundName) return res.status(400).json({ error: 'Fund name is required.' });
  if (data.funds.some((f) => String(f.fundName).toLowerCase() === fund.fundName.toLowerCase())) {
    return res.status(409).json({ error: 'A fund with that name already exists.' });
  }
  if (fund.fundCode && data.funds.some((f) => String(f.fundCode || '').toLowerCase() === fund.fundCode.toLowerCase())) {
    return res.status(409).json({ error: 'A fund with that code already exists.' });
  }
  data.funds.push(fund);
  saveFundsData(data);
  audit('fund_created', {
    ...auditMetaFromRequest(req),
    recordType: 'fund',
    recordId: fund.id,
    newValues: fund
  });
  res.json({ ok: true, fund });
});

app.put('/api/finances/funds/:id', requirePermission(PERMISSIONS.FINANCE_FUNDS_MANAGE), (req, res) => {
  const user = sessionUser(req);
  const id = String(req.params.id);
  const data = loadFundsData();
  const idx = data.funds.findIndex((f) => String(f.id) === id);
  if (idx < 0) return res.status(404).json({ error: 'Fund not found.' });

  const prev = data.funds[idx];
  const next = normalizeFundRecord({ ...prev, ...(req.body || {}), id: prev.id, createdAt: prev.createdAt, createdBy: prev.createdBy }, user);
  data.funds[idx] = next;
  saveFundsData(data);
  audit('fund_edited', {
    ...auditMetaFromRequest(req),
    recordType: 'fund',
    recordId: next.id,
    previousValues: prev,
    newValues: next,
    reason: String(req.body?.reason || '').trim().slice(0, 400)
  });
  res.json({ ok: true, fund: next });
});

app.post('/api/finances/funds/:id/archive', requirePermission(PERMISSIONS.FINANCE_FUNDS_MANAGE), (req, res) => {
  const id = String(req.params.id);
  const data = loadFundsData();
  const fund = data.funds.find((f) => String(f.id) === id);
  if (!fund) return res.status(404).json({ error: 'Fund not found.' });

  const finance = loadFinances();
  const entries = Array.isArray(finance.entries) ? finance.entries : [];
  const pendingDeposits = entries.some((e) => String(e?.fundId || '') === id && String(e?.type || '') === 'income' && String(e?.status || 'posted') === 'pending');
  const pendingExpenses = entries.some((e) => String(e?.fundId || '') === id && String(e?.type || '') === 'expense' && String(e?.status || 'posted') === 'pending');
  const hasRecurring = entries.some((e) => String(e?.fundId || '') === id && e?.isRecurring === true);
  const hasGivingLink = fund.publicGivingAvailable === true;
  const { balances } = getFundBalances();
  const bal = balances.get(id);
  const nonZero = Math.abs(Number(bal?.currentBalanceCents || 0)) > 0;
  if (nonZero || pendingDeposits || pendingExpenses || hasRecurring || hasGivingLink) {
    return res.status(400).json({
      error: 'This fund cannot be archived yet.',
      resolution: {
        nonZeroBalance: nonZero,
        pendingDeposits,
        pendingExpenses,
        recurringTransactions: hasRecurring,
        activeGivingLinks: hasGivingLink,
        message: 'Resolve nonzero balances, pending items, recurring entries, and active giving links before archiving.'
      }
    });
  }

  const prev = { ...fund };
  fund.active = false;
  fund.archivedAt = new Date().toISOString();
  fund.updatedAt = new Date().toISOString();
  fund.updatedBy = sessionUser(req)?.id || '';
  saveFundsData(data);
  audit('fund_archived', {
    ...auditMetaFromRequest(req),
    recordType: 'fund',
    recordId: fund.id,
    previousValues: prev,
    newValues: fund
  });
  res.json({ ok: true, fund });
});

app.post('/api/finances/funds/:id/reactivate', requirePermission(PERMISSIONS.FINANCE_FUNDS_MANAGE), (req, res) => {
  const id = String(req.params.id);
  const data = loadFundsData();
  const fund = data.funds.find((f) => String(f.id) === id);
  if (!fund) return res.status(404).json({ error: 'Fund not found.' });
  const prev = { ...fund };
  fund.active = true;
  fund.archivedAt = '';
  fund.updatedAt = new Date().toISOString();
  fund.updatedBy = sessionUser(req)?.id || '';
  saveFundsData(data);
  audit('fund_reactivated', {
    ...auditMetaFromRequest(req),
    recordType: 'fund',
    recordId: fund.id,
    previousValues: prev,
    newValues: fund
  });
  res.json({ ok: true, fund });
});

app.get('/api/finances/funds/:id/activity', requirePermission(PERMISSIONS.FINANCE_READ), (req, res) => {
  const id = String(req.params.id);
  const finance = loadFinances();
  const fundData = loadFundsData();
  const entries = (finance.entries || []).filter((e) => String(e?.fundId || '') === id);
  const transfers = (fundData.transfers || []).filter((t) => String(t?.fromFundId || '') === id || String(t?.toFundId || '') === id);
  const releases = (fundData.releases || []).filter((r) => String(r?.fundId || '') === id);
  res.json({ entries, transfers, releases });
});

app.post('/api/finances/funds/transfers', requirePermission(PERMISSIONS.FINANCE_WRITE), (req, res) => {
  const user = sessionUser(req);
  const fromFundId = String(req.body?.fromFundId || '').trim();
  const toFundId = String(req.body?.toFundId || '').trim();
  const amountCents = parseMoneyCents(req.body?.amountCents ?? req.body?.amount);
  const reason = String(req.body?.reason || '').trim().slice(0, 400);
  if (!fromFundId || !toFundId || fromFundId === toFundId) return res.status(400).json({ error: 'Choose two different funds for this transfer.' });
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'Enter a transfer amount greater than 0.' });

  const data = loadFundsData();
  const fromFund = findFundByAnyKey(data.funds, fromFundId);
  const toFund = findFundByAnyKey(data.funds, toFundId);
  if (!fromFund || !toFund) return res.status(400).json({ error: 'One or both selected funds were not found.' });

  const { balances } = getFundBalances();
  const fromBalance = balances.get(String(fromFund.id));
  if (Number(fromBalance?.availableBalanceCents || 0) < amountCents) {
    return res.status(400).json({ error: 'The selected fund does not have enough available money.' });
  }

  const touchesRestricted = ['temporarily_restricted', 'permanently_restricted'].includes(String(fromFund.restrictionStatus))
    || ['temporarily_restricted', 'permanently_restricted'].includes(String(toFund.restrictionStatus));

  const transfer = {
    id: newId(),
    fromFundId: String(fromFund.id),
    toFundId: String(toFund.id),
    amountCents,
    reason,
    requestedBy: user?.id || '',
    requestedAt: new Date().toISOString(),
    status: touchesRestricted ? 'pending_approval' : 'approved',
    approvedBy: '',
    approvedAt: ''
  };

  if (touchesRestricted && !hasRole(user, [ROLE.ADMINISTRATOR, ROLE.TREASURER])) {
    transfer.status = 'pending_approval';
  }
  if (!touchesRestricted && hasRole(user, [ROLE.ADMINISTRATOR, ROLE.TREASURER])) {
    transfer.approvedBy = user.id;
    transfer.approvedAt = new Date().toISOString();
  }

  data.transfers.unshift(transfer);
  saveFundsData(data);
  audit('fund_transfer_created', {
    ...auditMetaFromRequest(req),
    recordType: 'fund_transfer',
    recordId: transfer.id,
    newValues: transfer
  });

  if (touchesRestricted) {
    return res.json({
      ok: true,
      transfer,
      warning: 'General operating money cannot be substituted without authorization.'
    });
  }
  return res.json({ ok: true, transfer });
});

app.post('/api/finances/funds/transfers/:id/approve', requirePermission(PERMISSIONS.FINANCE_FUNDS_MANAGE), (req, res) => {
  const user = sessionUser(req);
  if (!hasRole(user, [ROLE.ADMINISTRATOR, ROLE.TREASURER])) {
    return res.status(403).json({ error: 'Only an Administrator or Treasurer can approve this transfer.' });
  }
  const id = String(req.params.id);
  const data = loadFundsData();
  const t = data.transfers.find((x) => String(x.id) === id);
  if (!t) return res.status(404).json({ error: 'Transfer not found.' });
  if (String(t.requestedBy || '') === String(user?.id || '')) {
    return res.status(400).json({ error: 'A user cannot approve their own transfer override.' });
  }
  if (String(t.status) === 'approved') return res.json({ ok: true, transfer: t });
  t.status = 'approved';
  t.approvedBy = user?.id || '';
  t.approvedAt = new Date().toISOString();
  saveFundsData(data);
  audit('fund_transfer_approved', {
    ...auditMetaFromRequest(req),
    recordType: 'fund_transfer',
    recordId: t.id,
    newValues: { status: t.status, approvedBy: t.approvedBy, approvedAt: t.approvedAt }
  });
  res.json({ ok: true, transfer: t });
});

app.post('/api/finances/funds/releases', requirePermission(PERMISSIONS.FINANCE_FUNDS_MANAGE), (req, res) => {
  const fundId = String(req.body?.fundId || '').trim();
  const amountCents = parseMoneyCents(req.body?.amountCents ?? req.body?.amount);
  const reason = String(req.body?.reason || '').trim().slice(0, 400);
  if (!fundId) return res.status(400).json({ error: 'Fund is required for release from restriction.' });
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'Release amount must be greater than 0.' });

  const data = loadFundsData();
  const fund = findFundByAnyKey(data.funds, fundId);
  if (!fund) return res.status(404).json({ error: 'Fund not found.' });
  if (!['temporarily_restricted', 'permanently_restricted'].includes(String(fund.restrictionStatus))) {
    return res.status(400).json({ error: 'Only restricted funds can be released from restriction.' });
  }

  const release = {
    id: newId(),
    fundId: String(fund.id),
    amountCents,
    reason,
    requestedBy: sessionUser(req)?.id || '',
    requestedAt: new Date().toISOString(),
    status: 'pending_approval',
    approvedBy: '',
    approvedAt: ''
  };
  data.releases.unshift(release);
  saveFundsData(data);
  audit('fund_release_requested', {
    ...auditMetaFromRequest(req),
    recordType: 'fund_release',
    recordId: release.id,
    newValues: release
  });
  res.json({ ok: true, release });
});

app.post('/api/finances/funds/releases/:id/approve', requirePermission(PERMISSIONS.FINANCE_FUNDS_MANAGE), (req, res) => {
  const user = sessionUser(req);
  if (!hasRole(user, [ROLE.ADMINISTRATOR, ROLE.TREASURER])) {
    return res.status(403).json({ error: 'Only an Administrator or Treasurer can approve releases from restriction.' });
  }
  const id = String(req.params.id);
  const data = loadFundsData();
  const rel = data.releases.find((r) => String(r.id) === id);
  if (!rel) return res.status(404).json({ error: 'Release request not found.' });
  if (String(rel.requestedBy || '') === String(user?.id || '')) {
    return res.status(400).json({ error: 'A user cannot approve their own release request.' });
  }
  rel.status = 'approved';
  rel.approvedBy = user?.id || '';
  rel.approvedAt = new Date().toISOString();
  saveFundsData(data);
  audit('fund_release_approved', {
    ...auditMetaFromRequest(req),
    recordType: 'fund_release',
    recordId: rel.id,
    newValues: { status: rel.status, approvedBy: rel.approvedBy, approvedAt: rel.approvedAt }
  });
  res.json({ ok: true, release: rel });
});

app.get('/api/finances/donors', requirePermission(PERMISSIONS.DONOR_READ), (req, res) => {
  const data = loadDonorsData();
  const q = String(req.query.q || '').trim().toLowerCase();
  const household = String(req.query.household || '').trim().toLowerCase();
  const envelope = String(req.query.envelope || '').trim().toLowerCase();
  const active = String(req.query.active || '').trim().toLowerCase();
  const statement = String(req.query.statementDelivery || '').trim().toLowerCase();

  let donors = data.donors || [];
  if (q) {
    donors = donors.filter((d) => {
      const hay = [
        donorDisplayName(d),
        d.email,
        d.phone,
        d.mailingAddress,
        d.envelopeNumber
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  if (household) donors = donors.filter((d) => String(d.householdId || '').toLowerCase().includes(household));
  if (envelope) donors = donors.filter((d) => String(d.envelopeNumber || '').toLowerCase().includes(envelope));
  if (active === 'active') donors = donors.filter((d) => d.active !== false);
  if (active === 'inactive') donors = donors.filter((d) => d.active === false);
  if (statement) donors = donors.filter((d) => String(d.preferredStatementDelivery || '').toLowerCase() === statement);

  const possibleDuplicates = donors
    .flatMap((d) => findPossibleDonorDuplicates(data.donors, d).map((x) => ({ donorId: d.id, duplicateId: x.id })))
    .slice(0, 40);

  const missingAddressCount = donors.filter((d) => !String(d.mailingAddress || '').trim()).length;
  res.json({
    donors,
    totalDonors: donors.length,
    missingAddressCount,
    possibleDuplicates
  });
});

app.post('/api/finances/donors', requirePermission(PERMISSIONS.DONOR_WRITE), (req, res) => {
  const data = loadDonorsData();
  const user = sessionUser(req);
  const donor = normalizeDonor(req.body || {}, user);
  if (!donor.firstName || !donor.lastName) return res.status(400).json({ error: 'First and last name are required.' });
  const duplicates = findPossibleDonorDuplicates(data.donors, donor);
  if (duplicates.length && req.body?.forceCreate !== true) {
    return res.status(409).json({
      error: 'Possible duplicate donor found. Review before creating a new profile.',
      duplicates: duplicates.map((d) => ({ id: d.id, name: donorDisplayName(d), email: d.email, phone: d.phone }))
    });
  }
  data.donors.push(donor);
  saveDonorsData(data);
  audit('donor_created', {
    ...auditMetaFromRequest(req),
    recordType: 'donor',
    recordId: donor.id,
    newValues: donor
  });
  res.json({ ok: true, donor });
});

app.put('/api/finances/donors/:id', requirePermission(PERMISSIONS.DONOR_WRITE), (req, res) => {
  const id = String(req.params.id);
  const data = loadDonorsData();
  const idx = data.donors.findIndex((d) => String(d.id) === id);
  if (idx < 0) return res.status(404).json({ error: 'Donor not found.' });
  const user = sessionUser(req);
  const prev = data.donors[idx];

  // Finance entry can update basic contact details but not sensitive statement controls.
  const safePatch = { ...(req.body || {}) };
  if (hasRole(user, ROLE.FINANCE_ENTRY)) {
    delete safePatch.statementEligible;
    delete safePatch.taxReviewStatus;
    delete safePatch.restrictedNotes;
  }

  const next = normalizeDonor({ ...prev, ...safePatch, id: prev.id, createdAt: prev.createdAt, createdBy: prev.createdBy }, user);
  const duplicates = findPossibleDonorDuplicates(data.donors, next);
  if (duplicates.length && req.body?.forceSave !== true) {
    return res.status(409).json({
      error: 'Possible duplicate donor found. Review before saving.',
      duplicates: duplicates.map((d) => ({ id: d.id, name: donorDisplayName(d), email: d.email, phone: d.phone }))
    });
  }

  data.donors[idx] = next;
  saveDonorsData(data);

  const finance = loadFinances();
  if (syncEntryDonorSnapshots(finance.entries, data.donors)) {
    saveFinances(finance);
  }

  const statements = loadStatementsData();
  if (syncStatementDonorSnapshots(statements.statements, data.donors)) {
    saveStatementsData(statements);
  }

  audit('donor_edited', {
    ...auditMetaFromRequest(req),
    recordType: 'donor',
    recordId: next.id,
    previousValues: prev,
    newValues: next
  });
  res.json({ ok: true, donor: next });
});

app.post('/api/finances/donors/:id/deactivate', requirePermission(PERMISSIONS.DONOR_WRITE), (req, res) => {
  const id = String(req.params.id);
  const data = loadDonorsData();
  const donor = data.donors.find((d) => String(d.id) === id);
  if (!donor) return res.status(404).json({ error: 'Donor not found.' });
  donor.active = false;
  donor.updatedAt = new Date().toISOString();
  donor.updatedBy = sessionUser(req)?.id || '';
  saveDonorsData(data);
  audit('donor_deactivated', {
    ...auditMetaFromRequest(req),
    recordType: 'donor',
    recordId: donor.id
  });
  res.json({ ok: true, donor });
});

app.post('/api/finances/donors/:id/reactivate', requirePermission(PERMISSIONS.DONOR_WRITE), (req, res) => {
  const id = String(req.params.id);
  const data = loadDonorsData();
  const donor = data.donors.find((d) => String(d.id) === id);
  if (!donor) return res.status(404).json({ error: 'Donor not found.' });
  donor.active = true;
  donor.updatedAt = new Date().toISOString();
  donor.updatedBy = sessionUser(req)?.id || '';
  saveDonorsData(data);
  audit('donor_reactivated', {
    ...auditMetaFromRequest(req),
    recordType: 'donor',
    recordId: donor.id
  });
  res.json({ ok: true, donor });
});

app.post('/api/finances/donors/merge', requirePermission(PERMISSIONS.DONOR_MERGE), (req, res) => {
  const user = sessionUser(req);
  if (!hasRole(user, [ROLE.ADMINISTRATOR, ROLE.TREASURER])) {
    return res.status(403).json({ error: 'Only an Administrator or Treasurer can merge donors.' });
  }

  const primaryId = String(req.body?.primaryId || '').trim();
  const duplicateId = String(req.body?.duplicateId || '').trim();
  const reason = String(req.body?.reason || '').trim().slice(0, 400);
  if (!primaryId || !duplicateId || primaryId === duplicateId) return res.status(400).json({ error: 'Select a valid primary and duplicate donor.' });

  const donorsData = loadDonorsData();
  const donors = donorsData.donors || [];
  const primary = donors.find((d) => String(d.id) === primaryId);
  const duplicate = donors.find((d) => String(d.id) === duplicateId);
  if (!primary || !duplicate) return res.status(404).json({ error: 'One or both donor profiles were not found.' });

  const finance = loadFinances();
  for (const e of (finance.entries || [])) {
    if (String(e?.donorId || '') === duplicateId) {
      e.donorId = primaryId;
      e.donorName = donorDisplayName(primary);
      e.updatedAt = new Date().toISOString();
    }
  }
  syncEntryDonorSnapshots(finance.entries, donors);
  saveFinances(finance);

  const statementsData = loadStatementsData();
  for (const stmt of (statementsData.statements || [])) {
    if (String(stmt?.donorId || '') === duplicateId) {
      stmt.donorId = primaryId;
      stmt.donorName = donorDisplayName(primary);
      stmt.donorMailingAddress = String(primary?.mailingAddress || '');
    }
  }
  syncStatementDonorSnapshots(statementsData.statements, donors);
  saveStatementsData(statementsData);

  const mergeEvent = {
    id: newId(),
    at: new Date().toISOString(),
    primaryId,
    duplicateId,
    reason,
    by: user?.id || ''
  };
  donorsData.merges.unshift(mergeEvent);
  donorsData.donors = donors.filter((d) => String(d.id) !== duplicateId);
  saveDonorsData(donorsData);
  audit('donor_merged', {
    ...auditMetaFromRequest(req),
    recordType: 'donor_merge',
    recordId: mergeEvent.id,
    previousValues: { primary, duplicate },
    newValues: { primaryId, duplicateArchived: true },
    reason
  });

  res.json({ ok: true, mergeEvent });
});

app.get('/api/finances/donors/:id/history', requirePermission(PERMISSIONS.DONOR_READ), (req, res) => {
  const id = String(req.params.id);
  const year = String(req.query.year || '').trim();
  const from = normalizeDateOnly(req.query.from);
  const to = normalizeDateOnly(req.query.to);
  const donorsData = loadDonorsData();
  const donor = donorsData.donors.find((d) => String(d.id) === id);
  if (!donor) return res.status(404).json({ error: 'Donor not found.' });

  const entries = (loadFinances().entries || []).filter((e) => String(e?.donorId || '') === id && String(e?.type || '') === 'income');
  const filtered = entries.filter((e) => {
    const d = normalizeDateOnly(e.date);
    if (year && !d.startsWith(`${year}-`)) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });

  const totals = {
    selectedPeriodCents: 0,
    deductibleCents: 0,
    nondeductibleCents: 0,
    pendingReviewCount: 0,
    byFund: {}
  };
  for (const e of filtered) {
    const amount = Math.abs(Number(e.amountCents || 0));
    totals.selectedPeriodCents += amount;
    const status = String(e.statementReviewStatus || 'needs_review');
    if (status === 'nondeductible') totals.nondeductibleCents += amount;
    else if (status === 'needs_review') totals.pendingReviewCount += 1;
    else totals.deductibleCents += amount;
    const fund = String(e.fund || 'Unassigned');
    totals.byFund[fund] = Number(totals.byFund[fund] || 0) + amount;
  }
  res.json({ donor: { id: donor.id, name: donorDisplayName(donor) }, entries: filtered, totals });
});

app.get('/api/finances/statements', requirePermission(PERMISSIONS.DONOR_READ), (req, res) => {
  res.json(loadStatementsData());
});

app.put('/api/finances/statements/templates', requirePermission(PERMISSIONS.STATEMENTS_MANAGE), (req, res) => {
  const data = loadStatementsData();
  data.templates = {
    ...data.templates,
    ...(req.body?.templates || {})
  };
  saveStatementsData(data);
  audit('statement_templates_updated', {
    ...auditMetaFromRequest(req),
    recordType: 'statement_template',
    recordId: 'default',
    newValues: data.templates
  });
  res.json({ ok: true, templates: data.templates });
});

app.post('/api/finances/statements/generate', requirePermission(PERMISSIONS.STATEMENTS_MANAGE), (req, res) => {
  const donorsData = loadDonorsData();
  const statementsData = loadStatementsData();
  syncStatementDonorSnapshots(statementsData.statements, donorsData.donors);
  const period = normalizeFinanceStatementPeriod(req.body?.from, req.body?.to);
  if (!period) return res.status(400).json({ error: 'Select a valid statement period.' });

  const donorIds = Array.isArray(req.body?.donorIds)
    ? req.body.donorIds.map((id) => {
      const donor = findDonorByAnyKey(donorsData.donors, id);
      return donor ? String(donor.id) : '';
    }).filter(Boolean)
    : donorsData.donors.map((d) => String(d.id));
  const entries = loadFinances().entries || [];
  const created = [];

  for (const donorId of donorIds) {
    const donor = donorsData.donors.find((d) => String(d.id) === donorId);
    if (!donor || donor.statementEligible === false) continue;
    const lines = entries.filter((e) => {
      if (String(e?.type || '') !== 'income') return false;
      if (String(e?.donorId || '') !== donorId) return false;
      const d = normalizeDateOnly(e.date);
      return d >= period.from && d <= period.to;
    });
    if (!lines.length) continue;

    let deductibleTotalCents = 0;
    let nondeductibleTotalCents = 0;
    for (const line of lines) {
      const amount = Math.abs(Number(line.amountCents || 0));
      if (String(line.statementReviewStatus || 'needs_review') === 'nondeductible') nondeductibleTotalCents += amount;
      else deductibleTotalCents += amount;
    }

    const statement = {
      id: newId(),
      statementIdentifier: `STM-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      donorId,
      donorName: donorDisplayName(donor),
      donorMailingAddress: donor.mailingAddress,
      period,
      lines,
      deductibleTotalCents,
      nondeductibleTotalCents,
      status: 'generated',
      issuedAt: '',
      generatedAt: new Date().toISOString(),
      generatedBy: sessionUser(req)?.id || '',
      correctionStatus: 'original'
    };
    created.push(statement);
    statementsData.statements.unshift(statement);
  }

  saveStatementsData(statementsData);
  audit('statement_generated', {
    ...auditMetaFromRequest(req),
    recordType: 'statement_batch',
    recordId: newId(),
    newValues: {
      generatedCount: created.length,
      from: period.from,
      to: period.to
    }
  });
  res.json({ ok: true, generated: created.length, statements: created });
});

app.post('/api/finances/statements/:id/approve', requirePermission(PERMISSIONS.STATEMENTS_APPROVE), (req, res) => {
  const id = String(req.params.id);
  const data = loadStatementsData();
  const stmt = data.statements.find((s) => String(s.id) === id);
  if (!stmt) return res.status(404).json({ error: 'Statement not found.' });
  stmt.status = 'approved';
  stmt.issuedAt = new Date().toISOString();
  stmt.approvedBy = sessionUser(req)?.id || '';
  saveStatementsData(data);
  audit('statement_approved', {
    ...auditMetaFromRequest(req),
    recordType: 'statement',
    recordId: stmt.id,
    newValues: { status: stmt.status, issuedAt: stmt.issuedAt }
  });
  res.json({ ok: true, statement: stmt });
});

app.post('/api/finances/statements/:id/deliver', requirePermission(PERMISSIONS.STATEMENTS_MANAGE), (req, res) => {
  const id = String(req.params.id);
  const method = String(req.body?.method || '').trim().toLowerCase();
  if (!['mail', 'email', 'pickup', 'other'].includes(method)) {
    return res.status(400).json({ error: 'Delivery method must be mail, email, pickup, or other.' });
  }
  const data = loadStatementsData();
  const stmt = data.statements.find((s) => String(s.id) === id);
  if (!stmt) return res.status(404).json({ error: 'Statement not found.' });
  const delivery = {
    id: newId(),
    statementId: stmt.id,
    method,
    deliveredAt: new Date().toISOString(),
    deliveredBy: sessionUser(req)?.id || ''
  };
  data.deliveries.unshift(delivery);
  stmt.status = 'delivered';
  saveStatementsData(data);
  audit('statement_delivered', {
    ...auditMetaFromRequest(req),
    recordType: 'statement_delivery',
    recordId: delivery.id,
    newValues: delivery
  });
  res.json({ ok: true, delivery, statement: stmt });
});

app.post('/api/finances/reports/board/generate', requirePermission(PERMISSIONS.BOARD_REPORTS_MANAGE), (req, res) => {
  const reportDate = normalizeDateOnly(req.body?.reportDate) || normalizeDateOnly(new Date().toISOString());
  const priorDate = normalizeDateOnly(req.body?.priorDate);
  const liabilitiesCents = parseMoneyCents(req.body?.liabilitiesCents ?? 0);

  const { fundsData, balances } = getFundBalances();
  const rows = (fundsData.funds || []).map((f) => {
    const b = balances.get(String(f.id));
    return {
      fundId: f.id,
      fundName: f.fundName,
      restrictionStatus: f.restrictionStatus,
      currentBalanceCents: Number(b?.currentBalanceCents || 0)
    };
  });

  const assetsCents = rows.reduce((sum, r) => sum + Number(r.currentBalanceCents || 0), 0);
  const netWithoutRestrictionCents = rows
    .filter((r) => ['unrestricted', 'board_designated', 'needs_treasurer_review'].includes(String(r.restrictionStatus)))
    .reduce((sum, r) => sum + Number(r.currentBalanceCents || 0), 0);
  const netWithRestrictionCents = rows
    .filter((r) => ['temporarily_restricted', 'permanently_restricted'].includes(String(r.restrictionStatus)))
    .reduce((sum, r) => sum + Number(r.currentBalanceCents || 0), 0);

  const netAssetsCents = netWithoutRestrictionCents + netWithRestrictionCents;
  const balanceCheck = assetsCents === (Number.isFinite(liabilitiesCents) ? liabilitiesCents : 0) + netAssetsCents;
  if (!balanceCheck) {
    return res.status(400).json({
      error: 'Cannot publish this report because the accounting equation is out of balance. Assets must equal Liabilities plus Net Assets.'
    });
  }

  const financeEntries = loadFinances().entries || [];
  const monthKey = reportDate.slice(0, 7);
  const thisYear = reportDate.slice(0, 4);

  const activities = {
    currentMonthRevenueCents: 0,
    currentMonthExpenseCents: 0,
    ytdRevenueCents: 0,
    ytdExpenseCents: 0
  };
  for (const e of financeEntries) {
    const d = normalizeDateOnly(e.date);
    const amount = Math.abs(Number(e.amountCents || 0));
    if (!amount) continue;
    const type = String(e.type || '').toLowerCase();
    if (d.startsWith(monthKey)) {
      if (type === 'income') activities.currentMonthRevenueCents += amount;
      if (type === 'expense') activities.currentMonthExpenseCents += amount;
    }
    if (d.startsWith(`${thisYear}-`)) {
      if (type === 'income') activities.ytdRevenueCents += amount;
      if (type === 'expense') activities.ytdExpenseCents += amount;
    }
  }

  const packageRecord = {
    id: newId(),
    generatedAt: new Date().toISOString(),
    generatedBy: sessionUser(req)?.id || '',
    reportDate,
    priorDate,
    statementOfFinancialPosition: {
      assetsCents,
      liabilitiesCents: Number.isFinite(liabilitiesCents) ? liabilitiesCents : 0,
      netWithoutRestrictionCents,
      netWithRestrictionCents,
      netAssetsCents,
      funds: rows
    },
    statementOfActivities: {
      ...activities,
      totalChangeInNetAssetsCents: activities.ytdRevenueCents - activities.ytdExpenseCents
    },
    boardNotes: String(req.body?.boardNotes || '').trim().slice(0, 5000)
  };
  const file = path.join(DATA_DIR, 'board_report_packages.json');
  const existing = readJson(file, { packages: [] });
  const packages = Array.isArray(existing?.packages) ? existing.packages : [];
  packages.unshift(packageRecord);
  writeJsonAtomic(file, { packages });
  audit('board_report_generated', {
    ...auditMetaFromRequest(req),
    recordType: 'board_report_package',
    recordId: packageRecord.id,
    newValues: {
      reportDate,
      priorDate,
      packageId: packageRecord.id
    }
  });
  res.json({ ok: true, package: packageRecord });
});

app.get('/api/finances/controls/dashboard', requirePermission(PERMISSIONS.CONTROLS_VERIFY), (req, res) => {
  const data = loadControlsData();
  const collections = data.collections || [];
  const dashboard = {
    awaitingSecondVerification: collections.filter((c) => c.verificationStatus === 'awaiting_second_counter').length,
    enteredByOnlyCounter: collections.filter((c) => c.enteredBy && c.counters?.length === 1 && String(c.counters[0]) === String(c.enteredBy)).length,
    modifiedAfterVerification: collections.filter((c) => c.modifiedAfterVerification === true).length,
    undepositedCollections: collections.filter((c) => c.depositedAt ? false : true).length,
    depositsAwaitingVerification: collections.filter((c) => c.depositedAt && c.depositVerifiedAt ? false : true).length,
    overridesAndExceptions: (data.exceptions || []).length,
    recentVoidsAndReversals: collections.filter((c) => c.status === 'voided' || c.status === 'reversed').slice(0, 20)
  };
  res.json({ dashboard, collections, exceptions: data.exceptions || [] });
});

app.post('/api/finances/controls/collections', requirePermission(PERMISSIONS.FINANCE_WRITE), (req, res) => {
  const user = sessionUser(req);
  const data = loadControlsData();
  const amountCents = parseMoneyCents(req.body?.amountCents ?? req.body?.amount);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'Collection amount must be greater than 0.' });

  const counters = Array.isArray(req.body?.counters) ? req.body.counters.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (data.twoPersonVerificationEnabled && counters.length < 2) {
    return res.status(400).json({ error: 'A second counter must verify this collection.' });
  }
  if (!counters.length) return res.status(400).json({ error: 'At least one counter is required.' });
  if (counters.length === 1 && String(counters[0]) === String(user?.id || '')) {
    return res.status(400).json({ error: 'The person entering this collection cannot be its only verifier.' });
  }

  const collection = {
    id: newId(),
    serviceDate: normalizeDateOnly(req.body?.serviceDate) || normalizeDateOnly(new Date().toISOString()),
    amountCents,
    counters,
    enteredBy: user?.id || '',
    enteredAt: new Date().toISOString(),
    verificationStatus: data.twoPersonVerificationEnabled ? 'awaiting_second_counter' : 'verified',
    verificationHistory: [],
    depositId: String(req.body?.depositId || '').trim(),
    depositedAt: '',
    depositVerifiedAt: '',
    modifiedAfterVerification: false,
    status: 'draft',
    attachment: String(req.body?.attachment || '').trim().slice(0, 400)
  };
  data.collections.unshift(collection);
  saveControlsData(data);
  audit('collection_created', {
    ...auditMetaFromRequest(req),
    recordType: 'collection',
    recordId: collection.id,
    newValues: collection
  });
  res.json({ ok: true, collection });
});

app.post('/api/finances/controls/collections/:id/verify', requirePermission(PERMISSIONS.CONTROLS_VERIFY), (req, res) => {
  const user = sessionUser(req);
  const id = String(req.params.id);
  const data = loadControlsData();
  const collection = data.collections.find((c) => String(c.id) === id);
  if (!collection) return res.status(404).json({ error: 'Collection not found.' });
  if (String(collection.enteredBy || '') === String(user?.id || '') && (collection.counters || []).length <= 1) {
    return res.status(400).json({ error: 'The person entering this collection cannot be its only verifier.' });
  }
  const verifier = String(req.body?.verifierId || user?.id || '').trim();
  if (!verifier) return res.status(400).json({ error: 'Verifier is required.' });

  collection.verificationHistory = Array.isArray(collection.verificationHistory) ? collection.verificationHistory : [];
  collection.verificationHistory.push({ verifier, at: new Date().toISOString(), amountCents: collection.amountCents });
  const uniqueVerifiers = Array.from(new Set(collection.verificationHistory.map((v) => String(v.verifier || ''))));

  if (data.twoPersonVerificationEnabled && uniqueVerifiers.length < 2) {
    collection.verificationStatus = 'awaiting_second_counter';
    saveControlsData(data);
    return res.json({ ok: true, collection, warning: 'A second counter must verify this collection.' });
  }

  collection.verificationStatus = 'verified';
  collection.verifiedAt = new Date().toISOString();
  saveControlsData(data);
  audit('collection_verified', {
    ...auditMetaFromRequest(req),
    recordType: 'collection',
    recordId: collection.id,
    newValues: {
      verificationStatus: collection.verificationStatus,
      verificationCount: uniqueVerifiers.length
    }
  });
  res.json({ ok: true, collection });
});

app.post('/api/finances/controls/collections/:id/post', requirePermission(PERMISSIONS.FINANCE_WRITE), (req, res) => {
  const id = String(req.params.id);
  const data = loadControlsData();
  const collection = data.collections.find((c) => String(c.id) === id);
  if (!collection) return res.status(404).json({ error: 'Collection not found.' });
  if (String(collection.verificationStatus) !== 'verified') {
    return res.status(400).json({ error: 'Final posting is blocked until required verification is complete.' });
  }
  collection.status = 'posted';
  collection.postedAt = new Date().toISOString();
  saveControlsData(data);
  audit('collection_posted', {
    ...auditMetaFromRequest(req),
    recordType: 'collection',
    recordId: collection.id,
    newValues: { status: 'posted' }
  });
  res.json({ ok: true, collection });
});

app.post('/api/finances/controls/exceptions', requirePermission(PERMISSIONS.CONTROLS_APPROVE_EXCEPTION), (req, res) => {
  const user = sessionUser(req);
  const requestorId = String(req.body?.requestorId || '').trim();
  const approverId = String(req.body?.approverId || user?.id || '').trim();
  if (!requestorId) return res.status(400).json({ error: 'Exception requestor is required.' });
  if (!approverId) return res.status(400).json({ error: 'Authorized approver is required.' });
  if (requestorId === approverId) return res.status(400).json({ error: 'The same user cannot request and approve an exception.' });

  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  if (!reason) return res.status(400).json({ error: 'Exception reason is required.' });
  const note = String(req.body?.note || '').trim().slice(0, 3000);

  const data = loadControlsData();
  const ex = {
    id: newId(),
    requestorId,
    approverId,
    reason,
    note,
    createdAt: new Date().toISOString()
  };
  data.exceptions.unshift(ex);
  saveControlsData(data);
  audit('internal_control_exception_recorded', {
    ...auditMetaFromRequest(req),
    recordType: 'internal_control_exception',
    recordId: ex.id,
    newValues: ex
  });
  res.json({ ok: true, exception: ex });
});

app.get('/api/finances/clergy-housing', requirePermission(PERMISSIONS.HOUSING_MANAGE), (req, res) => {
  res.json(loadHousingData());
});

app.post('/api/finances/clergy-housing/profiles', requirePermission(PERMISSIONS.HOUSING_MANAGE), (req, res) => {
  const data = loadHousingData();
  const user = sessionUser(req);
  const now = new Date().toISOString();
  const p = {
    id: newId(),
    ministerName: String(req.body?.ministerName || '').trim().slice(0, 120),
    positionTitle: String(req.body?.positionTitle || '').trim().slice(0, 120),
    ordinationStatus: String(req.body?.ordinationStatus || '').trim().slice(0, 40),
    employmentStartDate: normalizeDateOnly(req.body?.employmentStartDate),
    employmentEndDate: normalizeDateOnly(req.body?.employmentEndDate),
    compensationYear: String(req.body?.compensationYear || '').trim().slice(0, 4),
    totalCompensationCents: parseMoneyCents(req.body?.totalCompensationCents ?? req.body?.totalCompensation),
    salaryAmountCents: parseMoneyCents(req.body?.salaryAmountCents ?? req.body?.salaryAmount),
    housingAllowanceDesignatedCents: parseMoneyCents(req.body?.housingAllowanceDesignatedCents ?? req.body?.housingAllowanceDesignatedAmount),
    designationEffectiveDate: normalizeDateOnly(req.body?.designationEffectiveDate),
    dateApproved: normalizeDateOnly(req.body?.dateApproved),
    approvingBody: String(req.body?.approvingBody || '').trim().slice(0, 160),
    resolutionReference: String(req.body?.resolutionReference || '').trim().slice(0, 160),
    resolutionAttachment: String(req.body?.resolutionAttachment || '').trim().slice(0, 400),
    paymentFrequency: String(req.body?.paymentFrequency || '').trim().slice(0, 60),
    parsonageProvided: req.body?.parsonageProvided === true,
    utilitiesAllowanceCents: parseMoneyCents(req.body?.utilitiesAllowanceCents ?? req.body?.utilitiesAllowance),
    notes: String(req.body?.notes || '').trim().slice(0, 3000),
    status: String(req.body?.status || 'active').trim().toLowerCase().slice(0, 40),
    createdBy: user?.id || '',
    lastUpdatedBy: user?.id || '',
    createdAt: now,
    updatedAt: now
  };
  if (!p.ministerName) return res.status(400).json({ error: 'Minister name is required.' });

  const warnings = [];
  if (!p.resolutionAttachment) warnings.push('No resolution is attached.');
  if (p.dateApproved && p.designationEffectiveDate && p.dateApproved > p.designationEffectiveDate) {
    warnings.push('Approval date is after the effective payment date.');
  }
  if (Number.isFinite(p.totalCompensationCents) && Number.isFinite(p.housingAllowanceDesignatedCents)
    && p.housingAllowanceDesignatedCents > p.totalCompensationCents) {
    warnings.push('The allowance exceeds configured compensation.');
  }

  data.profiles.unshift(p);
  saveHousingData(data);
  audit('housing_allowance_created', {
    ...auditMetaFromRequest(req),
    recordType: 'housing_profile',
    recordId: p.id,
    newValues: p
  });
  res.json({ ok: true, profile: p, warnings });
});

app.put('/api/finances/clergy-housing/profiles/:id', requirePermission(PERMISSIONS.HOUSING_MANAGE), (req, res) => {
  const data = loadHousingData();
  const user = sessionUser(req);
  const id = String(req.params.id);
  const profile = data.profiles.find((x) => String(x.id) === id);
  if (!profile) return res.status(404).json({ error: 'Housing profile not found.' });
  const prev = { ...profile };

  const incomingEffectiveDate = normalizeDateOnly(req.body?.designationEffectiveDate || profile.designationEffectiveDate);
  const incomingApprovedDate = normalizeDateOnly(req.body?.dateApproved || profile.dateApproved);
  const backdated = req.body?.designationEffectiveDate && incomingEffectiveDate < normalizeDateOnly(new Date().toISOString());
  if (backdated && !String(req.body?.backdatedReason || '').trim()) {
    return res.status(400).json({ error: 'Backdated changes require a reason.' });
  }

  Object.assign(profile, {
    ministerName: String(req.body?.ministerName ?? profile.ministerName).trim().slice(0, 120),
    positionTitle: String(req.body?.positionTitle ?? profile.positionTitle).trim().slice(0, 120),
    ordinationStatus: String(req.body?.ordinationStatus ?? profile.ordinationStatus).trim().slice(0, 40),
    employmentStartDate: normalizeDateOnly(req.body?.employmentStartDate ?? profile.employmentStartDate),
    employmentEndDate: normalizeDateOnly(req.body?.employmentEndDate ?? profile.employmentEndDate),
    compensationYear: String(req.body?.compensationYear ?? profile.compensationYear).trim().slice(0, 4),
    totalCompensationCents: parseMoneyCents(req.body?.totalCompensationCents ?? req.body?.totalCompensation ?? profile.totalCompensationCents),
    salaryAmountCents: parseMoneyCents(req.body?.salaryAmountCents ?? req.body?.salaryAmount ?? profile.salaryAmountCents),
    housingAllowanceDesignatedCents: parseMoneyCents(req.body?.housingAllowanceDesignatedCents ?? req.body?.housingAllowanceDesignatedAmount ?? profile.housingAllowanceDesignatedCents),
    designationEffectiveDate: incomingEffectiveDate,
    dateApproved: incomingApprovedDate,
    approvingBody: String(req.body?.approvingBody ?? profile.approvingBody).trim().slice(0, 160),
    resolutionReference: String(req.body?.resolutionReference ?? profile.resolutionReference).trim().slice(0, 160),
    resolutionAttachment: String(req.body?.resolutionAttachment ?? profile.resolutionAttachment).trim().slice(0, 400),
    paymentFrequency: String(req.body?.paymentFrequency ?? profile.paymentFrequency).trim().slice(0, 60),
    parsonageProvided: req.body?.parsonageProvided === undefined ? profile.parsonageProvided : req.body.parsonageProvided === true,
    utilitiesAllowanceCents: parseMoneyCents(req.body?.utilitiesAllowanceCents ?? req.body?.utilitiesAllowance ?? profile.utilitiesAllowanceCents),
    notes: String(req.body?.notes ?? profile.notes).trim().slice(0, 3000),
    status: String(req.body?.status ?? profile.status).trim().toLowerCase().slice(0, 40),
    lastUpdatedBy: user?.id || '',
    updatedAt: new Date().toISOString()
  });
  saveHousingData(data);
  audit('housing_allowance_edited', {
    ...auditMetaFromRequest(req),
    recordType: 'housing_profile',
    recordId: profile.id,
    previousValues: prev,
    newValues: profile,
    reason: String(req.body?.backdatedReason || req.body?.reason || '').trim().slice(0, 400)
  });
  res.json({ ok: true, profile });
});

app.post('/api/finances/clergy-housing/annual-records', requirePermission(PERMISSIONS.HOUSING_MANAGE), (req, res) => {
  const data = loadHousingData();
  const profileId = String(req.body?.profileId || '').trim();
  if (!profileId) return res.status(400).json({ error: 'Housing profile is required.' });
  const profile = data.profiles.find((p) => String(p.id) === profileId);
  if (!profile) return res.status(404).json({ error: 'Housing profile not found.' });

  const record = {
    id: newId(),
    profileId,
    compensationYear: String(req.body?.compensationYear || profile.compensationYear || '').trim().slice(0, 4),
    designatedAmountCents: parseMoneyCents(req.body?.designatedAmountCents ?? req.body?.designatedAmount),
    amountPaidCents: parseMoneyCents(req.body?.amountPaidCents ?? req.body?.amountPaid),
    actualHousingExpensesCents: parseMoneyCents(req.body?.actualHousingExpensesCents ?? req.body?.actualHousingExpenses),
    fairRentalValueCents: parseMoneyCents(req.body?.fairRentalValueCents ?? req.body?.fairRentalValue),
    utilitiesCents: parseMoneyCents(req.body?.utilitiesCents ?? req.body?.utilities),
    parsonageValueCents: parseMoneyCents(req.body?.parsonageValueCents ?? req.body?.parsonageValue),
    accountantReviewStatus: String(req.body?.accountantReviewStatus || 'needs_review').trim().toLowerCase().slice(0, 60),
    supportingDocuments: Array.isArray(req.body?.supportingDocuments) ? req.body.supportingDocuments.slice(0, 50) : [],
    notes: String(req.body?.notes || '').trim().slice(0, 3000),
    createdAt: new Date().toISOString(),
    createdBy: sessionUser(req)?.id || ''
  };
  const comparisonBase = [record.designatedAmountCents, record.actualHousingExpensesCents, record.fairRentalValueCents + record.utilitiesCents]
    .filter((v) => Number.isFinite(v) && v >= 0);
  record.recordkeepingComparisonCents = comparisonBase.length ? Math.min(...comparisonBase) : 0;
  record.recordkeepingNotice = 'Recordkeeping comparison — final tax treatment must be reviewed by the minister and a qualified tax professional.';

  data.annualRecords.unshift(record);
  saveHousingData(data);
  audit('housing_allowance_annual_record_created', {
    ...auditMetaFromRequest(req),
    recordType: 'housing_annual_record',
    recordId: record.id,
    newValues: record
  });
  res.json({ ok: true, record });
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
    social: { subscribers: [] },
    theme: { accent: '#c46123', text: '#ffffff', background: '#000000', logoPath: '' }
  });
}
function saveSettings(data) {
  writeJsonAtomic(SETTINGS_DATA_PATH, data);
}

function normalizeSubscribers(list) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) {
    const email = String(raw?.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({
      email,
      name: String(raw?.name || '').trim().slice(0, 120),
      group: String(raw?.group || 'general').trim().slice(0, 80) || 'general'
    });
  }
  return out;
}

function loadSubscribers() {
  const settings = loadSettings();
  return normalizeSubscribers(settings?.social?.subscribers || []);
}

function saveSubscribers(subscribers) {
  const current = loadSettings();
  const next = {
    social: {
      ...(current.social || {}),
      subscribers: normalizeSubscribers(subscribers)
    },
    theme: {
      ...(current.theme || {})
    }
  };
  saveSettings(next);
  if (ENABLE_EXPORTS) writeJsonAtomic(path.join(ROOT_DIR, 'site-settings.json'), next.social);
  return next.social.subscribers;
}

function normalizeNewsletterRecipients(list) {
  return Array.from(new Set(
    (Array.isArray(list) ? list : [])
      .map((e) => String(e || '').trim().toLowerCase())
      .filter(isValidEmail)
  ));
}

function normalizeNewsletterRecord(raw, statusFallback) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const status = String(src.status || statusFallback || 'draft').trim().toLowerCase();
  return {
    id: String(src.id || newId()).trim() || newId(),
    subject: String(src.subject || '').trim().slice(0, 140),
    message: String(src.message || '').trim().slice(0, 12000),
    emails: normalizeNewsletterRecipients(src.emails),
    scheduleDate: String(src.scheduleDate || '').trim().slice(0, 10),
    scheduleTime: String(src.scheduleTime || '').trim().slice(0, 5),
    scheduleTimezone: String(src.scheduleTimezone || 'America/Chicago').trim().slice(0, 64) || 'America/Chicago',
    scheduleAt: toIsoOrEmpty(src.scheduleAt),
    status: ['draft', 'scheduled', 'retrying', 'sent', 'failed', 'deleted', 'skipped'].includes(status) ? status : 'draft',
    retryCount: Math.max(0, Number(src.retryCount || 0) || 0),
    createdAt: toIsoOrEmpty(src.createdAt) || new Date().toISOString(),
    updatedAt: toIsoOrEmpty(src.updatedAt) || new Date().toISOString(),
    sentAt: toIsoOrEmpty(src.sentAt),
    sentCount: Math.max(0, Number(src.sentCount || 0) || 0),
    error: String(src.error || '').trim().slice(0, 500)
  };
}

function normalizeNewsletterRecordsData(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const drafts = (Array.isArray(src.drafts) ? src.drafts : []).map((r) => normalizeNewsletterRecord(r, 'draft'));
  const scheduled = (Array.isArray(src.scheduled) ? src.scheduled : []).map((r) => normalizeNewsletterRecord(r, 'scheduled'));
  const history = (Array.isArray(src.history) ? src.history : []).map((r) => normalizeNewsletterRecord(r, 'sent')).slice(0, 200);
  return { drafts, scheduled, history };
}

function loadNewsletterRecords() {
  const data = readJson(NEWSLETTER_RECORDS_DATA_PATH, { drafts: [], scheduled: [], history: [] });
  return normalizeNewsletterRecordsData(data);
}

function saveNewsletterRecords(data) {
  const normalized = normalizeNewsletterRecordsData(data);
  writeJsonAtomic(NEWSLETTER_RECORDS_DATA_PATH, normalized);
  return normalized;
}

function timeZoneOffsetMinutes(timeZone, instantMs) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
      hour: '2-digit'
    }).formatToParts(new Date(instantMs));
    const tzName = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT+0';
    const match = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
    if (!match) return 0;
    const sign = match[1] === '-' ? -1 : 1;
    const hh = Number(match[2] || 0);
    const mm = Number(match[3] || 0);
    return sign * ((hh * 60) + mm);
  } catch {
    return 0;
  }
}

function zonedDateTimeToUtcIso(dateValue, timeValue, timeZone) {
  const d = String(dateValue || '').trim();
  const t = String(timeValue || '').trim();
  const z = String(timeZone || '').trim() || 'America/Chicago';
  const dm = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = t.match(/^(\d{2}):(\d{2})$/);
  if (!dm || !tm) return '';
  const y = Number(dm[1]);
  const mo = Number(dm[2]);
  const day = Number(dm[3]);
  const hh = Number(tm[1]);
  const mm = Number(tm[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(day) || !Number.isFinite(hh) || !Number.isFinite(mm)) return '';
  if (mo < 1 || mo > 12 || day < 1 || day > 31 || hh < 0 || hh > 23 || mm < 0 || mm > 59) return '';

  let utcMs = Date.UTC(y, mo - 1, day, hh, mm, 0, 0);
  for (let i = 0; i < 3; i += 1) {
    const offsetMin = timeZoneOffsetMinutes(z, utcMs);
    utcMs = Date.UTC(y, mo - 1, day, hh, mm, 0, 0) - (offsetMin * 60 * 1000);
  }
  const iso = new Date(utcMs).toISOString();
  return Number.isNaN(Date.parse(iso)) ? '' : iso;
}

async function sendNewsletterEmail({ subject, message, emails }) {
  if (envBool('SUPPORT_DISABLE_SEND', false) || process.env.NODE_ENV === 'test') {
    return { ok: true, disabled: true, sent: 0 };
  }

  const fromEmail = String(process.env.SUPPORT_FROM_EMAIL || 'no-reply@mmmbc.com').trim();
  const fromName = String(process.env.SUPPORT_FROM_NAME || 'MMMBC Newsletter').trim() || 'MMMBC Newsletter';
  const template = buildNewsletterEmailTemplate({ subject, message });

  const payload = {
    personalizations: [{ to: emails.map((email) => ({ email })), subject }],
    from: { email: fromEmail, name: fromName },
    content: [
      { type: 'text/plain', value: template.text },
      { type: 'text/html', value: template.html }
    ]
  };
  const out = await mailchannelsSend(payload);
  if (out.status < 200 || out.status >= 300) {
    logger.error('newsletter_email_failed', { status: out.status, body: String(out.body || '').slice(0, 2000) });
    return { ok: false, error: `Newsletter send failed (${out.status}).`, sent: 0 };
  }
  return { ok: true, disabled: false, sent: emails.length };
}

function validateNewsletterRecipients(emails) {
  const normalized = normalizeNewsletterRecipients(emails);
  const allowed = new Set(loadSubscribers().map((s) => s.email));
  const invalid = normalized.filter((e) => !allowed.has(e));
  if (invalid.length) {
    const err = new Error('Some selected recipients are not in subscribers.');
    err.statusCode = 400;
    throw err;
  }
  return normalized;
}

async function processScheduledNewsletters() {
  const records = loadNewsletterRecords();
  const nowMs = Date.now();
  const keepScheduled = [];
  let changed = false;

  for (const rec of records.scheduled) {
    const scheduleMs = Date.parse(rec.scheduleAt || '');
    const dueMs = Number.isNaN(scheduleMs) ? Number.MAX_SAFE_INTEGER : scheduleMs;
    if (dueMs > nowMs) {
      keepScheduled.push(rec);
      continue;
    }

    changed = true;
    try {
      const result = await sendNewsletterEmail({
        subject: rec.subject,
        message: rec.message,
        emails: validateNewsletterRecipients(rec.emails)
      });
      records.history.unshift(normalizeNewsletterRecord({
        ...rec,
        status: result.disabled ? 'skipped' : 'sent',
        sentAt: new Date().toISOString(),
        sentCount: Number(result.sent || 0),
        retryCount: rec.retryCount || 0,
        error: ''
      }, 'sent'));
    } catch (err) {
      const retryCount = Number(rec.retryCount || 0) + 1;
      if (retryCount < 3) {
        keepScheduled.push(normalizeNewsletterRecord({
          ...rec,
          status: 'retrying',
          retryCount,
          scheduleAt: new Date(Date.now() + (5 * 60 * 1000)).toISOString(),
          updatedAt: new Date().toISOString(),
          error: String(err?.message || 'Send failed').slice(0, 500)
        }, 'retrying'));
      } else {
        records.history.unshift(normalizeNewsletterRecord({
          ...rec,
          status: 'failed',
          retryCount,
          sentAt: new Date().toISOString(),
          error: String(err?.message || 'Send failed').slice(0, 500)
        }, 'failed'));
      }
    }
  }

  if (changed) {
    records.scheduled = keepScheduled;
    saveNewsletterRecords(records);
  }
  return records;
}

let newsletterSchedulerStarted = false;
function startNewsletterScheduler() {
  if (newsletterSchedulerStarted) return;
  if (process.env.NODE_ENV === 'test') return;
  newsletterSchedulerStarted = true;
  const timer = setInterval(() => {
    processScheduledNewsletters().catch((err) => {
      logger.error('newsletter_scheduler_error', { err });
    });
  }, 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

function stripTags(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntityLite(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractProfilesFromPage(filePath, pageKey) {
  if (!fs.existsSync(filePath)) return [];
  const html = fs.readFileSync(filePath, 'utf8');
  const out = [];
  const blockRe = /<div class="leadership-profile">([\s\S]*?)<\/div>\s*<\/div>/gi;
  let m;
  while ((m = blockRe.exec(html))) {
    const whole = m[0] || '';
    const before = html.slice(0, m.index);
    const headingMatches = Array.from(before.matchAll(/<h2(?:\s+id="([^"]+)")?[^>]*>([\s\S]*?)<\/h2>/gi));
    const lastHeading = headingMatches.length ? headingMatches[headingMatches.length - 1] : null;
    const section = lastHeading
      ? (stripTags(decodeEntityLite(lastHeading[2] || '')).slice(0, 80) || pageKey)
      : pageKey;

    const imgMatch = whole.match(/<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"[^>]*>/i)
      || whole.match(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]+)"[^>]*>/i);
    const titleMatch = whole.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const strongMatch = whole.match(/<p[^>]*>\s*<strong>([\s\S]*?)<\/strong>\s*<\/p>/i);
    const paraMatches = Array.from(whole.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi));
    const bioSource = paraMatches.find((p) => !/<strong>/i.test(String(p[1] || '')))?.[1] || '';

    const src = imgMatch
      ? String(imgMatch[1] || imgMatch[2] || '').trim()
      : '';
    const alt = imgMatch
      ? String(imgMatch[2] || imgMatch[1] || '').trim()
      : '';

    out.push({
      id: `${pageKey}-${out.length + 1}`,
      page: pageKey,
      section,
      image: src,
      name: stripTags(decodeEntityLite(titleMatch?.[1] || '')).slice(0, 120),
      title: stripTags(decodeEntityLite(strongMatch?.[1] || '')).slice(0, 120),
      bio: stripTags(decodeEntityLite(bioSource)).slice(0, 700),
      alt: stripTags(decodeEntityLite(alt)).slice(0, 120)
    });
  }
  return out;
}

function normalizeProfiles(list) {
  const out = [];
  const source = Array.isArray(list) ? list : [];
  for (const raw of source) {
    const page = String(raw?.page || '').trim().toLowerCase();
    if (!['ministries', 'leadership'].includes(page)) continue;
    out.push({
      id: String(raw?.id || newId()).trim() || newId(),
      page,
      section: String(raw?.section || page).trim().slice(0, 80),
      image: String(raw?.image || '').trim().slice(0, 400),
      name: String(raw?.name || '').trim().slice(0, 120),
      title: String(raw?.title || '').trim().slice(0, 120),
      bio: String(raw?.bio || '').trim().slice(0, 700),
      alt: String(raw?.alt || raw?.name || '').trim().slice(0, 120)
    });
  }
  return out;
}

function normalizeProfilePageMeta(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const ministries = src.ministries && typeof src.ministries === 'object' ? src.ministries : {};
  const leadership = src.leadership && typeof src.leadership === 'object' ? src.leadership : {};
  const nav = src.nav && typeof src.nav === 'object' ? src.nav : {};

  return {
    ministries: {
      pageTitle: String(ministries.pageTitle || 'Ministries').trim().slice(0, 120),
      introText: String(ministries.introText || 'Learn more about the ministries and leaders who serve the Mt. Moriah Missionary Baptist Church family.').trim().slice(0, 700)
    },
    leadership: {
      pageTitle: String(leadership.pageTitle || 'Leadership & Staff').trim().slice(0, 120),
      staffHeading: String(leadership.staffHeading || 'Staff').trim().slice(0, 80),
      deaconsHeading: String(leadership.deaconsHeading || 'Deacons').trim().slice(0, 80),
      deaconessesHeading: String(leadership.deaconessesHeading || 'Deaconesses').trim().slice(0, 80),
      officialTeamHeading: String(leadership.officialTeamHeading || 'Official Team & Trustees').trim().slice(0, 120)
    },
    nav: {
      ministriesLabel: String(nav.ministriesLabel || 'Ministries').trim().slice(0, 80),
      leadershipLabel: String(nav.leadershipLabel || 'Leadership & Staff').trim().slice(0, 80)
    }
  };
}

function seedProfilesFromPages() {
  const ministriesPath = path.join(ROOT_DIR, 'Pages', 'ministries.html');
  const leadershipPath = path.join(ROOT_DIR, 'Pages', 'leadership.html');
  const seeded = [
    ...extractProfilesFromPage(ministriesPath, 'ministries'),
    ...extractProfilesFromPage(leadershipPath, 'leadership')
  ];
  return normalizeProfiles(seeded);
}

function loadProfiles() {
  const data = readJson(PROFILES_DATA_PATH, { profiles: [], pageMeta: {} });
  const current = normalizeProfiles(data?.profiles || []);
  const pageMeta = normalizeProfilePageMeta(data?.pageMeta);
  if (current.length) return { profiles: current, pageMeta };

  const seeded = seedProfilesFromPages();
  if (seeded.length) {
    writeJsonAtomic(PROFILES_DATA_PATH, { profiles: seeded, pageMeta });
  }
  return { profiles: seeded, pageMeta };
}

function saveProfiles(profiles, pageMeta) {
  const existing = readJson(PROFILES_DATA_PATH, { profiles: [], pageMeta: {} });
  const normalized = normalizeProfiles(profiles);
  const normalizedMeta = normalizeProfilePageMeta(pageMeta === undefined ? existing?.pageMeta : pageMeta);
  const payload = { profiles: normalized, pageMeta: normalizedMeta };
  writeJsonAtomic(PROFILES_DATA_PATH, payload);
  if (ENABLE_EXPORTS) writeJsonAtomic(path.join(ROOT_DIR, 'profiles.json'), payload);
  return payload;
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

app.get('/api/subscribers', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), (req, res) => {
  res.json({ subscribers: loadSubscribers() });
});

app.put('/api/subscribers', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), (req, res) => {
  const list = Array.isArray(req.body?.subscribers) ? req.body.subscribers : [];
  const subscribers = saveSubscribers(list);
  res.json({ ok: true, subscribers });
});

app.get('/api/newsletter/records', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), async (req, res) => {
  const records = await processScheduledNewsletters();
  res.json(records);
});

app.post('/api/newsletter/records', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), async (req, res) => {
  const action = String(req.body?.action || '').trim().toLowerCase();
  const now = new Date().toISOString();
  const records = await processScheduledNewsletters();

  if (action === 'delete') {
    const id = String(req.body?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Record id is required.' });
    records.drafts = records.drafts.filter((r) => String(r.id) !== id);
    records.scheduled = records.scheduled.filter((r) => String(r.id) !== id);
    records.history = records.history.filter((r) => String(r.id) !== id);
    const saved = saveNewsletterRecords(records);
    return res.json({ ok: true, ...saved });
  }

  const subject = String(req.body?.subject || '').trim().slice(0, 140);
  const message = String(req.body?.message || '').trim().slice(0, 12000);
  if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required.' });

  let emails = [];
  try {
    emails = validateNewsletterRecipients(req.body?.emails || []);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message || 'Invalid recipients.' });
  }
  if (!emails.length) return res.status(400).json({ error: 'Select at least one recipient.' });

  if (action === 'save_draft') {
    const record = normalizeNewsletterRecord({
      id: newId(),
      subject,
      message,
      emails,
      status: 'draft',
      createdAt: now,
      updatedAt: now
    }, 'draft');
    records.drafts.unshift(record);
    const saved = saveNewsletterRecords(records);
    return res.json({ ok: true, ...saved });
  }

  if (action === 'schedule') {
    const scheduleDate = String(req.body?.scheduleDate || '').trim();
    const scheduleTime = String(req.body?.scheduleTime || '').trim();
    const scheduleTimezone = String(req.body?.scheduleTimezone || 'America/Chicago').trim() || 'America/Chicago';
    const scheduleAt = zonedDateTimeToUtcIso(scheduleDate, scheduleTime, scheduleTimezone);
    if (!scheduleAt) {
      return res.status(400).json({ error: 'Schedule date, time, and time zone are required.' });
    }
    if (Date.parse(scheduleAt) <= Date.now()) {
      return res.status(400).json({ error: 'Scheduled time must be in the future.' });
    }
    const record = normalizeNewsletterRecord({
      id: newId(),
      subject,
      message,
      emails,
      status: 'scheduled',
      scheduleDate,
      scheduleTime,
      scheduleTimezone,
      scheduleAt,
      retryCount: 0,
      createdAt: now,
      updatedAt: now
    }, 'scheduled');
    records.scheduled.unshift(record);
    const saved = saveNewsletterRecords(records);
    return res.json({ ok: true, ...saved });
  }

  return res.status(400).json({ error: 'Unsupported newsletter action.' });
});

app.post('/api/newsletter/test', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), async (req, res) => {
  const subject = String(req.body?.subject || '').trim().slice(0, 140);
  const message = String(req.body?.message || '').trim().slice(0, 12000);
  if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required.' });

  const requestedRaw = Array.isArray(req.body?.emails)
    ? req.body.emails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const invalid = requestedRaw.filter((email) => !isValidEmail(email));
  if (invalid.length) return res.status(400).json({ error: `Invalid recipient email: ${invalid[0]}` });

  const requested = normalizeNewsletterRecipients(requestedRaw);
  let recipients = requested;

  if (!recipients.length) {
    const user = sessionUser(req);
    const fallbackEmail = String(user?.email || '').trim().toLowerCase();
    if (!isValidEmail(fallbackEmail)) return res.status(400).json({ error: 'Signed-in user email is invalid.' });
    recipients = [fallbackEmail];
  }

  try {
    const out = await sendNewsletterEmail({ subject, message, emails: recipients });
    return res.json({ ok: true, recipients, ...out });
  } catch (err) {
    logger.error('newsletter_test_send_error', { err });
    return res.status(502).json({ error: 'Test email failed.' });
  }
});

app.post('/api/newsletter/send', requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE), async (req, res) => {
  const subject = String(req.body?.subject || '').trim().slice(0, 140);
  const message = String(req.body?.message || '').trim().slice(0, 12000);
  let emails = [];
  try {
    emails = validateNewsletterRecipients(req.body?.emails || []);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message || 'Invalid recipients.' });
  }

  if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required.' });
  if (!emails.length) return res.status(400).json({ error: 'Select at least one recipient.' });

  try {
    const out = await sendNewsletterEmail({ subject, message, emails });
    const records = loadNewsletterRecords();
    records.history.unshift(normalizeNewsletterRecord({
      id: newId(),
      subject,
      message,
      emails,
      status: out.disabled ? 'skipped' : 'sent',
      sentAt: new Date().toISOString(),
      sentCount: Number(out.sent || 0),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, out.disabled ? 'skipped' : 'sent'));
    saveNewsletterRecords(records);
    res.json({ ok: true, sent: Number(out.sent || 0), disabled: !!out.disabled });
  } catch (err) {
    logger.error('newsletter_email_error', { err });
    res.status(502).json({ error: 'Newsletter send failed.' });
  }
});

app.get('/api/profiles', requirePermission(PERMISSIONS.WEBSITE_WRITE), (req, res) => {
  res.json(loadProfiles());
});

app.put('/api/profiles', requirePermission(PERMISSIONS.WEBSITE_WRITE), (req, res) => {
  const list = Array.isArray(req.body?.profiles) ? req.body.profiles : [];
  const pageMeta = req.body?.pageMeta;
  const data = saveProfiles(list, pageMeta);
  res.json({ ok: true, ...data });
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

    const profiles = loadProfiles();
    writeJsonAtomic(path.join(ROOT_DIR, 'profiles.json'), profiles);

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
  ensureDir(WEBPAGE_IMAGES_DIR);

  if (!fs.existsSync(PROFILES_DATA_PATH)) {
    const seeded = seedProfilesFromPages();
    const payload = { profiles: seeded, pageMeta: normalizeProfilePageMeta({}) };
    writeJsonAtomic(PROFILES_DATA_PATH, payload);
    if (ENABLE_EXPORTS) writeJsonAtomic(path.join(ROOT_DIR, 'profiles.json'), payload);
  }

  if (!fs.existsSync(NEWSLETTER_RECORDS_DATA_PATH)) {
    writeJsonAtomic(NEWSLETTER_RECORDS_DATA_PATH, { drafts: [], scheduled: [], history: [] });
  }

  startNewsletterScheduler();

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
