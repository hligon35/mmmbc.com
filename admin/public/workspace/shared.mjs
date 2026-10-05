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
export function icon(name) {
  return el('span',{
    class:'material-icons-round ws-icon',
    'aria-hidden':'true',
    text:String(name || 'mail_outline')
  });
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
