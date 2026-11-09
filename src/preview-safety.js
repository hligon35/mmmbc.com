import {GIVING_PAGE_PATHS} from './worker-giving-pages.js';
export function previewResponse(request, env) {
  if (env.ENVIRONMENT !== 'preview') return null;
  const url=new URL(request.url);
  if (!['mmmbc-preview.hligon.workers.dev','localhost','127.0.0.1'].includes(url.hostname)) return new Response('Preview hostname mismatch.',{status:503});
  if (GIVING_PAGE_PATHS.has(url.pathname) || url.pathname.startsWith('/api/giving') || url.pathname==='/api/stripe/webhook') return new Response('Payments are unavailable in training.',{status:403});
  return null;
}
export function previewHeaders(response,env) {
  if(env.ENVIRONMENT!=='preview')return response;
  const headers=new Headers(response.headers);headers.set('X-Robots-Tag','noindex, nofollow, noarchive');headers.set('Cache-Control','no-store');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
