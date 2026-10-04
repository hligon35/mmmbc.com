// D1-backed admin users/invites, newsletter subscribers, and newsletter sending for the
// Cloudflare Worker. Emails are sent via the Resend API (see ./email-resend.js), using the
// RESEND_API_KEY Worker secret. Mirrors the feature set in admin/server.js (the local
// dev admin backend), but backed by D1 instead of JSON files.

import { sendResendEmail } from './email-resend.js';
import { eligibleRecipients, unsubscribeToken, zonedSchedule } from './newsletter-preferences.js';

function json(resBody, status = 200) {
  return new Response(JSON.stringify(resBody), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function escapeHtml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

// ---------------- Resend ----------------
// Thin adapters around ./email-resend.js that preserve the existing {status, body} shape
// used by the call sites below, so error-handling logic didn't need to change.

async function sendTransactionalEmail(env, { personalizations, from, content }) {
  const to = (personalizations?.[0]?.to || []).map((r) => r.email).filter(Boolean);
  const subject = personalizations?.[0]?.subject || '';
  const text = (content || []).find((c) => c.type === 'text/plain')?.value || '';
  const html = (content || []).find((c) => c.type === 'text/html')?.value || '';

  const out = await sendResendEmail(env, {
    to,
    subject,
    text,
    html,
    fromEmail: from?.email,
    fromName: from?.name
  });
  return { status: out.ok ? 200 : (out.status || 500), body: out.error || '' };
}

function normalizedEmailError(rawBody) {
  return String(rawBody || '').trim();
}

// ---------------- Admin users / invites ----------------

function staticAllowList(env) {
  const raw = String(env.ADMIN_ALLOW_EMAILS || '').trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function isEmailInvited(env, email) {
  if (!env.DB) return false;
  try {
    const row = await env.DB.prepare(
      `SELECT id FROM admin_invites WHERE email = ? AND status = 'invited' LIMIT 1`
    ).bind(String(email || '').toLowerCase()).first();
    return Boolean(row?.id);
  } catch {
    return false;
  }
}

function roleDisplayName(role) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'master_admin') return 'Master Admin';
  if (normalized === 'administrator') return 'Administrator';
  if (normalized === 'finance_officer') return 'Directory Manager';
  if (normalized === 'finance_entry') return 'Directory Assistant';
  if (normalized === 'treasurer') return 'Directory Manager';
  if (normalized === 'auditor') return 'Support Viewer';
  if (normalized === 'site_editor') return 'Site Editor';
  return 'Site Editor';
}

function buildAdminInviteEmailTemplate({ inviteUrl, role }) {
  const roleLabel = roleDisplayName(role);
  const safeRoleLabel = escapeHtml(roleLabel);
  const safeInviteUrl = escapeHtml(inviteUrl);
  let logoUrl = 'https://mmmbc.com/ConImg/MtMoriahLogo-1.png';
  try {
    const origin = new URL(inviteUrl).origin;
    logoUrl = `${origin}/ConImg/MtMoriahLogo-1.png`;
  } catch {
    // Keep fallback logo URL when inviteUrl cannot be parsed.
  }
  const safeLogoUrl = escapeHtml(logoUrl);
  return {
    text: [
      'Mt. Moriah Missionary Baptist Church Admin Access',
      `Role: ${roleLabel}`,
      '',
      'You have been granted admin access. Sign in through Cloudflare Access using this email address and the one-time PIN sent to it:',
      inviteUrl
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#1f2937;background:#f8fafc;padding:24px">
        <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:18px;overflow:hidden">
          <div style="padding:24px 28px;background:linear-gradient(135deg,#7a2f16,#c46123);color:#ffffff">
            <img src="${safeLogoUrl}" alt="Mt. Moriah Missionary Baptist Church" width="120" style="display:block;width:120px;max-width:42%;height:auto;margin:0 auto 10px;object-fit:contain" />
            <div style="font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;opacity:.92">Mt. Moriah MBC</div>
            <h1 style="margin:10px 0 0;font-size:28px;line-height:1.15">You've been granted Admin access</h1>
          </div>
          <div style="padding:24px 28px;color:#111827;font-size:16px">
            <p style="margin:0 0 10px"><strong>Role:</strong> ${safeRoleLabel}</p>
            <p style="margin:0 0 18px">Sign in through Cloudflare Access using this email address and the one-time PIN sent to it.</p>
            <a href="${safeInviteUrl}" style="display:inline-block;padding:12px 18px;border-radius:12px;background:#8b3f1f;color:#ffffff;text-decoration:none;font-weight:700">Go to Admin</a>
            <p style="margin:18px 0 0;font-size:13px;color:#6b7280;word-break:break-word">If the button does not work, copy this link:<br>${safeInviteUrl}</p>
          </div>
        </div>
      </div>
    `
  };
}

async function handleUsersList(request, env) {
  const staticEmails = staticAllowList(env).map((email) => ({
    id: `static:${email}`,
    email,
    role: 'administrator',
    status: 'invited',
    isStatic: true
  }));

  let invited = [];
  if (env.DB) {
    try {
      const rows = await env.DB.prepare(
        `SELECT id, email, role, status, invited_at FROM admin_invites WHERE status = 'invited' ORDER BY invited_at DESC`
      ).all();
      invited = (rows?.results || []).map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        status: r.status,
        createdAt: r.invited_at,
        isStatic: false
      }));
    } catch {
      invited = [];
    }
  }

  const staticEmailSet = new Set(staticEmails.map((u) => u.email));
  const users = [...staticEmails, ...invited.filter((u) => !staticEmailSet.has(u.email))];
  return json({ users });
}

async function handleUsersInvite(request, env, actorEmail) {
  if (!env.DB) return json({ error: 'D1 database is not configured.' }, 500);

  const body = await request.json().catch(() => ({}));
  const email = String(body?.email || '').toLowerCase().trim();
  const role = String(body?.role || 'website_editor').trim().toLowerCase() || 'website_editor';
  if (!isValidEmail(email)) return json({ error: 'A valid email is required.' }, 400);

  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO admin_invites (id, email, role, status, invited_by, invited_at, updated_at)
       VALUES (?, ?, ?, 'invited', ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET role=excluded.role, status='invited', invited_by=excluded.invited_by, updated_at=excluded.updated_at`
    ).bind(crypto.randomUUID(), email, role, actorEmail || '', now, now).run();
  } catch (e) {
    return json({ error: `Failed to save invite: ${String(e?.message || e)}`.slice(0, 500) }, 500);
  }

  const canonical = String(env.CANONICAL_HOST || '').trim();
  const inviteUrl = canonical ? `https://${canonical}/admin/` : 'https://mmmbc.com/admin/';
  const fromEmail = String(
    env.RESEND_FROM_EMAIL || env.SUPPORT_FROM_EMAIL || env.SUPPORT_EMAIL_DESTINATION || 'no-reply@mmmbc.com'
  ).trim();
  const fallbackFromEmail = String(env.SUPPORT_EMAIL_DESTINATION || '').trim();
  const fromName = String(env.SUPPORT_FROM_NAME || 'MMMBC Admin').trim() || 'MMMBC Admin';
  const template = buildAdminInviteEmailTemplate({ inviteUrl, role });

  let out = await sendTransactionalEmail(env, {
    personalizations: [{ to: [{ email }], subject: `MMMBC Admin Access (${roleDisplayName(role)})` }],
    from: { email: fromEmail, name: fromName },
    content: [
      { type: 'text/plain', value: template.text },
      { type: 'text/html', value: template.html }
    ]
  });

  const firstAttemptFailed = out.status < 200 || out.status >= 300;
  const shouldRetryWithFallback = firstAttemptFailed
    && fallbackFromEmail
    && fallbackFromEmail.toLowerCase() !== fromEmail.toLowerCase()
    && (out.status === 400 || out.status === 401 || out.status === 403);

  if (shouldRetryWithFallback) {
    out = await sendTransactionalEmail(env, {
      personalizations: [{ to: [{ email }], subject: `MMMBC Admin Access (${roleDisplayName(role)})` }],
      from: { email: fallbackFromEmail, name: fromName },
      content: [
        { type: 'text/plain', value: template.text },
        { type: 'text/html', value: template.html }
      ]
    });
  }

  const emailSent = out.status >= 200 && out.status < 300;
  const emailError = emailSent
    ? ''
    : normalizedEmailError(out.body).slice(0, 500) || `Invite email failed (${out.status || 'unknown'}).`;
  return json({
    ok: true,
    email,
    role,
    inviteLink: inviteUrl,
    emailSent,
    emailError
  });
}

async function handleUsersRevoke(request, env, id) {
  if (!env.DB) return json({ error: 'D1 database is not configured.' }, 500);
  if (String(id || '').startsWith('static:')) {
    return json({ error: 'Remove static administrators from ADMIN_ALLOW_EMAILS in wrangler.jsonc instead.' }, 400);
  }
  await env.DB.prepare(`UPDATE admin_invites SET status='revoked', updated_at=? WHERE id=?`)
    .bind(new Date().toISOString(), String(id)).run();
  return json({ ok: true });
}

// ---------------- Subscribers ----------------

async function handleSubscribersGet(request, env) {
  if (!env.SITE_DB) return json({ subscribers: [] });
  try {
    const rows = await env.SITE_DB.prepare(
      `SELECT id, email, name, status, created_at FROM subscribers WHERE status = 'active' ORDER BY created_at DESC`
    ).all();
    const subscribers = (rows?.results || []).map((r) => ({
      id: r.id, email: r.email, name: r.name || '', status: r.status, createdAt: r.created_at
    }));
    return json({ subscribers });
  } catch {
    return json({ subscribers: [] });
  }
}

async function handleSubscribersPut(request, env) {
  if (!env.SITE_DB) return json({ error: 'D1 database is not configured.' }, 500);
  const body = await request.json().catch(() => ({}));
  const list = Array.isArray(body?.subscribers) ? body.subscribers : [];
  const now = new Date().toISOString();

  const normalized = list
    .map((s) => ({
      email: String(s?.email || '').toLowerCase().trim(),
      name: String(s?.name || '').trim()
    }))
    .filter((s) => isValidEmail(s.email));

  for (const sub of normalized) {
    await env.SITE_DB.prepare(`INSERT INTO subscribers (id,email,name,status,created_at) VALUES (?,?,?,'active',?) ON CONFLICT(email) DO UPDATE SET name=excluded.name`).bind(crypto.randomUUID(),sub.email,sub.name,now).run();
  }

  return handleSubscribersGet(request, env);
}

// ---------------- Newsletter ----------------

function buildNewsletterEmailTemplate({ subject, message }) {
  const safeSubject = escapeHtml(subject);
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');
  return {
    text: `${subject}\n\n${message}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#1f2937;background:#f8fafc;padding:24px">
        <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:18px;overflow:hidden">
          <div style="padding:24px 28px;background:linear-gradient(135deg,#7a2f16,#c46123);color:#ffffff">
            <div style="font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;opacity:.92">Mt. Moriah MBC</div>
            <h1 style="margin:10px 0 0;font-size:24px;line-height:1.25">${safeSubject}</h1>
          </div>
          <div style="padding:24px 28px;color:#111827;font-size:16px">${safeMessage}</div>
        </div>
      </div>
    `
  };
}

async function sendNewsletterEmail(env, { subject, message, emails, idempotencyKey = '', test = false }) {
  if (!env.NEWSLETTER_UNSUBSCRIBE_SECRET || String(env.NEWSLETTER_UNSUBSCRIBE_SECRET).length < 32) return { ok:false, sent:0, error:'Newsletter unsubscribe signing secret is not configured.' };
  if (!/^https:\/\//.test(String(env.PUBLIC_SITE_URL || ''))) return { ok:false, sent:0, error:'Public newsletter URL is not configured.' };
  const campaignId = idempotencyKey || `newsletter-${crypto.randomUUID()}`;
  const eligible = test ? emails : await eligibleRecipients(env, emails);
  let sent = 0, errors = [], pending = false;
  const now=new Date().toISOString();
  for (const email of eligible) await env.DB.prepare(`INSERT INTO newsletter_deliveries (campaign_id,email,status,updated_at) VALUES (?,?,'pending',?) ON CONFLICT(campaign_id,email) DO NOTHING`).bind(campaignId,email,now).run();
  const deliveries=await env.DB.prepare('SELECT email,status,attempts FROM newsletter_deliveries WHERE campaign_id=?').bind(campaignId).all();
  const remaining=(deliveries.results||[]).filter(d=>!['sent','failed'].includes(d.status)&&eligible.includes(d.email));
  const chunk=remaining.slice(0,20);
  for (const row of chunk) {
    // Recheck suppression immediately before each actual send, including retries.
    if (!test && !(await eligibleRecipients(env,[row.email])).length) continue;
    const token=await unsubscribeToken(env,row.email);
    const link=`${String(env.PUBLIC_SITE_URL).replace(/\/$/,'')}/newsletter/unsubscribe?token=${encodeURIComponent(token)}`;
    const template=buildNewsletterEmailTemplate({subject,message});
    const out=await sendResendEmail(env,{to:row.email,subject,text:`${template.text}\n\nUnsubscribe: ${link}`,html:template.html+`<p style="font-family:Arial;text-align:center"><a href="${escapeHtml(link)}">Unsubscribe from church newsletters</a></p>`,idempotencyKey:`${campaignId}-${row.email}`,emailHeaders:{'List-Unsubscribe':`<${link}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}});
    await env.DB.prepare('UPDATE newsletter_deliveries SET status=?,provider_id=?,attempts=attempts+1,error=?,updated_at=? WHERE campaign_id=? AND email=?').bind(out.ok?'sent':Number(row.attempts||0)+1>=3?'failed':'pending',out.id||null,out.error||'',new Date().toISOString(),campaignId,row.email).run();
    if(out.ok) sent++;else errors.push(out.error||'Delivery failed');
  }
  const after=await env.DB.prepare('SELECT email,status,attempts FROM newsletter_deliveries WHERE campaign_id=?').bind(campaignId).all();
  pending=(after.results||[]).some(d=>d.status==='pending'&&eligible.includes(d.email));
  if((after.results||[]).some(d=>d.status==='failed'&&eligible.includes(d.email))) errors.push('Some recipients could not be delivered after three attempts.');
  const totals=await env.DB.prepare("SELECT COUNT(*) AS c FROM newsletter_deliveries WHERE campaign_id=? AND status='sent'").bind(campaignId).first();
  return {ok:!errors.length&&!pending,pending,sent:Number(totals?.c||sent),error:errors.join('; ').slice(0,500)};
}

function rowToRecord(r) {
  return {
    id: r.id,
    subject: r.subject,
    message: r.message,
    emails: JSON.parse(r.emails || '[]'),
    status: r.status,
    sentCount: r.sent_count,
    scheduleAt: r.schedule_at,
    scheduleDate: r.schedule_date,
    scheduleTime: r.schedule_time,
    scheduleTimezone: r.schedule_timezone,
    retryCount: r.retry_count,
    error: r.error || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sentAt: r.sent_at
  };
}

async function getNewsletterRecords(env) {
  if (!env.DB) return { drafts: [], scheduled: [], history: [] };
  const rows = await env.DB.prepare(
    `SELECT * FROM newsletter_records ORDER BY created_at DESC`
  ).all();
  const all = (rows?.results || []).map(rowToRecord);
  return {
    drafts: all.filter((r) => r.status === 'draft'),
    scheduled: all.filter((r) => ['scheduled', 'retrying', 'sending'].includes(r.status)),
    history: all.filter((r) => ['sent', 'skipped', 'failed'].includes(r.status))
  };
}

async function validateNewsletterRecipients(env, emailsInput) {
  const requested = Array.isArray(emailsInput)
    ? emailsInput.map((e) => String(e || '').toLowerCase().trim()).filter(Boolean)
    : [];
  const unique = Array.from(new Set(requested));
  const invalid = unique.filter((e) => !isValidEmail(e));
  if (invalid.length) {
    const err = new Error(`Invalid recipient email: ${invalid[0]}`);
    err.statusCode = 400;
    throw err;
  }

  const allowed = await eligibleRecipients(env, unique);
  if (allowed.length !== unique.length) { const err=new Error('Some recipients are inactive or unsubscribed.');err.statusCode=400;throw err; }
  return allowed;
}

async function handleNewsletterRecordsGet(request, env) {
  return json(await getNewsletterRecords(env));
}

async function handleNewsletterRecordsPost(request, env) {
  if (!env.DB) return json({ error: 'D1 database is not configured.' }, 500);
  const body = await request.json().catch(() => ({}));
  const action = String(body?.action || '').trim().toLowerCase();
  const now = new Date().toISOString();


  if (action === 'delete') {
    const id = String(body?.id || '').trim();
    if (!id) return json({ error: 'Record id is required.' }, 400);
    await env.DB.prepare(`DELETE FROM newsletter_records WHERE id=?`).bind(id).run();
    return json(await getNewsletterRecords(env));
  }

  const subject = String(body?.subject || '').trim().slice(0, 140);
  const message = String(body?.message || '').trim().slice(0, 12000);
  if (!subject || !message) return json({ error: 'Subject and message are required.' }, 400);

  let emails;
  try {
    emails = await validateNewsletterRecipients(env, body?.emails || []);
  } catch (err) {
    return json({ error: err.message || 'Invalid recipients.' }, err.statusCode || 400);
  }
  if (!emails.length) return json({ error: 'Select at least one recipient.' }, 400);

  if (action === 'save_draft') {
    await env.DB.prepare(
      `INSERT INTO newsletter_records (id, subject, message, emails, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?)`
    ).bind(crypto.randomUUID(), subject, message, JSON.stringify(emails), now, now).run();
    return json(await getNewsletterRecords(env));
  }

  if (action === 'schedule') {
    const scheduleDate = String(body?.scheduleDate || '').trim();
    const scheduleTime = String(body?.scheduleTime || '').trim();
    const scheduleTimezone = String(body?.scheduleTimezone || env.NEWSLETTER_TIMEZONE || 'America/Chicago').trim() || 'America/Chicago';
    let scheduleAt;
    try { scheduleAt=zonedSchedule(scheduleDate,scheduleTime,scheduleTimezone); }
    catch(error) { return json({error:error.message},400); }
    if (Date.parse(scheduleAt) <= Date.now()) return json({ error: 'Scheduled time must be in the future.' }, 400);

    await env.DB.prepare(
      `INSERT INTO newsletter_records (id, subject, message, emails, status, schedule_at, schedule_date, schedule_time, schedule_timezone, retry_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, 0, ?, ?)`
    ).bind(crypto.randomUUID(), subject, message, JSON.stringify(emails), scheduleAt, scheduleDate, scheduleTime, scheduleTimezone, now, now).run();
    return json(await getNewsletterRecords(env));
  }

  return json({ error: 'Unsupported newsletter action.' }, 400);
}

async function handleNewsletterTest(request, env, actorEmail) {
  const body = await request.json().catch(() => ({}));
  const subject = String(body?.subject || '').trim().slice(0, 140);
  const message = String(body?.message || '').trim().slice(0, 12000);
  if (!subject || !message) return json({ error: 'Subject and message are required.' }, 400);

  const requestedRaw = Array.isArray(body?.emails)
    ? body.emails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const invalid = requestedRaw.filter((email) => !isValidEmail(email));
  if (invalid.length) return json({ error: `Invalid recipient email: ${invalid[0]}` }, 400);

  let recipients = Array.from(new Set(requestedRaw));
  if (!recipients.length) {
    if (!isValidEmail(actorEmail)) return json({ error: 'Signed-in user email is invalid.' }, 400);
    recipients = [actorEmail];
  }

  if (recipients.length > 20) return json({error:'Send test mail to no more than 20 recipients at a time.'},400);
  const out = await sendNewsletterEmail(env, { subject, message, emails: recipients, test: true });
  if (!out.ok) return json({ error: out.error }, 502);
  return json({ ok: true, recipients, sent: out.sent });
}

async function handleNewsletterSend(request, env) {
  if (!env.DB) return json({ error: 'D1 database is not configured.' }, 500);
  const body = await request.json().catch(() => ({}));
  const subject = String(body?.subject || '').trim().slice(0, 140);
  const message = String(body?.message || '').trim().slice(0, 12000);
  let emails;
  try {
    emails = await validateNewsletterRecipients(env, body?.emails || []);
  } catch (err) {
    return json({ error: err.message || 'Invalid recipients.' }, err.statusCode || 400);
  }
  if (!subject || !message) return json({ error: 'Subject and message are required.' }, 400);
  if (!emails.length) return json({ error: 'Select at least one recipient.' }, 400);

  const now = new Date().toISOString();
  const id=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO newsletter_records (id,subject,message,emails,status,schedule_at,retry_count,created_at,updated_at) VALUES (?,?,?,?,'scheduled',?,0,?,?)`).bind(id,subject,message,JSON.stringify(emails),now,now,now).run();
  return json({ok:true,queued:true,message:'Newsletter queued for delivery.'},202);
}

async function processScheduledNewsletters(env) {
  if (!env.DB) return;
  const nowIso = new Date().toISOString();
  let due;
  try {
    due = await env.DB.prepare(
      `SELECT * FROM newsletter_records WHERE status IN ('scheduled', 'retrying', 'sending') AND schedule_at <= ?`
    ).bind(nowIso).all();
  } catch {
    return;
  }

  for (const row of (due?.results || [])) {
    const record = rowToRecord(row);
    const leaseUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const claim = await env.DB.prepare(
      `UPDATE newsletter_records
       SET status='sending', schedule_at=?, updated_at=?
       WHERE id=? AND status IN ('scheduled', 'retrying', 'sending') AND schedule_at <= ?`
    ).bind(leaseUntil, nowIso, record.id, nowIso).run();
    if (!Number(claim?.meta?.changes || 0)) continue;

    const out = await sendNewsletterEmail(env, {
      subject: record.subject,
      message: record.message,
      emails: record.emails,
      idempotencyKey: `newsletter-${record.id}`
    });
    const now = new Date().toISOString();

    if (out.ok) {
      await env.DB.prepare(
        `UPDATE newsletter_records SET status='sent', sent_count=?, sent_at=?, updated_at=?, error='' WHERE id=?`
      ).bind(out.sent, now, now, record.id).run();
      continue;
    }

    if (out.pending) {
      await env.DB.prepare("UPDATE newsletter_records SET status='scheduled',sent_count=?,schedule_at=?,updated_at=? WHERE id=?").bind(out.sent,new Date(Date.now()+300000).toISOString(),now,record.id).run();
      continue;
    }
    const retryCount = (record.retryCount || 0) + 1;
    if (retryCount < 3) {
      const nextAttempt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await env.DB.prepare(
        `UPDATE newsletter_records SET status='retrying', retry_count=?, schedule_at=?, updated_at=?, error=? WHERE id=?`
      ).bind(retryCount, nextAttempt, now, String(out.error || 'Send failed').slice(0, 500), record.id).run();
    } else {
      await env.DB.prepare(
        `UPDATE newsletter_records SET status='failed', retry_count=?, sent_at=?, updated_at=?, error=? WHERE id=?`
      ).bind(retryCount, now, now, String(out.error || 'Send failed').slice(0, 500), record.id).run();
    }
  }
}

export {
  isEmailInvited,
  handleUsersList,
  handleUsersInvite,
  handleUsersRevoke,
  handleSubscribersGet,
  handleSubscribersPut,
  handleNewsletterRecordsGet,
  handleNewsletterRecordsPost,
  handleNewsletterTest,
  handleNewsletterSend,
  processScheduledNewsletters
};
