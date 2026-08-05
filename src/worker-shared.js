import { EmailMessage } from 'cloudflare:email';

export async function readAssetJson(request, env, pathname, fallback) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return fallback;
  try {
    const url = new URL(request.url);
    url.pathname = pathname;
    url.search = '';
    const response = await env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }));
    if (!response.ok) return fallback;
    return await response.json();
  } catch {
    return fallback;
  }
}

export async function sendSupportEmailMessage(env, {
  subject,
  textBody,
  replyTo = '',
  fromNameOverride = ''
} = {}) {
  const toEmail = String(env.SUPPORT_TO_EMAIL || 'support@hldesignedit.com').trim();
  const deliveryToEmail = String(env.SUPPORT_EMAIL_DESTINATION || toEmail).trim();
  const fromEmail = String(env.SUPPORT_FROM_EMAIL || 'no-reply@mmmbc.com').trim();
  const fromName = String(fromNameOverride || env.SUPPORT_FROM_NAME || 'MMMBC Website').trim() || 'MMMBC Website';

  if (!env.SUPPORT_EMAIL || typeof env.SUPPORT_EMAIL.send !== 'function') {
    throw new Error('Email send is not configured. SUPPORT_EMAIL binding is missing.');
  }

  const escapeQuotes = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\"/g, '\\"');
  const fromHeaderName = fromName ? `"${escapeQuotes(fromName)}" ` : '';
  const fromHeader = `${fromHeaderName}<${fromEmail}>`;
  const replyToHeader = replyTo ? `Reply-To: ${replyTo}\r\n` : '';
  const safeSubject = String(subject || '').trim().slice(0, 180);
  const safeBody = String(textBody || '').trim().slice(0, 12000);
  const messageId = `<${crypto.randomUUID()}@mmmbc.local>`;

  const raw = [
    `To: ${toEmail}`,
    `From: ${fromHeader}`,
    replyToHeader.trimEnd(),
    `Subject: ${safeSubject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    safeBody
  ].filter(Boolean).join('\r\n');

  const msg = new EmailMessage(fromEmail, deliveryToEmail, raw);
  await env.SUPPORT_EMAIL.send(msg);
}