import {el,button,api,heading,showError,statusLabel,download} from './shared.mjs';

export function calendar(ctx) {
  const root=el('section',{class:'ws-module'}),body=el('div'),month=el('input',{type:'month','aria-label':'Schedule month',value:new Date().toISOString().slice(0,7)});
  let dateFilter='';
  async function load() {
    const from=month.value+'-01',last=new Date(Number(month.value.slice(0,4)),Number(month.value.slice(5)),0).getDate(),to=month.value+'-'+last;
    body.setAttribute('aria-busy','true');
    try {
      const data=await api('/api/admin/workspace/schedule?'+new URLSearchParams({from,to}));
      const records=[...data.events.map(e=>({date:e.date,time:e.time,title:e.title,type:'Church event',status:'Scheduled',id:e.id})),
        ...data.rentals.map(r=>({date:r.date,time:r.timeFrom+' – '+r.timeTo,title:r.purpose,requester:r.requester,type:r.facilities.join(', ')||'Facility rental',status:r.status,id:r.id,rental:true}))].sort((a,b)=>a.date.localeCompare(b.date)||a.time.localeCompare(b.time));
      const grid=el('div',{class:'ws-calendar','aria-label':'Monthly schedule'}),year=Number(month.value.slice(0,4)),m=Number(month.value.slice(5))-1;
      for(const day of ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])grid.append(el('strong',{class:'ws-calendar-weekday',text:day}));
      for(let i=0;i<new Date(year,m,1).getDay();i++)grid.append(el('div',{class:'ws-calendar-blank'}));
      for(let d=1;d<=last;d++) {
        const date=month.value+'-'+String(d).padStart(2,'0');const day=el('div',{class:'ws-calendar-day'+(date===dateFilter?' ws-selected':'')},el('strong',{text:String(d)}));
        for(const r of records.filter(r=>r.date===date))day.append(button(r.time+' '+r.title,()=>r.rental?ctx.navigate('rentals','facility_rental:'+r.id):ctx.legacyEvents(),{class:'ws-calendar-item '+(r.rental?'ws-rental-'+r.status:'')}));
        grid.append(day);
      }
      const table=el('table',{class:'ws-table'},el('thead',{},el('tr',{},...['Date','Time','Event / purpose','Facility / type','Status','Record'].map(v=>el('th',{text:v})))));
      const tbody=el('tbody');
      for(const r of records)tbody.append(el('tr',{},...([r.date,r.time,r.title,r.type,statusLabel(r.status)].map(v=>el('td',{text:v}))),el('td',{},button(r.rental?'Open Rental':'Edit Event',()=>r.rental?ctx.navigate('rentals','facility_rental:'+r.id):ctx.legacyEvents()))));
      table.append(tbody);body.replaceChildren(grid,el('h2',{text:'Agenda'}),records.length?el('div',{class:'ws-table-wrap'},table):el('p',{class:'ws-empty',text:'No events or rentals this month.'}));
      if(records.length>=500)body.append(el('p',{text:'This view is limited to 500 records per source. Choose a shorter range to review very busy schedules.'}));
    }catch(error){showError(body,error,load);}finally{body.setAttribute('aria-busy','false');}
  }
  month.addEventListener('change',load);
  root.append(heading('Calendar / Schedule','Church events and requested rentals share one schedule. Times are local to the church in Paducah.',month,button('Refresh',load,{symbol:'refresh'}),ctx.permissions.includes('events.manage')?button('Manage church events',()=>ctx.legacyEvents(),{primary:true}):null),body);
  return {root,open:async route=>{if(route.params?.date){month.value=route.params.date.slice(0,7);dateFilter=route.params.date;}await load();}};
}

