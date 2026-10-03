import {modules,canOpen,resolveRoute,routeUrl,legacyRoutes} from './modules.mjs';
import {el,icon,button,api,showError} from './shared.mjs';
import {Mailbox} from './mailbox.mjs';
import {calendar,reports,editor,financeTool} from './views.mjs';

let started=false;
async function start(session) {
  if(started||!session?.user)return;started=true;
  const permissions=session.permissions||[],allowed=modules.filter(m=>canOpen(m,permissions)),instances=new Map();let active=null,routing=false,navSequence=0;
  const dashboard=document.getElementById('dashboardCard'),oldLayout=dashboard.querySelector('.adminLayout'),oldHeader=document.getElementById('adminHeader');
  oldHeader.classList.add('ws-legacy-header');document.body.classList.add('ws-active');
  const shell=el('div',{class:'ws-shell'}),drawer=el('aside',{class:'ws-drawer',id:'workspaceDrawer','aria-label':'Workspace navigation'}),canvas=el('div',{class:'ws-canvas',id:'workspaceCanvas',tabindex:'-1'}),toast=el('div',{class:'ws-toast',role:'status',hidden:''});
  const back=button('Close menu',()=>setDrawer(false),{class:'ws-backdrop','aria-label':'Close workspace menu',hidden:''});
  let drawerOpen=false;const toggle=button('Menu',()=>setDrawer(!drawerOpen),{symbol:'menu','aria-label':'Menu','aria-controls':'workspaceDrawer','aria-expanded':'false',class:'ws-button ws-menu'});
  function setDrawer(open) {drawerOpen=open;shell.classList.toggle('ws-drawer-open',open);toggle.setAttribute('aria-expanded',String(open));back.hidden=!open;if(open)drawer.querySelector('a,button')?.focus();else toggle.focus();}
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&drawerOpen){e.preventDefault();setDrawer(false);}
    if(e.key==='Tab'&&drawerOpen){const nodes=[...drawer.querySelectorAll('a,button,input')].filter(n=>!n.hidden&&!n.disabled);if(e.shiftKey&&document.activeElement===nodes[0]){e.preventDefault();nodes.at(-1).focus();}else if(!e.shiftKey&&document.activeElement===nodes.at(-1)){e.preventDefault();nodes[0].focus();}}
  });
  function notice(message,error=false,undo) {
    toast.hidden=false;toast.classList.toggle('ws-error',error);toast.replaceChildren(el('span',{text:message}));
    if(undo)toast.append(button('Undo',async()=>{try{await undo();toast.hidden=true;}catch(e){notice(e.message,true);}}));
    toast.append(button('Dismiss',()=>toast.hidden=true,{symbol:'close'}));
  }
  const ctx={permissions,user:session.user,navigate,notice,badge:count=>{
    if('setAppBadge'in navigator)Promise.resolve(count?navigator.setAppBadge(count):navigator.clearAppBadge()).catch(()=>{});
  },mailCounts:count=>{const n=drawer.querySelector('[data-unread-count]');if(n)n.textContent=count?String(count):'';},legacyEvents:()=>navigate('calendar','',{editEvents:true})};
  const mailbox=permissions.includes('submissions.view')?new Mailbox(ctx):null;
  const name=session.user.name||session.user.fullName||session.user.email;
  const search=el('input',{type:'search',placeholder:'Search messages and rental requests','aria-label':'Search messages and rental requests',maxlength:'120'});
  const searchForm=el('form',{class:'ws-global-search',role:'search'},icon('search'),search);
  searchForm.addEventListener('submit',e=>{e.preventDefault();if(mailbox){mailbox.q=search.value;mailbox.page=1;navigate('mail','',{q:search.value});}});
  searchForm.hidden=!mailbox;
  const signout=()=>{if(confirmUnsavedChanges())location.assign('/api/auth/logout');};
  const header=el('header',{class:'ws-header'},toggle,el('div',{class:'ws-brand'},el('img',{src:'/ConImg/MtMoriahLogo-1.png',alt:'Mount Moriah logo',width:'48',height:'48'}),el('div',{},el('strong',{text:'Mount Moriah'}),el('span',{text:'Church Administration'}))),searchForm,
    el('div',{class:'ws-account'},el('span',{class:'ws-avatar',text:name.split(/[\s@.]+/).filter(Boolean).slice(0,2).map(s=>s[0]).join('').toUpperCase()}),el('div',{class:'ws-account-name'},el('strong',{text:name}),el('small',{text:session.user.role.replaceAll('_',' ')})),button('Sign out',signout,{symbol:'logout'})));
  drawer.append(el('p',{class:'ws-eyebrow',text:'YOUR WORKSPACE'}),el('h2',{text:'Mount Moriah'}));
  if(mailbox&&permissions.includes('submissions.manage'))drawer.append(button('New Message',()=>mailbox.compose(),{symbol:'add',primary:true}));
  const nav=el('nav',{'aria-label':'Church operations'});
  for(const m of allowed.filter(m=>!m.parent)) {
    const link=el('a',{class:'ws-nav-link',href:routeUrl(m.id),'data-module':m.id,onclick:e=>{e.preventDefault();navigate(m.id);}},icon(m.icon),el('span',{text:m.label}));
    if(m.id==='mail')link.append(el('span',{'data-unread-count':'',class:'ws-unread-count'}));
    nav.append(link);
  }
  drawer.append(nav);
  if(mailbox) {
    const folders=el('nav',{class:'ws-folders','aria-label':'Mail folders'},el('p',{class:'ws-eyebrow',text:'MAIL FOLDERS'}));
    for(const [id,label,symbol]of [['inbox','Inbox','inbox'],['unread','Unread','mark_email_unread'],['starred','Starred','star'],['sent','Sent','send'],['archive','Archive','archive'],['deleted','Deleted','delete']])folders.append(button(label,()=>{mailbox.folder=id;mailbox.category='all';mailbox.page=1;navigate('mail','',{folder:id,category:'all'});},{symbol,'data-folder':id}));
    folders.append(el('p',{class:'ws-eyebrow',text:'SUBMISSIONS'}));
    for(const [id,label]of [['contact','Contact messages'],['facility_rental','Facility rentals'],['member','Member rentals'],['non_member','Non-member rentals']])folders.append(button(label,()=>{mailbox.folder='inbox';mailbox.category=id;mailbox.page=1;navigate('mail','',{category:id});},{symbol:'label'}));
    drawer.append(folders);
  }
  drawer.append(button('Sign out',signout,{symbol:'logout',class:'ws-button ws-drawer-signout'}));
  shell.append(header,drawer,canvas,back,toast);dashboard.append(shell);canvas.append(oldLayout);
  oldLayout.classList.add('ws-legacy-workarea');
  const financeLinks=el('nav',{class:'ws-tool-links','aria-label':'Finance tools'},...allowed.filter(m=>m.parent==='finances'||m.id==='giving').map(m=>el('a',{href:routeUrl(m.id),onclick:e=>{e.preventDefault();navigate(m.id);},text:m.label})));
  document.getElementById('tab-finances').prepend(financeLinks);

  async function navigate(id,key='',params={},historyMode='push') {
    const module=allowed.find(m=>m.id===id)||allowed[0];if(!module)return;
    // Module roots stay mounted, so changing modules preserves form values.
    const route={module:module.id,key,params};const seq=++navSequence;
    const url=routeUrl(module.id,key),query=new URLSearchParams(params);
    if(historyMode!=='none')history[historyMode==='replace'?'replaceState':'pushState']({workspace:route},'',url+(query.size?'?'+query:''));
    active=route;routing=true;
    try {
      drawer.querySelectorAll('[data-module]').forEach(a=>{a.setAttribute('aria-current',a.dataset.module===(module.parent||module.id)?'page':'false');});
      drawer.querySelectorAll('[data-folder]').forEach(b=>b.setAttribute('aria-pressed',String(module.id==='mail'&&b.dataset.folder===(params.folder||mailbox?.folder))));
      if(drawerOpen)setDrawer(false);
      canvas.querySelectorAll(':scope > *').forEach(n=>n.hidden=true);
      if(module.panel || params.editEvents) {
        oldLayout.hidden=false;
        const panel=params.editEvents?'tab-events':module.panel;
        activateMainSection(panel);
        if(module.profile){await new Promise(resolve=>setTimeout(resolve,0));document.querySelector('[data-profile-page="'+module.profile+'"]')?.click();}
        await window.MMWorkspaceLoadSection(panel);
      } else {
        let instance=instances.get(module.id);
        if(!instance) {
          instance=module.view==='mail'?{root:mailbox.root,open:r=>mailbox.open(r)}:module.view==='calendar'?calendar(ctx):module.view==='reports'?reports(ctx):module.view==='editor'?editor(ctx):await financeTool(ctx,module);
          instances.set(module.id,instance);canvas.append(instance.root);
        }
        if(seq!==navSequence)return;
        instance.root.hidden=false;
        if(module.view==='mail') {
          if(params.folder)mailbox.folder=params.folder;
          if(params.category)mailbox.category=params.category;
          if(params.q!==undefined)mailbox.q=params.q;
        }
        await instance.open(route);
      }
      if(seq===navSequence){document.title=module.label+' · Mount Moriah';canvas.focus({preventScroll:true});}
    } catch(error){notice(error.message,true);}
    finally{if(seq===navSequence)routing=false;}
  }
  window.MMWorkspace={navigate};
  window.addEventListener('popstate',()=>{const route=resolveRoute(location.pathname,location.hash);if(route)navigate(route.module,route.key,Object.fromEntries(new URLSearchParams(location.search)),'none');});
  window.addEventListener('hashchange',()=>{const route=resolveRoute('/admin',location.hash);if(route)navigate(route.module,route.key,{},'replace');});
  window.addEventListener('admin:section-activated',event=>{
    if(routing)return;
    const target=allowed.find(m=>m.panel===event.detail.sectionId);if(target)navigate(target.id);
  });
  document.addEventListener('click',event=>{
    const a=event.target.closest?.('a[href]');if(!a)return;
    const u=new URL(a.href,location.href);if(u.origin!==location.origin)return;
    const route=resolveRoute(u.pathname,u.hash);
    if(route&&u.pathname.startsWith('/admin')){event.preventDefault();navigate(route.module,route.key);}
  });
  const route=resolveRoute(location.pathname,location.hash)||{module:'mail',key:''};
  await navigate(route.module,route.key,Object.fromEntries(new URLSearchParams(location.search)),'replace');
  if('serviceWorker'in navigator)navigator.serviceWorker.register('/admin/service-worker.js',{scope:'/admin/'}).catch(error=>notice('App support could not be initialized: '+error.message,true));
}
window.addEventListener('admin:authenticated',e=>start(e.detail));
if(window.MMWorkspaceSession)start(window.MMWorkspaceSession);
