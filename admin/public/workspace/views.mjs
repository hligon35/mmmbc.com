import {el,button,api,heading,showError,statusLabel,download} from './shared.mjs';
export {financeRecorder} from './finance.mjs';

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
        const table=el('table',{class:'ws-table'},el('thead',{},el('tr',{},...['Type','Status','Count',...(name==='newsletter'?['Accepted recipients']:[])].map(text=>el('th',{text})))));
        table.append(el('tbody',{},...rows.map(r=>el('tr',{},el('td',{text:r.type||name}),el('td',{text:statusLabel(r.status)}),el('td',{text:String(r.count)}),name==='newsletter'?el('td',{text:String(r.acceptedCount||0)}):null))));
        sections.push(el('details',{class:'ws-report-section',open:''},el('summary',{text:name[0].toUpperCase()+name.slice(1)+' · '+rows.reduce((s,r)=>s+r.count,0)+' records'}),rows.length?el('div',{class:'ws-table-wrap'},table):el('p',{text:'No activity in this date range.'})));
      }
      body.replaceChildren(el('p',{class:'ws-muted',text:'Counts come from stored records for '+data.from+' through '+data.to+'. Accepted by the email service does not confirm delivery.'}),...sections);
    }catch(error){showError(body,error,load);}finally{body.setAttribute('aria-busy','false');}
  }
  range.addEventListener('change',()=>{dates();load();});
  root.append(heading('Reports','Submission, rental, newsletter, and authorized financial activity.',range,from,to,button('Refresh',load,{symbol:'refresh'}),button('Export CSV',()=>download('/api/admin/workspace/reports?'+query()+'&format=csv'),{symbol:'download'})),body);
  return {root,open:load};
}



