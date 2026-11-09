// Keep the alternate public origin usable while admin sessions use Access on the primary domain.
export function canonicalAdminRedirect(request, env = {}) {
  const url = new URL(request.url);
  const canonical = String(env.CANONICAL_HOST || '').trim().toLowerCase();
  const adminPath = url.pathname === '/admin' || url.pathname.startsWith('/admin/');
  if (!canonical || canonical === url.hostname || !url.hostname.endsWith('.workers.dev')
      || !adminPath || !['GET', 'HEAD'].includes(request.method)) return null;

  url.hostname = canonical;
  url.port = '';
  url.protocol = 'https:';
  return new Response(null, {
    status: 302,
    headers: { Location: url.href, 'Cache-Control': 'no-store' }
  });
}