export function reports(ctx) {
  const root=el('section',{class:'ws-module'}),body=el('div'),range=el('select',{'aria-label':'Report date range'},...[[7,'Last 7 days'],[30,'Last 30 days'],[90,'Last 90 days']].map(([value,label])=>el('option',{value,text:label})));range.value='30';
  const from=el('input',{type:'date','aria-label':'From date'}),to=el('input',{type:'date','aria-label':'Through date'});
  function dates(){to.value=new Date().toISOString().slice(0,10);from.value=new Date(Date.now()-(Number(range.value)-1)*86400000).toISOString().slice(0,10);}dates();
  const query=()=>new URLSearchParams({from:from.value,to:to.value});
  async function load() {
    body.setAttribute('aria-busy','true');
    try {
      const data=await api('/api/admin/workspace/reports?'+query());
      const sections=[];
      for(const [name,rows]of Object.entries(data.sections)) {
        const table=el('table',{class:'ws-table'},el('thead',{},el('tr',{},...['Type','Status','Count',...(name==='finance'?['Amount']:name==='newsletter'?['Accepted recipients']:[])].map(text=>el('th',{text})))));
        table.append(el('tbody',{},...rows.map(r=>el('tr',{},el('td',{text:r.type||name}),el('td',{text:statusLabel(r.status)}),el('td',{text:String(r.count)}),name==='finance'?el('td',{text:new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(r.amountCents)/100)}):name==='newsletter'?el('td',{text:String(r.acceptedCount||0)}):null))));
        sections.push(el('details',{class:'ws-report-section',open:''},el('summary',{text:name[0].toUpperCase()+name.slice(1)+' · '+rows.reduce((s,r)=>s+r.count,0)+' records'}),rows.length?el('div',{class:'ws-table-wrap'},table):el('p',{text:'No activity in this date range.'})));
      }
      body.replaceChildren(el('p',{class:'ws-muted',text:'Counts come from stored records for '+data.from+' through '+data.to+'. Accepted by the email service does not confirm delivery.'}),...sections);
    }catch(error){showError(body,error,load);}finally{body.setAttribute('aria-busy','false');}
  }
  range.addEventListener('change',()=>{dates();load();});
  root.append(heading('Reports','Submission, rental, newsletter, and authorized financial activity.',range,from,to,button('Refresh',load,{symbol:'refresh'}),button('Export CSV',()=>download('/api/admin/workspace/reports?'+query()+'&format=csv'),{symbol:'download'})),body);
  return {root,open:load};
}

