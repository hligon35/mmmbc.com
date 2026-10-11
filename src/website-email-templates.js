// Shared, email-client-friendly branding for receipts from the public website.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function siteOrigin(env) {
  try {
    const url = new URL(env.PUBLIC_SITE_URL || 'https://mmmbc.com');
    if (url.protocol === 'https:' && !url.username && !url.password) return url.origin;
  } catch { /* Use the public church origin when configuration is invalid. */ }
  return 'https://mmmbc.com';
}

export function websiteAutoReply(env, { kind, name = '', submissionId = '', rental = {}, unsubscribeUrl = '' }) {
  const church = String(env.RESEND_FROM_NAME || 'Mt. Moriah Missionary Baptist Church').trim();
  const site = siteOrigin(env);
  const replyTo = String(env.WEBSITE_REPLY_TO_EMAIL || env.RESEND_REPLY_TO_EMAIL || '').trim();
  const greeting = name ? `Hello ${String(name).trim().slice(0, 140)},` : 'Hello,';
  let subject, heading, paragraphs, details = [];
  if (kind === 'contact') {
    subject = 'Mt. Moriah — We received your message';
    heading = 'Thank you for reaching out';
    paragraphs = [`Thank you for contacting ${church}. Your message has been received by our church office.`,
      'Our team will review your message and respond as soon as possible.'];
  } else if (kind === 'facility_rental') {
    subject = 'Mt. Moriah — Your facility request was received';
    heading = 'Your facility request is in';
    paragraphs = [`Thank you for submitting a facility rental request to ${church}.`,
      'Our team will review availability and your request, then contact you about the next steps. This receipt does not confirm a reservation or approve your event.'];
    details = [['Request type', rental.audience === 'non_member' ? 'Non-member rental' : 'Member rental'],
      ['Event / group', rental.eventGroup], ['Requested date', rental.dateOfUse],
      ['Requested time', rental.timeFrom && rental.timeTo ? `${rental.timeFrom}–${rental.timeTo} (church local time)` : ''],
      ['Facilities', Array.isArray(rental.facilities) ? rental.facilities.join(', ') : '']];
  } else if (kind === 'newsletter') {
    subject = 'Mt. Moriah — Welcome to our church newsletter';
    heading = 'Welcome to our church family updates';
    paragraphs = [`Thank you for joining the ${church} newsletter. Your subscription is active.`,
      'You will receive church news, upcoming events, and ministry updates. You can unsubscribe using the link in our newsletters at any time.'];
  } else {
    throw new Error('Unsupported website confirmation type.');
  }
  if (submissionId && kind !== 'newsletter') details.push(['Reference', submissionId]);
  details = details.filter(([, value]) => value).map(([label, value]) => [label, String(value).slice(0, 500)]);
  const replyNote = replyTo ? 'Questions? Reply to this email to reach our church office.' : 'Questions? Contact our church office at (270) 443-3714.';
  const text = [greeting, '', ...paragraphs, '', ...details.map(([label, value]) => `${label}: ${value}`), '', replyNote,
    ...(unsubscribeUrl ? [`Unsubscribe: ${unsubscribeUrl}`] : []), '', church, '1201 South 8th Street, Paducah, KY 42003',
    '(270) 443-3714', site].join('\n');
  const rows = details.map(([label, value]) => `<tr><th scope="row" align="left" style="padding:9px 12px;border-bottom:1px solid #e8e1d9;font-size:13px;vertical-align:top;width:35%">${escapeHtml(label)}</th><td style="padding:9px 12px;border-bottom:1px solid #e8e1d9;font-size:13px;overflow-wrap:anywhere">${escapeHtml(value)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f0ec;color:#292522;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f0ec"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e6ded5">
<tr><td align="center" style="padding:28px 20px;background:#171513;border-bottom:5px solid #c46123">
<img src="${escapeHtml(site)}/ConImg/MtMoriahLogo-1.png" width="100" alt="Mt. Moriah church logo" style="display:block;width:100px;height:auto;margin:0 auto 14px">
<p style="margin:0;color:#ffffff;font-size:20px;font-weight:bold;line-height:1.4">${escapeHtml(church)}</p>
<p style="margin:8px 0 0;color:#e8b78f;font-size:12px;letter-spacing:2px">PADUCAH, KENTUCKY</p></td></tr>
<tr><td style="padding:28px 24px"><h1 style="margin:0 0 22px;color:#a64d19;font-size:26px;line-height:1.3">${escapeHtml(heading)}</h1>
<p style="font-size:16px;line-height:1.6">${escapeHtml(greeting)}</p>
${paragraphs.map(p => `<p style="font-size:16px;line-height:1.6;margin:0 0 16px">${escapeHtml(p)}</p>`).join('')}
${rows ? `<table width="100%" cellspacing="0" cellpadding="0" style="margin:22px 0;background:#faf7f3;border:1px solid #e8e1d9">${rows}</table>` : ''}
<p style="font-size:14px;line-height:1.6;margin:22px 0">${escapeHtml(replyNote)}</p>
<table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="background:#a64d19;border-radius:6px"><a href="${escapeHtml(site)}" style="display:inline-block;padding:13px 20px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold">Visit our church website</a></td></tr></table></td></tr>
<tr><td align="center" style="padding:22px;background:#faf7f3;color:#65594f;font-size:12px;line-height:1.8">${escapeHtml(church)}<br>1201 South 8th Street, Paducah, KY 42003<br><a href="tel:2704433714" style="color:#8e4318">(270) 443-3714</a><br>
${unsubscribeUrl ? `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#8e4318">Unsubscribe from church newsletters</a><br>` : ''}
This automatic email confirms receipt of your website submission.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html, replyTo, fromName: church };
}
