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

function buildAdminInviteEmailTemplate({ inviteLink, expiresAt, roleLabel }) {
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

module.exports = {
  buildSupportEmailTemplate,
  buildNewsletterEmailTemplate,
  buildAdminInviteEmailTemplate
};
