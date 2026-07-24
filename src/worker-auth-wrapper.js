import worker from './worker.js';

const SESSION_COOKIE = 'mmmbc_admin_session';
const SESSION_TTL_SECONDS = 60 * 60 * 12;

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

async function createSession(email, name, secret) {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({
    email,
    name: String(name || '').slice(0, 120),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  })));
  const signature = base64UrlEncode(await hmac(payload, secret));
  return `${payload}.${signature}`;
}

async function readSession(request, secret) {
  if (!secret) return null;
  const cookie = String(request.headers.get('Cookie') || '');
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const token = decodeURIComponent(match[1]);
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = await hmac(payload, secret);
  let supplied;
  try { supplied = base64UrlDecode(signature); } catch { return null; }
  if (expected.length !== supplied.length) return null;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) mismatch |= expected[i] ^ supplied[i];
  if (mismatch !== 0) return null;

  try {
    const data = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (!data?.email || Number(data.exp || 0) <= Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

function allowedEmails(env) {
  const raw = String(env.GOOGLE_ALLOWED_EMAILS || env.ADMIN_ALLOW_EMAILS || '');
  return new Set(raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
}

async function verifyGoogleCredential(idToken, clientId) {
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!response.ok) throw new Error('Invalid Google sign-in token.');
  const profile = await response.json();
  if (String(profile.aud || '') !== clientId) throw new Error('Google token audience is invalid.');
  if (String(profile.email_verified || '').toLowerCase() !== 'true') throw new Error('Google account email is not verified.');
  return profile;
}

function sessionCookie(value, request, maxAge = SESSION_TTL_SECONDS) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const LOGIN_STYLE = `
<style id="mmmbc-login-fixes">
  #authShell.loginShell {
    width: min(1080px, calc(100% - 32px));
    min-height: calc(100dvh - 28px);
    margin: 0 auto;
    display: grid;
    grid-template-columns: minmax(0, 42fr) minmax(0, 58fr);
    gap: clamp(32px, 5vw, 64px);
    align-items: center;
    justify-content: center;
  }
  #authShell .loginStage { min-width: 0; display: flex; align-items: center; }
  #authShell .loginCard { width: 100%; max-width: 560px; margin: 0; }
  #authShell .peekBtn { border: 0 !important; background: transparent !important; border-radius: 999px; }
  #authShell .peekBtn:hover { border: 0 !important; background: rgba(255,255,255,.08) !important; }
  #googleLoginPanel { width: 100%; }
  #googleSignInBtn { min-height: 44px; display: flex; align-items: center; }
  @media (max-width: 760px) {
    #authShell.loginShell { min-height: calc(100dvh - 20px); grid-template-columns: 1fr; gap: 18px; padding: 24px 0; }
    #authShell .loginBrand { min-height: auto; padding: 0 16px; }
    #authShell .loginBrand__logo { width: min(100%, 300px); max-height: 220px; }
    #authShell .loginStage { justify-content: center; }
  }
</style>`;

async function injectLoginStyle(response) {
  const type = String(response.headers.get('Content-Type') || '').toLowerCase();
  if (!type.includes('text/html')) return response;
  const html = await response.text();
  const next = html.includes('id="mmmbc-login-fixes"') ? html : html.replace('</head>', `${LOGIN_STYLE}\n</head>`);
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.set('Cache-Control', 'no-store');
  return new Response(next, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const clientId = String(env.GOOGLE_CLIENT_ID || '').trim();
    const sessionSecret = String(env.SESSION_SECRET || '').trim();

    if (url.pathname === '/api/auth/providers' && request.method === 'GET') {
      return json({ google: { enabled: Boolean(clientId), clientId } });
    }

    if (url.pathname === '/api/csrf' && request.method === 'GET') {
      return json({ csrfToken: crypto.randomUUID() });
    }

    if (url.pathname === '/api/auth/google' && request.method === 'POST') {
      if (!clientId) return json({ error: 'Google sign-in is not configured.' }, { status: 503 });
      if (!sessionSecret) return json({ error: 'Admin session security is not configured.' }, { status: 503 });
      const body = await request.json().catch(() => null);
      const idToken = String(body?.idToken || body?.credential || '').trim();
      if (!idToken) return json({ error: 'Missing Google ID token.' }, { status: 400 });
      try {
        const profile = await verifyGoogleCredential(idToken, clientId);
        const email = String(profile.email || '').trim().toLowerCase();
        const allow = allowedEmails(env);
        if (!email || !allow.has(email)) {
          return json({ error: 'This Google account is not approved for admin access.' }, { status: 403 });
        }
        const token = await createSession(email, profile.name || '', sessionSecret);
        return json({ ok: true }, { headers: { 'Set-Cookie': sessionCookie(token, request) } });
      } catch (error) {
        return json({ error: String(error?.message || 'Google sign-in failed.') }, { status: 401 });
      }
    }

    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      return json({ ok: true }, { headers: { 'Set-Cookie': sessionCookie('', request, 0) } });
    }

    const session = await readSession(request, sessionSecret);
    if (url.pathname === '/api/me' && request.method === 'GET') {
      if (!session) return json({ user: null });
      return json({ user: {
        id: session.email,
        email: session.email,
        name: session.name || '',
        role: 'administrator',
        isMaster: true,
        mustOnboard: false,
        twoFactorEnabled: false
      } });
    }

    let forwardedRequest = request;
    if (session && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin'))) {
      const headers = new Headers(request.headers);
      headers.set('cf-access-authenticated-user-email', session.email);
      forwardedRequest = new Request(request, { headers });
    }

    const response = await worker.fetch(forwardedRequest, env, ctx);
    if (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname.startsWith('/admin/')) {
      return injectLoginStyle(response);
    }
    return response;
  }
};
