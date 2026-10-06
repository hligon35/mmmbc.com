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



export function financeRecorder(ctx) {
  const root=el('section',{class:'ws-module ws-finance-recorder'});
  const body=el('div',{class:'ws-finance-body'});
  const form=el('form',{class:'ws-finance-form','aria-label':'Record church money'});
  const direction=el('div',{class:'ws-finance-direction',role:'group','aria-label':'Transaction type'});
  const income=button('Money Received',()=>setType('income'),{symbol:'south_west',primary:true,'aria-pressed':'true'});
  const expense=button('Money Spent',()=>setType('expense'),{symbol:'north_east','aria-pressed':'false'});
  direction.append(income,expense);
  const type=el('input',{type:'hidden',name:'type',value:'income'});
  const date=el('input',{type:'date',name:'date',required:'',value:new Date().toISOString().slice(0,10)});
  const category=el('input',{type:'text',name:'category',maxlength:'120',placeholder:'Tithes, Offering, Utilities…',required:''});
  const fund=el('input',{type:'text',name:'fund',maxlength:'120',placeholder:'General Fund'});
  const method=el('select',{name:'method'},
    ...['','Cash','Check','Card','ACH / Bank','Online','Other'].map(v=>el('option',{value:v,text:v||'Payment method (optional)'})));
  const party=el('input',{type:'text',name:'party',maxlength:'120',placeholder:'Received from / Paid to'});
  const amount=el('input',{type:'number',name:'amount',min:'0.01',step:'0.01',inputmode:'decimal',placeholder:'0.00',required:''});
  const memo=el('input',{type:'text',name:'memo',maxlength:'500',placeholder:'Memo / notes'});
  const status=el('div',{class:'ws-status',role:'status','aria-live':'polite'});
  const save=el('button',{type:'submit',class:'ws-button ws-primary'},el('span',{class:'material-icons-round ws-icon','aria-hidden':'true',text:'save'}),el('span',{text:'Save Entry'}));
  const field=(label,input)=>el('label',{class:'ws-finance-field'},el('span',{text:label}),input);
  form.append(
    type,direction,
    el('div',{class:'ws-finance-grid'},
      field('Date',date),field('Category',category),field('Fund',fund),field('Payment method',method),
      field('From / To',party),field('Amount',amount),field('Memo',memo)
    ),
    el('div',{class:'ws-actions'},save,button('Clear',reset,{symbol:'restart_alt'})),
    status
  );

  const visual=el('section',{class:'ws-finance-visual','aria-labelledby':'wsFinanceVisualTitle'});
  const history=el('div',{class:'ws-finance-history'});
  const money=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(cents||0)/100);

  function setType(value){
    type.value=value;
    income.setAttribute('aria-pressed',String(value==='income'));
    expense.setAttribute('aria-pressed',String(value==='expense'));
    income.classList.toggle('ws-primary',value==='income');
    expense.classList.toggle('ws-primary',value==='expense');
  }

  function reset(){
    form.reset();type.value='income';date.value=new Date().toISOString().slice(0,10);setType('income');status.textContent='';
  }

  function renderIncomeExpenseVisual(summary={}) {
    const incomeCents=Math.max(0,Number(summary.incomeCents||0));
    const expenseCents=Math.max(0,Number(summary.expenseCents||0));
    const total=incomeCents+expenseCents;
    const net=incomeCents-expenseCents;
    const incomePercent=total?Math.round((incomeCents/total)*100):0;
    const expensePercent=total?100-incomePercent:0;
    const angle=total?(incomeCents/total)*360:0;

    const donut=el('div',{
      class:'ws-finance-donut'+(total?'':' ws-finance-donut--empty'),
      role:'img',
      'aria-label':`Income ${money(incomeCents)} (${incomePercent} percent), expenses ${money(expenseCents)} (${expensePercent} percent), net ${money(net)}`
    });
    donut.style.setProperty('--income-angle',angle+'deg');

    const netValue=el('strong',{class:'ws-finance-net-value '+(net<0?'ws-finance-net-value--negative':'ws-finance-net-value--positive'),text:money(net)});
    donut.append(el('div',{class:'ws-finance-donut-center'},el('span',{text:'Net'}),netValue,
      el('small',{text:net===0?'Income equals expenses':net>0?'More Income than Expenses':'More Expenses than Income'})));

    const legend=el('div',{class:'ws-finance-legend'},
      el('div',{class:'ws-finance-legend-row'},
        el('span',{class:'ws-finance-legend-dot ws-finance-legend-dot--income','aria-hidden':'true'}),
        el('span',{class:'ws-finance-legend-label',text:'Income'}),
        el('strong',{text:money(incomeCents)}),
        el('span',{class:'ws-finance-legend-percent',text:`(${incomePercent}%)`})
      ),
      el('div',{class:'ws-finance-legend-row'},
        el('span',{class:'ws-finance-legend-dot ws-finance-legend-dot--expense','aria-hidden':'true'}),
        el('span',{class:'ws-finance-legend-label',text:'Expenses'}),
        el('strong',{text:money(expenseCents)}),
        el('span',{class:'ws-finance-legend-percent',text:`(${expensePercent}%)`})
      )
    );

    visual.replaceChildren(
      el('h2',{id:'wsFinanceVisualTitle',text:'Income vs Expenses'}),
      el('p',{class:'ws-muted ws-finance-visual-period',text:'All recorded entries'}),
      el('div',{class:'ws-finance-chart'},donut,legend)
    );
  }

  async function load(){
    body.setAttribute('aria-busy','true');
    try{
      const data=await api('/api/admin/workspace/finance?limit=100');
      const rows=Array.isArray(data.entries)?data.entries:[];
      renderIncomeExpenseVisual(data.summary||{});

      const table=el('table',{class:'ws-table'},el('thead',{},el('tr',{},...['Date','Type','Category','Fund','From / To','Amount','Memo'].map(v=>el('th',{text:v})))));
      const tbody=el('tbody');
      for(const row of rows)tbody.append(el('tr',{},
        el('td',{text:row.date}),el('td',{text:row.type==='expense'?'Money Spent':'Money Received'}),
        el('td',{text:row.category||'—'}),el('td',{text:row.fund||'—'}),el('td',{text:row.party||'—'}),
        el('td',{text:(row.type==='expense'?'-':'')+money(row.amountCents)}),el('td',{text:row.memo||'—'})
      ));
      table.append(tbody);
      history.replaceChildren(el('h2',{text:'Recent Transactions'}),rows.length?el('div',{class:'ws-table-wrap'},table):el('p',{class:'ws-empty',text:'No money entries have been recorded yet.'}));
    }catch(error){
      showError(history,error,load);
      visual.replaceChildren(el('h2',{id:'wsFinanceVisualTitle',text:'Income vs Expenses'}),el('p',{class:'ws-empty',text:'Financial totals are temporarily unavailable.'}));
    }finally{body.setAttribute('aria-busy','false');}
  }

  form.addEventListener('submit',async event=>{
    event.preventDefault();status.textContent='Saving…';save.disabled=true;
    try{
      const fd=new FormData(form);
      await api('/api/admin/workspace/finance',{method:'POST',body:JSON.stringify({
        type:type.value,date:String(fd.get('date')||''),category:String(fd.get('category')||''),
        fund:String(fd.get('fund')||''),method:String(fd.get('method')||''),party:String(fd.get('party')||''),
        amount:String(fd.get('amount')||''),memo:String(fd.get('memo')||'')
      })});
      ctx.notice('Money entry saved.');
      reset();await load();
    }catch(error){status.textContent=error.message||String(error);}
    finally{save.disabled=false;}
  });

  renderIncomeExpenseVisual();
  body.append(el('div',{class:'ws-finance-top'},form,visual),history);
  root.append(heading('Church Finances','Simple money recording only. Advanced finance dashboards and accounting tools remain retired.',button('Refresh',load,{symbol:'refresh'})),body);
  return {root,open:load};
}
