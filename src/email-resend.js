// Centralized Resend client for transactional and batch application email.
//
// Requires:
//   - env.RESEND_API_KEY   (Worker secret, set via `wrangler secret put RESEND_API_KEY`)
//   - env.RESEND_FROM_EMAIL (var, e.g. "no-reply@mmmbc.com")
//   - env.RESEND_FROM_NAME  (var, e.g. "MMMBC Website")
//
// Never log or echo the API key. Never accept it from request bodies or query strings.

function normalizedResendError(rawBody) {
  const text = String(rawBody || '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    return String(parsed?.message || parsed?.error || '').trim() || text;
  } catch {
    return text;
  }
}

function formatFrom(fromEmail, fromName) {
  const email = String(fromEmail || '').trim();
  const name = String(fromName || '').trim();
  return name ? `${name} <${email}>` : email;
}

/**
 * Send a single email via the Resend API.
 * @returns {Promise<{ok: boolean, status: number, id?: string, error?: string}>}
 */
async function sendResendEmail(env, {
  to,
  subject,
  text = '',
  html = '',
  replyTo = '',
  fromEmail = '',
  fromName = '',
  idempotencyKey = ''
} = {}) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  if (!apiKey) return { ok: false, status: 0, error: 'RESEND_API_KEY is not configured.' };

  const from = String(fromEmail || env.RESEND_FROM_EMAIL || '').trim();
  if (!from) return { ok: false, status: 0, error: 'RESEND_FROM_EMAIL is not configured.' };
  const name = String(fromName || env.RESEND_FROM_NAME || '').trim();

  const recipients = (Array.isArray(to) ? to : [to]).map((r) => String(r || '').trim()).filter(Boolean);
  if (!recipients.length) return { ok: false, status: 0, error: 'No recipient email address provided.' };

  const payload = {
    from: formatFrom(from, name),
    to: recipients,
    subject: String(subject || '').trim().slice(0, 200) || '(no subject)'
  };
  if (text) payload.text = String(text);
  if (html) payload.html = String(html);
  if (!text && !html) payload.text = '';
  if (replyTo) payload.reply_to = replyTo;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 256) } : {})
      },
      body: JSON.stringify(payload)
    });
    const bodyText = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, status: res.status, error: normalizedResendError(bodyText).slice(0, 500) };
    let id = '';
    try { id = JSON.parse(bodyText)?.id || ''; } catch { /* ignore */ }
    return { ok: true, status: res.status, id };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e).slice(0, 500) };
  }
}

/**
 * Send the same subject/text/html to many recipients, one-per-email (recipients never see
 * each other's addresses), using Resend's batch endpoint (max 100 emails per API call).
 * @returns {Promise<{ok: boolean, sent: number, error?: string}>}
 */
async function sendResendBatch(env, {
  subject,
  text = '',
  html = '',
  fromEmail = '',
  fromName = '',
  recipients = [],
  idempotencyKey = ''
} = {}) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  if (!apiKey) return { ok: false, sent: 0, error: 'RESEND_API_KEY is not configured.' };

  const from = String(fromEmail || env.RESEND_FROM_EMAIL || '').trim();
  if (!from) return { ok: false, sent: 0, error: 'RESEND_FROM_EMAIL is not configured.' };
  const name = String(fromName || env.RESEND_FROM_NAME || '').trim();

  const list = (recipients || []).map((r) => String(r || '').trim()).filter(Boolean);
  const BATCH_SIZE = 100;
  let sent = 0;

  for (let i = 0; i < list.length; i += BATCH_SIZE) {
    const chunk = list.slice(i, i + BATCH_SIZE);
    const body = chunk.map((email) => ({
      from: formatFrom(from, name),
      to: [email],
      subject: String(subject || '').trim().slice(0, 200) || '(no subject)',
      text: String(text || ''),
      html: html ? String(html) : undefined
    }));

    try {
      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...(idempotencyKey ? { 'Idempotency-Key': `${String(idempotencyKey).slice(0, 240)}-${i / BATCH_SIZE}` } : {})
        },
        body: JSON.stringify(body)
      });
      const bodyText = await res.text().catch(() => '');
      if (!res.ok) {
        return { ok: false, sent, error: `Batch send failed (${res.status}): ${normalizedResendError(bodyText).slice(0, 400)}` };
      }
      sent += chunk.length;
    } catch (e) {
      return { ok: false, sent, error: String(e?.message || e).slice(0, 500) };
    }
  }

  return { ok: true, sent };
}

export { sendResendEmail, sendResendBatch, normalizedResendError };
