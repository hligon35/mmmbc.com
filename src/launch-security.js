import { GIVING_PAGE_PATHS } from './worker-giving-pages.js';

export function securityHeaders(response, pathname = '/') {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Strict-Transport-Security', 'max-age=15552000');
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://www.youtube.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com https://www.youtube.com https://www.youtube-nocookie.com https://www.facebook.com https://www.zeffy.com; media-src 'self' blob: https:; manifest-src 'self' https://getsparqd-server.cloudflareaccess.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  if (GIVING_PAGE_PATHS.has(pathname)) {
    const policy = headers.get('Content-Security-Policy')
      .replace('script-src ', 'script-src https://www.zeffy.com ')
      .replace('connect-src ', 'connect-src https://www.zeffy.com ');
    headers.set('Content-Security-Policy', policy);
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://www.zeffy.com")');
  }
  if (pathname.startsWith('/admin') || pathname.startsWith('/api')) headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export function mutationDenied(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return false;
  const url = new URL(request.url);
  if (['/api/stripe/webhook', '/newsletter/unsubscribe'].includes(url.pathname)) return false;
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  return (origin && origin !== url.origin) || site === 'cross-site';
}
export async function checkBodySize(request, maxBytes = 1024 * 1024) {
  if (!request.body) return true;
  const length = Number(request.headers.get('Content-Length'));
  if (length > maxBytes) return false;
  const reader = request.clone().body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      size += value.byteLength;
      if (size > maxBytes) { reader.cancel().catch(() => {}); return false; }
    }
  } finally { reader.releaseLock(); }
}
export function imageUploadAllowed(file) {
  return file && file.size > 0 && file.size <= 10 * 1024 * 1024 && /^image\/(jpeg|png|webp|gif)$/.test(file.type);
}
export function imageBytesAllowed(bytes, type) {
  const a = new Uint8Array(bytes);
  if (type === 'image/jpeg') return a[0] === 255 && a[1] === 216 && a[2] === 255;
  if (type === 'image/png') return [137,80,78,71,13,10,26,10].every((v,i)=>a[i]===v);
  if (type === 'image/gif') return new TextDecoder().decode(a.slice(0,6)).match(/^GIF8[79]a$/) !== null;
  if (type === 'image/webp') return new TextDecoder().decode(a.slice(0,4)) === 'RIFF' && new TextDecoder().decode(a.slice(8,12)) === 'WEBP';
  return false;
}
