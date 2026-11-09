const encoder = new TextEncoder();
function secret(env) {
  const value = String(env.NEWSLETTER_UNSUBSCRIBE_SECRET || '');
  if (value.length < 32) throw new Error('Newsletter preferences are not configured.');
  return value;
}
async function signingKey(env) {
  return crypto.subtle.importKey('raw', encoder.encode(secret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign','verify']);
}
export async function unsubscribeToken(env, email) {
  const bytes = encoder.encode(JSON.stringify({ email: email.toLowerCase().trim(), purpose: 'unsubscribe' }));
  const payload = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(payload));
  return `${payload}.${Array.from(new Uint8Array(signature), b=>b.toString(16).padStart(2,'0')).join('')}`;
}
export async function tokenEmail(env, token) {
  try {
    const [payload, signature, extra] = String(token || '').split('.');
    if (extra || !/^[a-f0-9]{64}$/.test(signature)) return '';
    const bytes = Uint8Array.from(signature.match(/../g), x=>parseInt(x,16));
    if (!await crypto.subtle.verify('HMAC', await signingKey(env), bytes, encoder.encode(payload))) return '';
    const binary = atob(payload);
    let data;
    try {
      data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
    } catch {
      // Existing links encoded Latin-1 directly; keep their signed payloads valid.
      data = JSON.parse(binary);
    }
    return data.purpose === 'unsubscribe' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) ? data.email : '';
  } catch { return ''; }
}
export function zonedSchedule(date, time, timezone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error('Choose a valid schedule date and time.');
  const [year, month, day] = date.split('-').map(Number), [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year, month-1, day, hour, minute);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
  const matches = [];
  // Valid IANA offsets span -12 through +14 hours; include quarter-hour offsets.
  for (let offset=-12*60; offset<=14*60; offset+=15) {
    const candidate = target-offset*60000;
    const p=Object.fromEntries(fmt.formatToParts(candidate).map(x=>[x.type,x.value]));
    if (`${p.year}-${p.month}-${p.day}` === date && `${p.hour}:${p.minute}` === time) matches.push(candidate);
  }
  if (matches.length !== 1) throw new Error(matches.length ? 'This time occurs twice when clocks change. Choose another time.' : 'This local time does not exist. Choose another time.');
  return new Date(matches[0]).toISOString();
}
export async function eligibleRecipients(env, requested) {
  if (!env.DB || !env.SITE_DB) throw new Error('Newsletter storage is unavailable.');
  const [site, directory, suppressed] = await Promise.all([
    env.SITE_DB.prepare('SELECT email, status FROM subscribers').all(),
    env.DB.prepare('SELECT email, status FROM newsletter_subscribers').all(),
    env.DB.prepare('SELECT email FROM newsletter_suppressions').all()
  ]);
  const active=new Set([...site.results||[],...directory.results||[]].filter(r=>r.status==='active').map(r=>r.email.toLowerCase()));
  const blocked=new Set([...suppressed.results||[],...[...site.results||[],...directory.results||[]].filter(r=>['unsubscribed','suppressed','bounced','complained'].includes(r.status))].map(r=>r.email.toLowerCase()));
  return [...new Set(requested.map(e=>String(e).trim().toLowerCase()))].filter(e=>active.has(e)&&!blocked.has(e));
}
function page(message, token='') {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>Newsletter preferences | Mt. Moriah</title></head><body><main><img src="/ConImg/MtMoriahLogo-1.png" width="120" alt="Mt. Moriah"><h1>Newsletter preferences</h1><p>${message}</p>${token?`<form method="post"><input type="hidden" name="token" value="${token.replaceAll('&','&amp;').replaceAll('"','&quot;')}"><button type="submit">Unsubscribe</button></form>`:''}<p><a href="/">Return to the church website</a></p></main></body></html>`,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
}
export async function handleNewsletterPreferences(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== '/newsletter/unsubscribe') return null;
  if (!['GET','POST'].includes(request.method)) return new Response(null,{status:405});
  let token=url.searchParams.get('token')||'';
  if(request.method==='POST') {const form=await request.formData().catch(()=>null);token=form?.get('token')||token;}
  const email=await tokenEmail(env,token);
  if(!email) return new Response('This newsletter preference link is invalid.',{status:400});
  if(request.method==='GET') return page('Confirm below to stop receiving church newsletters.',token);
  if(!env.DB||!env.SITE_DB) return new Response('Preferences are temporarily unavailable. Please try again.',{status:503});
  const now=new Date().toISOString();
  // Durable suppression first; sending checks this even if synchronizing the other store fails.
  await env.DB.prepare('INSERT INTO newsletter_suppressions (email, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING').bind(email,'unsubscribed',now).run();
  await env.DB.prepare("UPDATE newsletter_subscribers SET status='unsubscribed', unsubscribed_at=COALESCE(unsubscribed_at,?), updated_at=? WHERE lower(email)=?").bind(now,now,email).run();
  await env.SITE_DB.prepare("UPDATE subscribers SET status='unsubscribed' WHERE lower(email)=?").bind(email).run();
  return page('You have been unsubscribed from church newsletters.');
}
