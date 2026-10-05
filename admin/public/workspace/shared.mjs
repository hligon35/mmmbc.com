export function el(tag,attrs={},...children) {
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attrs)) {
    if(key==='class')node.className=value;
    else if(key==='text')node.textContent=value ?? '';
    else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);
    else if(value!==undefined && value!==null)node.setAttribute(key,value);
  }
  node.append(...children.filter(c=>c!==null && c!==undefined));
  return node;
}
const paths={
  inbox:'M3 4h18v16H3z M3 13h5l2 3h4l2-3h5', meeting_room:'M4 21V3h12v18 M16 8h4v13 M12 12h1',
  calendar_month:'M4 5h16v16H4z M8 3v4 M16 3v4 M4 10h16 M8 14h2 M14 14h2', contacts:'M5 3h15v18H5z M2 7h4 M2 12h4 M2 17h4 M10 17c0-4 6-4 6 0 M15 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  groups:'M8 10a3 3 0 1 1 0-6 3 3 0 0 1 0 6 M2 20v-2c0-6 12-6 12 0v2 M17 5a3 3 0 0 1 0 6 M18 14c3 0 4 2 4 4v2', badge:'M4 4h16v17H4z M9 2v4h6V2 M15 11a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M8 18c0-4 8-4 8 0',
  campaign:'M3 10h6l11-5v14L9 14H3z M8 14l2 7H6l-2-7', account_balance:'M3 8l9-6 9 6z M5 10v9 M10 10v9 M14 10v9 M19 10v9 M2 22h20 M3 19h18', volunteer_activism:'M3 14h3l4 3h5 M3 21h5l12-7c2-2-1-4-3-2l-4 2 M3 14v7 M13 8c-7-4-1-10 2-6 4-4 8 3 2 6l-2 2z',
  bar_chart:'M4 21V10h4v11 M10 21V3h4v18 M16 21V7h4v14', edit_note:'M3 5h12 M3 10h9 M3 15h6 M14 20l-4 1 1-4 8-8 3 3z', feed:'M4 3h16v18H4z M8 7h8 M8 11h8 M8 15h5',
  photo_library:'M5 3h16v16H5z M2 7v15h15 M5 16l5-5 4 4 3-3 4 5 M17 7h.1', admin_panel_settings:'M12 2l8 3v6c0 6-8 11-8 11S4 17 4 11V5z M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M8 17c0-5 8-5 8 0',
  settings:'M10 2h4l1 3 3 1 3-1 2 4-2 3v3l2 3-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-3v-3L1 9l2-4 3 1 3-1z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  savings:'M4 9c-1-5 13-8 16-1l3 1v5l-3 1-1 7h-3l-1-4H8l-1 4H4l-1-9H1 M9 5h6 M17 10h.1', fact_check:'M4 3h16v18H4z M8 8h4 M8 13h4 M8 18h4 M14 12l2 2 3-4',
  home:'M2 11L12 2l10 9 M5 9v13h14V9 M10 22v-8h4v8', mail_outline:'M3 5h18v14H3z M3 5l9 8 9-8', summarize:'M4 3h11l5 5v13H4z M15 3v5h5 M8 12h8 M8 16h6',
  search:'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M15 15l6 6', logout:'M10 3H3v18h7 M8 12h13 M16 7l5 5-5 5', add:'M12 4v16 M4 12h16',
  mark_email_unread:'M3 6h18v14H3z M3 6l9 8 9-8 M21 4h.1', mark_email_read:'M3 6h18v14H3z M3 6l9 8 9-8 M14 18l3 3 5-6',
  star:'M12 2l3 7 7 1-5 5 1 7-6-4-6 4 1-7-5-5 7-1z', star_border:'M12 2l3 7 7 1-5 5 1 7-6-4-6 4 1-7-5-5 7-1z', send:'M2 3l20 9-20 9 4-9z M6 12h16',
  archive:'M3 3h18v5H3z M5 8v13h14V8 M9 12h6', delete:'M3 6h18 M8 6V3h8v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7', label:'M3 4h10l8 8-8 8H3z M7 8h.1',
  refresh:'M20 7a9 9 0 1 0 1 9 M20 2v6h-6', reply:'M9 5l-7 7 7 7 M2 12h11c6 0 8 4 8 8', arrow_back:'M21 12H3 M10 5l-7 7 7 7', chevron_left:'M15 5l-7 7 7 7', chevron_right:'M9 5l7 7-7 7',
  restore:'M3 4v6h6 M3 10a9 9 0 1 1 1 8 M12 7v6l4 2', open_in_full:'M14 3h7v7 M21 3l-7 7 M3 14v7h7 M3 21l7-7', close:'M5 5l14 14 M19 5L5 19', menu:'M3 6h18 M3 12h18 M3 18h18', download:'M12 3v12 M6 9l6 6 6-6 M4 16v5h16v-5'
};
export function icon(name) {
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const [k,v]of Object.entries({viewBox:'0 0 24 24',width:'18',height:'18',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',class:'ws-icon'}))svg.setAttribute(k,v);
  const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',paths[name]||paths.mail_outline);svg.append(path);return svg;
}
export const button = (text,action,{symbol='',primary=false,...attrs}={}) => el('button',{type:'button',class:'ws-button'+(primary?' ws-primary':''),onclick:action,...attrs},symbol?icon(symbol):null,el('span',{text}));
export const time = value => value ? new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago',dateStyle:'medium',timeStyle:'short'}) : '';
export const statusLabel = value => ({accepted:'Accepted by email service',sent:'Accepted by email service',uncertain:'Send status uncertain',email_failed:'Notification failed',emailed:'Notification accepted'})[value] || String(value || 'Pending').replaceAll('_',' ');
export function sessionExpired() {
  const dest=new URL('/cdn-cgi/access/login',location.origin);
  dest.searchParams.set('redirect_url',location.href);
  location.assign(dest.href);
}
export async function api(path,options={}) {
  const response=await fetch(path,{credentials:'same-origin',...options,headers:{...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),...options.headers}});
  if(response.status===401 || (response.redirected && new URL(response.url).pathname.includes('/cdn-cgi/'))) { sessionExpired();throw Error('Your session expired. Signing in…'); }
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error?.message || data.error || 'The request failed. Try again.');
  return data;
}
export function showError(container,error,retry) {
  const node=el('div',{class:'ws-error',role:'alert'},el('p',{text:error.message || String(error)}));
  if(retry)node.append(button('Try Again',retry,{symbol:'refresh'}));
  container.replaceChildren(node);
}
export const heading = (title,description,...actions) => el('header',{class:'ws-module-head'},el('div',{},el('p',{class:'ws-eyebrow',text:'CHURCH OPERATIONS'}),el('h1',{text:title}),el('p',{class:'ws-muted',text:description})),el('div',{class:'ws-actions'},...actions));
export function download(path) {
  const a=el('a',{href:path,download:''});document.body.append(a);a.click();a.remove();
}
