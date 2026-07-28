function rewriteGivingHtml(html, success = false) {
  let output = String(html || '');

  output = output
    .replaceAll('href="../Icons/', 'href="/Icons/')
    .replaceAll('href="../style.css"', 'href="/style.css"')
    .replaceAll('href="../public-base.css"', 'href="/public-base.css"')
    .replaceAll('href="../public-components.css"', 'href="/public-components.css"')
    .replaceAll('href="giving.css', 'href="/Pages/giving.css')
    .replaceAll('src="../ConImg/', 'src="/ConImg/')
    .replaceAll('src="../script.js"', 'src="/script.js"')
    .replaceAll('src="giving.js', 'src="/Pages/giving.js')
    .replaceAll('href="../index.html"', 'href="/index.html"')
    .replaceAll('href="ministries.html"', 'href="/Pages/ministries.html"')
    .replaceAll('href="leadership.html"', 'href="/Pages/leadership.html"')
    .replaceAll('href="church_history.html"', 'href="/Pages/church_history.html"')
    .replaceAll('href="facility_rental.html"', 'href="/Pages/facility_rental.html"')
    .replaceAll('href="photo_gallery.html"', 'href="/Pages/photo_gallery.html"')
    .replaceAll('href="live_praise.html"', 'href="/Pages/live_praise.html"')
    .replaceAll('href="contact.html"', 'href="/Pages/contact.html"')
    .replaceAll('href="giving.html"', 'href="/giving.html"');

  if (success) {
    output = output.replaceAll('href="../index.html"', 'href="/index.html"');
  }

  return output;
}

async function serveAssetAsRootPage(request, env, assetPath, success = false) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    return new Response('Giving page is unavailable.', { status: 503 });
  }

  const assetUrl = new URL(request.url);
  assetUrl.pathname = assetPath;
  assetUrl.search = '';

  const assetResponse = await env.ASSETS.fetch(new Request(assetUrl.toString(), {
    method: 'GET',
    headers: request.headers
  }));

  if (!assetResponse.ok) return assetResponse;

  const html = rewriteGivingHtml(await assetResponse.text(), success);
  const headers = new Headers(assetResponse.headers);
  headers.delete('Content-Length');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  headers.set('X-MM-MBC-Giving-Route', 'root-v1');

  return new Response(html, {
    status: assetResponse.status,
    headers
  });
}

export async function handleGivingPageRequest(request, env) {
  if (request.method !== 'GET') return null;

  const url = new URL(request.url);
  if (url.pathname === '/giving.html' || url.pathname === '/giving') {
    return serveAssetAsRootPage(request, env, '/Pages/giving.html', false);
  }

  if (url.pathname === '/giving-success.html') {
    return serveAssetAsRootPage(request, env, '/Pages/giving-success.html', true);
  }

  return null;
}