export function editor(ctx) {
  const root=el('section',{class:'ws-module'}),body=el('div'),pages=el('select',{'aria-label':'Website page'}),status=el('p',{class:'ws-status',role:'status'});
  const cached=new Map(),dirtyPages=new Set();let current='',state=null,dirty=false,writing=false,loadSequence=0;
  const storageKey=page=>'mmmbc:editor:'+ctx.user.id+':'+page;
  function persist(){if(!state)return;try{sessionStorage.setItem(storageKey(current),JSON.stringify({version:state.draft.version,fields:state.draft.fields}));}catch{/* server draft still available */}}
  function control(field,value,change) {
    if(field.type==='boolean')return el('input',{type:'checkbox',...(value?{checked:''}:{}),onchange:e=>change(e.target.checked)});
    if(field.type==='select'||field.type==='weekday') {
      const options=field.options||['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const select=el('select',{onchange:e=>change(e.target.value)},...options.map(o=>el('option',{value:typeof o==='object'?o.value:o,text:typeof o==='object'?o.label:o})));select.value=value||'';return select;
    }
    if(field.type==='collection') {
      const wrap=el('div',{class:'ws-editor-collection'}),items=Array.isArray(value)?value:[];
      const redraw=()=>{wrap.replaceChildren(...items.map((item,index)=>el('fieldset',{},el('legend',{text:(field.itemLabel||'Item')+' '+(index+1)}),...Object.entries(field.itemFields||{}).map(([key,definition])=>el('label',{},el('span',{text:definition.label||key}),control(definition,item[key],v=>{item[key]=v;change(items);}))),button('Remove',()=>{items.splice(index,1);change(items);redraw();},{symbol:'delete'}))),button('Add '+(field.itemLabel||'item'),()=>{if(items.length>=(field.maxItems||100))return;items.push({});change(items);redraw();},{symbol:'add'}));};redraw();return wrap;
    }
    const textarea=['textarea','rich_text'].includes(field.type);
    const input=el(textarea?'textarea':'input',{...(textarea?{rows:'4'}:{type:({image:'url',telephone:'tel',number:'number',time:'time',email:'email',url:'text'})[field.type]||'text'}),maxlength:field.maxLength,min:field.min,max:field.max,oninput:e=>change(field.type==='number'?Number(e.target.value):e.target.value)});
    input.value=value ?? '';
    if(field.type==='image') {
      const upload=el('input',{type:'file',accept:'image/jpeg,image/png,image/webp,image/gif','aria-label':'Upload '+field.label,onchange:async e=>{
        const file=e.target.files[0];if(!file)return;const data=new FormData();data.append('image',file);
        try{const result=await api('/api/admin/site-pages/'+current+'/media',{method:'POST',body:data});input.value=result.url;change(result.url);}catch(error){status.textContent=error.message;}
      }});
      return el('div',{},input,upload);
    }
    if(field.type==='rich_text')return el('div',{},input,el('small',{text:'Supported formatting: paragraphs, bold, italic, and links.'}));
    return input;
  }
  async function load(page) {
    if(writing)return;persist();const sequence=++loadSequence;current=page;state=null;dirty=dirtyPages.has(page);body.inert=true;
    try{
      const next=cached.get(page)||await api('/api/admin/site-pages/'+encodeURIComponent(page));
      if(sequence!==loadSequence)return;state=next;
      if(!cached.has(page)) {try{const local=JSON.parse(sessionStorage.getItem(storageKey(page)));if(local&&local.version===state.draft.version&&JSON.stringify(local.fields)!==JSON.stringify(state.draft.fields)){state.draft.fields=local.fields;dirty=true;dirtyPages.add(page);}}catch{}}
      cached.set(page,state);pages.value=page;
      body.replaceChildren(...Object.entries(state.fields).map(([key,field])=>el('div',{class:'ws-editor-field'},el('label',{},el('span',{text:field.label||key}),control(field,state.draft.fields[key],v=>{state.draft.fields[key]=v;dirty=true;dirtyPages.add(current);persist();status.textContent='Unsaved changes preserved in this browser.';})))));
      status.textContent='Draft version '+state.draft.version+' · Published version '+state.published.version+(dirty?' · Unsaved changes restored.':'');
    }catch(error){if(sequence===loadSequence)showError(body,error,()=>load(page));}finally{if(sequence===loadSequence)body.inert=false;}
  }
  async function save() {
    if(!state||writing)return false;writing=true;status.textContent='Saving draft…';
    try {const data=await api('/api/admin/site-pages/'+current+'/draft',{method:'PUT',body:JSON.stringify({fields:state.draft.fields,baseVersion:state.draft.version})});state.draft=data.draft;dirty=false;dirtyPages.delete(current);persist();status.textContent='Draft saved. Version '+data.draft.version;return true;}
    catch(error){status.textContent=error.message;return false;}finally{writing=false;}
  }
  async function publish() {
    if(writing||!confirm('Publish this page’s saved changes to the public church website?'))return;
    if(dirty&&!await save())return;writing=true;
    try{const data=await api('/api/admin/site-pages/'+current+'/publish',{method:'POST',body:JSON.stringify({baseVersion:state.draft.version})});state.published=data.published;status.textContent='Published version '+data.published.version+'.';}
    catch(error){status.textContent=error.message;}finally{writing=false;}
  }
  pages.addEventListener('change',()=>load(pages.value));
  window.addEventListener('beforeunload',e=>{if(writing){e.preventDefault();e.returnValue='';}});
  root.append(heading('Site Editor','Edit page content without changing the public site’s design.',pages,button('Save Draft',save,{primary:true}),button('Publish',publish),button('Restore Previous',async()=>{
    if(writing||!current||!confirm('Restore the previous published version on the public website?'))return;
    try{await api('/api/admin/site-pages/'+current+'/restore-previous',{method:'POST',body:'{}'});cached.delete(current);await load(current);status.textContent='Previous published version restored.';}catch(error){status.textContent=error.message;}
  })),status,body);
  async function open(){if(current)return;try{const data=await api('/api/admin/site-pages');pages.replaceChildren(...data.pages.map(p=>el('option',{value:p.page,text:p.label})));await load(data.pages[0].page);}catch(error){showError(body,error,open);}}
  return {root,open};
}

export async function financeTool(ctx,module) {
  const root=el('section',{class:'ws-module ws-finance-tool'}),body=el('div');
  root.append(heading(module.label,'Church finance operations',button('Finances',()=>ctx.navigate('finances'),{symbol:'arrow_back'})),body);
  let initialized=false;
  async function load() {
    if(initialized)return;
    try {
      const response=await fetch('/admin/workspace-tools/'+module.tool+'.html',{credentials:'same-origin'});
      if(!response.ok)throw Error('This finance tool could not be loaded.');
      // Only repository-owned static markup is parsed; scripts and navigation
      // are removed at build time. All dynamic data stays inside the existing APIs.
      const doc=new DOMParser().parseFromString(await response.text(),'text/html');
      body.replaceChildren(...Array.from(doc.body.childNodes));
      if(module.tool==='envelopes')await window.MMEnvelopeDesigner.mount(body);
      else await window.MMFinanceTools.mount(body,module.tool,ctx);
      initialized=true;
    }catch(error){showError(body,error,load);}
  }
  return {root,open:load};
}
