// Existing MMMBC campaign; confirm its current share/embed URLs before release.
const ZEFFY_DONATION_URL = 'https://www.zeffy.com/en-US/donation-form/tithes-and-offering-59';
export const GIVING_PAGE_PATHS = new Set(['/give', '/give/', '/giving', '/giving.html', '/giving-success.html', '/Pages/giving.html', '/Pages/giving', '/Pages/giving-success.html']);

function zeffyUrl(value, embed = false) {
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'https:' || url.hostname !== 'www.zeffy.com' || url.port || url.username || url.password) return '';
    const path = embed ? /^\/(?:[a-z]{2}-[a-z]{2}\/)?embed\/(?:[a-z]{2}-[a-z]{2}\/)?donation-form\/[^/]+\/?$/i : /^\/(?:[a-z]{2}-[a-z]{2}\/)?donation-form\/[^/]+\/?$/i;
    if (!path.test(url.pathname)) return '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

export function givingConfiguration(env = {}) {
  const donationUrl = zeffyUrl(env.ZEFFY_DONATION_URL ?? ZEFFY_DONATION_URL);
  // Zeffy's documented embed path; a copied account-specific URL takes precedence.
  const slug = donationUrl ? new URL(donationUrl).pathname.split('/').filter(Boolean).pop() : '';
  const embedUrl = zeffyUrl(env.ZEFFY_EMBED_URL ?? (slug ? 'https://www.zeffy.com/embed/donation-form/' + slug : ''), true);
  return { donationUrl, embedUrl: donationUrl ? embedUrl : '' };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function redirectResponse(request) {
  return new Response(null, { status: 302, headers: { Location: new URL('/give', request.url).href, 'Cache-Control': 'no-store' } });
}

export async function handleGivingPageRequest(request, env = {}) {
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  const url = new URL(request.url);
  if (!GIVING_PAGE_PATHS.has(url.pathname)) return null;
  if (url.pathname !== '/give') return redirectResponse(request);
  if (!env.ASSETS?.fetch) return new Response('Online giving is temporarily unavailable. Please contact the church.', { status: 503, headers: { 'Cache-Control': 'no-store' } });

  const assetHeaders = new Headers(request.headers);
  assetHeaders.set('Accept-Encoding', 'identity');
  const asset = await env.ASSETS.fetch(new Request(new URL('/Pages/giving.html', url.origin), { headers: assetHeaders }));
  if (!asset.ok) return new Response('Online giving is temporarily unavailable. Please contact the church.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  const { donationUrl, embedUrl } = givingConfiguration(env);
  const checkout = donationUrl ? '<p class="givingDirect"><a href="' + escapeHtml(donationUrl) + '" target="_blank" rel="noopener noreferrer">Open secure Zeffy checkout in a new tab</a></p>' : '';
  const embedPath = embedUrl ? new URL(embedUrl).pathname + new URL(embedUrl).search : '';
  const form = embedUrl ? '<div id="givingEmbed" data-zeffy-embed data-form-url="' + escapeHtml(embedPath) + '"></div>' +
    '<div id="givingEmbedFallback"><iframe title="Mt. Moriah secure donation form powered by Zeffy" src="' + escapeHtml(embedUrl) + '" allow="payment" allowpaymentrequest referrerpolicy="strict-origin-when-cross-origin"></iframe></div>' :
    '<p role="status">The online giving form is temporarily unavailable. ' + (donationUrl ? 'Please use the secure checkout link below.' : 'Please contact the church for help giving.') + '</p>';
  let html = await asset.text();
  html = html.replace('<!-- ZEFFY_CHECKOUT -->', form + checkout)
    .replace('<!-- GIVING_CANONICAL -->', '<link rel="canonical" href="' + escapeHtml(new URL('/give', url.origin).href) + '" />');
  const headers = new Headers(asset.headers);
  for (const name of ['Content-Length', 'Content-Encoding', 'ETag', 'Last-Modified', 'Location']) headers.delete(name);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-MM-MBC-Giving-Route', 'zeffy-embed-v1');
  return new Response(request.method === 'HEAD' ? null : html, { headers });
}

export { ZEFFY_DONATION_URL };
