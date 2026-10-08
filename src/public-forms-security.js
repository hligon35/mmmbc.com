// Shared hardening for anonymous public form endpoints.

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function clientIp(request) {
  return String(request.headers.get('CF-Connecting-IP') || '').trim() || 'unknown';
}

// Rejects if the honeypot field (expected to stay empty, hidden from real users via CSS)
// was filled in, which almost always indicates an automated submission.
export function honeypotTripped(body, fieldName = 'website') {
  return Boolean(String(body?.[fieldName] || '').trim());
}

export async function verifyTurnstile(env, token, remoteIp) {
  const secret = String(env.TURNSTILE_SECRET_KEY || '').trim();
  const production = String(env.ENVIRONMENT || '').toLowerCase() === 'production';
  if (production && (!secret || !String(env.TURNSTILE_SITE_KEY || '').trim())) {
    return { ok: false, error: 'Form verification is temporarily unavailable.', status: 503 };
  }
  if (!secret) {
    return { ok: true, skipped: true };
  }
  if (!token) return { ok: false, error: 'Please complete the verification challenge.' };

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (remoteIp && remoteIp !== 'unknown') form.append('remoteip', remoteIp);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form
    });
    const data = await res.json().catch(() => ({}));
    if (!data?.success) {
      const codes = Array.isArray(data?.['error-codes'])
        ? data['error-codes'].filter((code) => typeof code === 'string').slice(0, 5)
        : [];
      // Cloudflare error codes are safe to log; never log the token, secret, or visitor IP.
      console.warn('Turnstile siteverify failed', { status: res.status, codes });
      if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
        return { ok: false, error: 'Form verification is temporarily unavailable.', status: 503 };
      }
      if (codes.includes('timeout-or-duplicate')) {
        return { ok: false, error: 'Verification expired or was already used. Please complete it again.', status: 403 };
      }
      return { ok: false, error: 'Verification failed. Please try again.', status: 403 };
    }
    if (production && env.PUBLIC_SITE_URL) {
      const hostname = new URL(env.PUBLIC_SITE_URL).hostname.toLowerCase();
      const tokenHostname = String(data.hostname || '').toLowerCase();
      // The same Worker serves several explicitly configured origins. Never allow arbitrary hosts.
      const allowedHosts = new Set([hostname, `www.${hostname}`,
        ...String(env.TURNSTILE_ALLOWED_HOSTNAMES || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean)]);
      if (!allowedHosts.has(tokenHostname)) {
        console.warn('Turnstile hostname mismatch');
        return { ok: false, error: 'Verification failed. Please try again.', status: 403 };
      }
    }
    return { ok: true };
  } catch {
    // Fail closed on network errors so a Turnstile outage cannot be used to bypass it,
    // but only once a secret is actually configured (see the empty-secret skip above).
    return { ok: false, error: 'Unable to verify request right now. Please try again.' };
  }
}

// Allows at most `max` submissions per `formType`+IP within `windowSeconds`.
// Uses SITE_DB.form_rate_limits; if SITE_DB isn't bound yet, rate limiting is skipped.
export async function checkRateLimit(env, request, formType, { max = 5, windowSeconds = 600 } = {}) {
  const db = env.SITE_DB;
  if (!db) return { ok: true, skipped: true };

  const ip = clientIp(request);
  const rateKey = await sha256Hex(`${formType}:${ip}`);
  const now = Date.now();
  const windowStartIso = new Date(now - windowSeconds * 1000).toISOString();

  try {
    const { results } = await db.prepare(
      `SELECT COUNT(*) AS c FROM form_rate_limits WHERE rate_key = ? AND created_at >= ?`
    ).bind(rateKey, windowStartIso).all();
    const count = Number(results?.[0]?.c || 0);
    if (count >= max) {
      return { ok: false, error: 'Too many submissions. Please try again later.' };
    }
    await db.prepare(
      `INSERT INTO form_rate_limits (rate_key, created_at) VALUES (?, ?)`
    ).bind(rateKey, new Date(now).toISOString()).run();
    // Opportunistically prune old rows for this key so the table doesn't grow unbounded.
    await db.prepare(
      `DELETE FROM form_rate_limits WHERE rate_key = ? AND created_at < ?`
    ).bind(rateKey, windowStartIso).run();
    return { ok: true };
  } catch {
    // Never let rate-limit bookkeeping failures block a legitimate submission.
    return { ok: true, skipped: true };
  }
}
