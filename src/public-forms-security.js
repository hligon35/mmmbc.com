// Shared hardening for anonymous public form endpoints (contact, facility rental,
// newsletter subscribe): Turnstile verification, D1-backed rate limiting, and a
// honeypot check. All three are best-effort: if TURNSTILE_SECRET_KEY or SITE_DB is
// not configured yet, the corresponding check is skipped rather than blocking traffic,
// so this can be deployed before those pieces exist and tightened later.

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
  if (!secret) return { ok: true, skipped: true };
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
    if (!data?.success) return { ok: false, error: 'Verification failed. Please try again.' };
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
