const ZEFFY_DONATION_URL = 'https://www.zeffy.com/en-US/donation-form/tithes-and-offering-59';

function redirectResponse(request, location, status = 302) {
  const target = new URL(location, request.url);
  return new Response(null, {
    status,
    headers: {
      Location: target.toString(),
      'Cache-Control': 'no-store'
    }
  });
}

export async function handleGivingPageRequest(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

  const url = new URL(request.url);

  // The branded giving form has been detached. Keep the canonical short route
  // as a stable redirect to Zeffy and move legacy custom-page URLs to /give.
  if (url.pathname === '/give') return redirectResponse(request, ZEFFY_DONATION_URL);
  if (url.pathname === '/giving' || url.pathname === '/giving.html' || url.pathname === '/giving-success.html') {
    return redirectResponse(request, '/give', 301);
  }

  return null;
}

export { ZEFFY_DONATION_URL };
