import {el,button,api,heading,showError,download,icon} from './shared.mjs';

const currency=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
const money=cents=>currency.format(Number(cents||0)/100);
const today=()=>new Date().toISOString().slice(0,10);
const emptyDraft=()=>({type:'income',date:today(),category:'',fund:'',amount:'',method:'',party:'',memo:''});
const text=value=>String(value??'');
const contains=(entry,q)=>[entry.date,entry.category,entry.fund,entry.method,entry.party,entry.memo].join(' ').toLowerCase().includes(q);

export function financeRecorder(ctx) {
  const root=el('section',{class:'ws-module ws-finance-recorder'});
  const body=el('div',{class:'ws-finance-body'});
  const tabs=el('div',{class:'ws-finance-tabs',role:'tablist','aria-label':'Church Finances sections'});
  const content=el('div',{class:'ws-finance-content'});
  const state={
    tab:'record',step:0,draft:emptyDraft(),dirty:false,editingId:'',saved:null,
    allRows:[],rows:[],meta:{categories:[],funds:[]},summary:{incomeCents:0,expenseCents:0,netCents:0},
    giving:{tithesCents:0,offeringsCents:0},filters:{q:'',type:'all',from:'',to:'',category:'',fund:'',method:''},
    reportRange:'week'
  };
  const tabButtons=new Map();

  for(const def of [['record','edit_note','Record Money'],['review','receipt_long','Review Transactions'],['reports','print','Reports & Printing']]){
    const btn=button(def[2],()=>requestTab(def[0]),{symbol:def[1]});
    btn.setAttribute('role','tab');btn.dataset.financeTab=def[0];tabs.append(btn);tabButtons.set(def[0],btn);
  }

  function can(permission){return ctx.permissions.includes(permission);}
  function notice(message){ctx.notice(message);}
  function setTab(id){
    state.tab=id;
    for(const pair of tabButtons){pair[1].setAttribute('aria-selected',String(pair[0]===id));pair[1].classList.toggle('ws-primary',pair[0]===id);}
  }
  function requestTab(id){
    if(id===state.tab)return;
    if(state.tab==='record'&&state.dirty&&!state.saved){
      confirmDialog('Discard unsaved entry?','Your unsaved finance entry will be cleared.',()=>{resetWizard();setTab(id);render();},{confirmText:'Discard',danger:true});
      return;
    }
    setTab(id);render();
  }
  function confirmDialog(title,message,onConfirm,options={}){
    const dialog=el('dialog',{class:'ws-dialog'});
    const form=el('form',{method:'dialog',class:'ws-dialog-card'});
    const input=options.inputLabel?el('textarea',{class:'ws-dialog-textarea','aria-label':options.inputLabel,placeholder:options.inputLabel,rows:'4'}):null;
    const cancel=el('button',{type:'submit',class:'ws-button'},icon('close'),el('span',{text:'Cancel'}));
    const ok=button(options.confirmText||'Confirm',()=>{
      if(input&&!text(input.value).trim()){input.focus();return;}
      dialog.close();onConfirm(input?text(input.value).trim():'');
    },{symbol:options.danger?'block':'check',primary:!options.danger});
    if(options.danger)ok.classList.add('ws-danger');
    form.append(el('h2',{text:title}),el('p',{class:'ws-muted',text:message}),input||'',el('div',{class:'ws-actions'},cancel,ok));
    dialog.append(form);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();
  }
  function params(filters={},limit=500){
    const q=new URLSearchParams({limit:String(limit)});
    for(const key of ['q','type','from','to','category','fund','method']){
      const value=filters[key];if(value&&value!=='all')q.set(key,value);
    }
    return q;
  }
  async function fetchFinance(filters={},limit=500){
    return api('/api/admin/workspace/finance?'+params(filters,limit).toString());
  }
  async function loadBase(){
    body.setAttribute('aria-busy','true');
    try{
      const data=await fetchFinance({},500);
      state.allRows=data.entries||[];state.meta=data.meta||state.meta;state.summary=data.summary||state.summary;state.giving=data.giving||state.giving;
      if(state.tab==='record')renderRecord();else render();
    }catch(error){showError(content,error,loadBase);}
    finally{body.setAttribute('aria-busy','false');}
  }
  function resetWizard(){
    state.step=0;state.draft=emptyDraft();state.dirty=false;state.editingId='';state.saved=null;
  }
  function field(label,node,hint=''){
    return el('label',{class:'ws-finance-field'},el('span',{text:label}),node,hint?el('small',{class:'ws-muted',text:hint}):null);
  }
  function selectControl(label,values,value='',required=true){
    const select=el('select',{'aria-label':label},el('option',{value:'',text:'Choose '+label.toLowerCase()+'…'}),...values.map(v=>el('option',{value:v,text:v})));
    select.value=value;if(required)select.required=true;return select;
  }
  function remember(key,node){
    const save=()=>{state.draft[key]=text(node.value);state.dirty=true;};
    node.addEventListener('input',save);node.addEventListener('change',save);return node;
  }
  function validateDetails(){
    if(!state.draft.date)return 'Choose a date.';
    if(!state.draft.category)return 'Choose a category.';
    if(!state.draft.fund)return 'Choose a fund.';
    if(!(Number(state.draft.amount)>0))return 'Enter an amount greater than zero.';
    return '';
  }
  function progress(){
    const list=el('ol',{class:'ws-finance-progress','aria-label':'Entry steps'});
    const labels=['Money Type','Details','Payment','Review'];
    labels.forEach((label,index)=>{
      const btn=button(index===0?'1 '+label:String(index+1),()=>{if(index<=state.step){state.step=index;renderRecord();}},{symbol:index===state.step?'radio_button_checked':'radio_button_unchecked'});
      btn.disabled=index>state.step;btn.setAttribute('aria-current',index===state.step?'step':'false');list.append(el('li',{},btn));
    });
    return list;
  }
  function incomeExpenseVisual(){
    const income=Math.max(0,Number(state.summary.incomeCents||0)),expense=Math.max(0,Number(state.summary.expenseCents||0)),total=income+expense,net=income-expense;
    const pct=total?Math.round(income/total*100):0;
    const donut=el('div',{class:'ws-finance-donut'+(total?'':' ws-finance-donut--empty'),role:'img','aria-label':'Income '+money(income)+', expenses '+money(expense)+', net '+money(net)});
    donut.style.setProperty('--income-angle',(total?income/total*360:0)+'deg');
    donut.append(el('div',{class:'ws-finance-donut-center'},el('span',{text:'Net'}),el('strong',{class:net<0?'ws-finance-net-value--negative':'ws-finance-net-value--positive',text:money(net)}),el('small',{text:net===0?'Income equals expenses':net>0?'More Income than Expenses':'More Expenses than Income'})));
    const legend=el('div',{class:'ws-finance-legend'},
      legendRow('income','Income',income,pct),legendRow('expense','Expenses',expense,total?100-pct:0));
    return el('section',{class:'ws-finance-visual','aria-label':'Income vs Expenses'},el('h2',{text:'Income vs Expenses'}),el('p',{class:'ws-muted',text:'All recorded entries'}),el('div',{class:'ws-finance-chart'},donut,legend));
  }
  function legendRow(kind,label,value,pct){
    return el('div',{class:'ws-finance-legend-row'},el('span',{class:'ws-finance-legend-dot ws-finance-legend-dot--'+kind,'aria-hidden':'true'}),el('span',{text:label}),el('strong',{text:money(value)}),el('small',{class:'ws-muted',text:'('+pct+'%)'}));
  }
  function renderRecord(){
    if(state.saved){renderSaved();return;}
    const wizard=el('section',{class:'ws-finance-wizard'});
    wizard.append(el('h2',{text:state.editingId?'Edit Transaction':'Record Money'}),progress());
    const panel=el('div',{class:'ws-finance-wizard-panel'});

    if(state.step===0){
      const received=button('Money Received',()=>{state.draft.type='income';state.dirty=true;renderRecord();},{symbol:'south_west',primary:state.draft.type==='income'});
      const spent=button('Money Spent',()=>{state.draft.type='expense';state.dirty=true;renderRecord();},{symbol:'north_east',primary:state.draft.type==='expense'});
      panel.append(el('h3',{text:'What are you recording?'}),el('div',{class:'ws-finance-direction'},received,spent),button('Continue',()=>{state.step=1;renderRecord();},{symbol:'arrow_forward',primary:true}));
    }
    if(state.step===1){
      const date=remember('date',el('input',{type:'date',value:state.draft.date,required:''}));
      const category=remember('category',selectControl('Category',state.meta.categories||[],state.draft.category));
      const fund=remember('fund',selectControl('Fund',state.meta.funds||[],state.draft.fund));
      const amount=remember('amount',el('input',{type:'number',min:'0.01',step:'0.01',inputmode:'decimal',value:state.draft.amount,placeholder:'0.00',required:''}));
      const actions=el('div',{class:'ws-actions'},button('Back',()=>{state.step=0;renderRecord();},{symbol:'arrow_back'}));
      if(can('finance.manage_lists'))actions.append(button('Manage Categories & Funds',openListManager,{symbol:'tune'}));
      actions.append(button('Continue',()=>{const err=validateDetails();if(err){notice(err);return;}state.step=2;renderRecord();},{symbol:'arrow_forward',primary:true}));
      panel.append(el('div',{class:'ws-finance-grid'},field(state.draft.type==='expense'?'Date spent':'Date received',date),field('Category',category),field('Fund',fund),field('Amount',amount)),actions);
    }
    if(state.step===2){
      const method=remember('method',selectControl('Payment method',['Cash','Check','Card','ACH / Bank','Online','Other'],state.draft.method,false));
      const party=remember('party',el('input',{type:'text',maxlength:'120',value:state.draft.party,placeholder:state.draft.type==='expense'?'Paid to':'Received from'}));
      const memo=remember('memo',el('textarea',{maxlength:'500',rows:'3',placeholder:'Memo / notes',text:state.draft.memo}));
      panel.append(el('div',{class:'ws-finance-grid'},field('Payment method',method,'Optional'),field(state.draft.type==='expense'?'Paid to':'Received from',party,'Optional'),field('Memo',memo,'Optional')),
        el('div',{class:'ws-actions'},button('Back',()=>{state.step=1;renderRecord();},{symbol:'arrow_back'}),button('Review Entry',()=>{state.step=3;renderRecord();},{symbol:'arrow_forward',primary:true})));
    }
    if(state.step===3){
      const review=el('dl',{class:'ws-finance-review'});
      const rows=[['Type',state.draft.type==='expense'?'Money Spent':'Money Received'],['Date',state.draft.date],['Category',state.draft.category],['Fund',state.draft.fund],['Amount',money(Math.round(Number(state.draft.amount||0)*100))],['Payment method',state.draft.method||'—'],[state.draft.type==='expense'?'Paid to':'Received from',state.draft.party||'—'],['Memo',state.draft.memo||'—']];
      for(const row of rows)review.append(el('dt',{text:row[0]}),el('dd',{text:row[1]}));
      panel.append(el('h3',{text:'Review this entry'}),review,el('div',{class:'ws-actions'},button('Back',()=>{state.step=2;renderRecord();},{symbol:'arrow_back'}),button(state.editingId?'Save Changes':'Save Entry',saveEntry,{symbol:'save',primary:true})));
    }
    wizard.append(panel);
    content.replaceChildren(el('div',{class:'ws-finance-top'},wizard,incomeExpenseVisual()));
  }
  async function saveEntry(){
    const err=validateDetails();if(err){notice(err);return;}
    try{
      const url=state.editingId?'/api/admin/workspace/finance/'+encodeURIComponent(state.editingId):'/api/admin/workspace/finance';
      const method=state.editingId?'PUT':'POST';
      const result=await api(url,{method,body:JSON.stringify(state.draft)});
      const id=state.editingId||result.id;
      state.saved={...state.draft,id,amountCents:Math.round(Number(state.draft.amount||0)*100),status:'posted'};
      state.dirty=false;state.editingId='';await loadBase();renderSaved();
    }catch(error){notice(error.message||String(error));}
  }
  function renderSaved(){
    const e=state.saved;
    content.replaceChildren(el('div',{class:'ws-finance-saved'},icon('check_circle'),el('h2',{text:'Entry Saved'}),el('p',{text:(e.type==='expense'?'Money Spent: ':'Money Received: ')+money(e.amountCents)}),
      el('div',{class:'ws-actions'},button('Print Receipt',()=>printReceipts([e]),{symbol:'print'}),button('Review Transaction',()=>{state.filters.q=e.party||e.category;state.saved=null;setTab('review');loadReview();},{symbol:'receipt_long'}),button('Record Another',()=>{resetWizard();renderRecord();},{symbol:'add',primary:true}))));
  }
  function openListManager(){
    const dialog=el('dialog',{class:'ws-dialog'}),form=el('form',{method:'dialog',class:'ws-dialog-card ws-finance-list-manager'});
    const categories=[...(state.meta.categories||[])],funds=[...(state.meta.funds||[])];
    function section(title,list){
      const input=el('input',{type:'text','aria-label':'Add '+title,placeholder:'Add '+title.toLowerCase().replace(/s$/,'')});
      const chips=el('div',{class:'ws-finance-chip-list'});
      function draw(){
        chips.replaceChildren(...list.map((value,index)=>{
          const remove=button('',()=>{if(list.length>1){list.splice(index,1);draw();}},{symbol:'close','aria-label':'Remove '+value,title:'Remove '+value});
          return el('span',{class:'ws-finance-chip'},el('span',{text:value}),remove);
        }));
      }
      draw();
      return el('section',{},el('h3',{text:title}),el('div',{class:'ws-inline-form'},input,button('Add',()=>{const value=text(input.value).trim();if(value&&!list.some(x=>x.toLowerCase()===value.toLowerCase())){list.push(value);list.sort((a,b)=>a.localeCompare(b));input.value='';draw();}},{symbol:'add'})),chips);
    }
    const cancel=el('button',{type:'submit',class:'ws-button',text:'Cancel'});
    const save=button('Save Lists',async()=>{try{const data=await api('/api/admin/workspace/finance/meta',{method:'PUT',body:JSON.stringify({categories,funds})});state.meta=data.meta;dialog.close();notice('Finance lists saved.');renderRecord();}catch(error){notice(error.message||String(error));}},{symbol:'save',primary:true});
    form.append(el('h2',{text:'Manage Categories & Funds'}),el('p',{class:'ws-muted',text:'Keep the simple recorder consistent without restoring the retired finance dashboard.'}),section('Categories',categories),section('Funds',funds),el('div',{class:'ws-actions'},cancel,save));
    dialog.append(form);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();
  }
  function queryFilters(){
    const q=params(state.filters,500);return q.toString();
  }
  async function loadReview(){
    body.setAttribute('aria-busy','true');
    try{
      const data=await fetchFinance(state.filters,500);state.rows=data.entries||[];state.meta=data.meta||state.meta;renderReview();
    }catch(error){showError(content,error,loadReview);}finally{body.setAttribute('aria-busy','false');}
  }
  function renderReview(){
    const wrap=el('div',{class:'ws-finance-review-view'});
    const search=el('input',{type:'search',placeholder:'Search transactions…','aria-label':'Search transactions',value:state.filters.q});
    search.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();state.filters.q=search.value;loadReview();}});
    const quick=el('div',{class:'ws-finance-direction'});
    for(const item of [['all','list','All'],['income','south_west','Money Received'],['expense','north_east','Money Spent']]){
      quick.append(button(item[2],()=>{state.filters.type=item[0];loadReview();},{symbol:item[1],primary:state.filters.type===item[0]}));
    }
    const filters=el('details',{class:'ws-finance-filters'},el('summary',{text:'Filters'}));
    const from=el('input',{type:'date',value:state.filters.from,'aria-label':'From date'}),to=el('input',{type:'date',value:state.filters.to,'aria-label':'Through date'});
    const cat=selectControl('Category',state.meta.categories||[],state.filters.category,false);cat.firstChild.textContent='All categories';
    const fund=selectControl('Fund',state.meta.funds||[],state.filters.fund,false);fund.firstChild.textContent='All funds';
    const method=selectControl('Payment method',['Cash','Check','Card','ACH / Bank','Online','Other'],state.filters.method,false);method.firstChild.textContent='All payment methods';
    const preset=(days)=>{
      const end=new Date(),start=new Date(end);start.setDate(end.getDate()-(days-1));
      from.value=start.toISOString().slice(0,10);to.value=end.toISOString().slice(0,10);
    };
    filters.append(el('div',{class:'ws-finance-filter-presets'},button('Last 7 Days',()=>preset(7),{symbol:'date_range'}),button('Last 30 Days',()=>preset(30),{symbol:'date_range'}),button('Last 90 Days',()=>preset(90),{symbol:'date_range'}),button('All Dates',()=>{from.value='';to.value='';},{symbol:'all_inclusive'})),
      el('div',{class:'ws-finance-filter-grid'},field('From',from),field('Through',to),field('Category',cat),field('Fund',fund),field('Payment method',method)),
      el('div',{class:'ws-actions'},button('Apply Filters',()=>{Object.assign(state.filters,{from:from.value,to:to.value,category:cat.value,fund:fund.value,method:method.value});loadReview();},{symbol:'filter_alt',primary:true}),button('Reset',()=>{state.filters={q:'',type:'all',from:'',to:'',category:'',fund:'',method:''};loadReview();},{symbol:'restart_alt'})));
    const tools=el('div',{class:'ws-finance-review-toolbar'},quick,el('div',{class:'ws-finance-search'},search,button('',()=>{state.filters.q=search.value;loadReview();},{symbol:'search','aria-label':'Search',title:'Search'})),filters);
    const table=el('table',{class:'ws-table ws-finance-table'},el('thead',{},el('tr',{},...['Date','Description','Money In','Money Out','Actions'].map(v=>el('th',{text:v})))));
    const tbody=el('tbody');
    for(const entry of state.rows){
      const detail=el('tr',{class:'ws-finance-detail-row',hidden:''},el('td',{colspan:'5'},entryDetails(entry)));
      const view=button('',()=>{detail.hidden=!detail.hidden;},{symbol:'visibility','aria-label':'View transaction',title:'View'});
      const edit=button('',()=>startEdit(entry),{symbol:'edit','aria-label':'Edit transaction',title:'Edit'});edit.disabled=entry.status==='voided'||!can('finance.edit_void');
      const receipt=button('Receipt',()=>printReceipts([entry]),{symbol:'print'});
      const voidBtn=button('Void',()=>voidEntry(entry),{symbol:'block'});voidBtn.disabled=entry.status==='voided'||!can('finance.edit_void');if(!voidBtn.disabled)voidBtn.classList.add('ws-danger');
      tbody.append(el('tr',{class:entry.status==='voided'?'ws-finance-row-voided':''},el('td',{text:entry.date}),el('td',{},entryDescription(entry)),el('td',{text:entry.type==='income'&&entry.status!=='voided'?money(entry.amountCents):''}),el('td',{text:entry.type==='expense'&&entry.status!=='voided'?money(entry.amountCents):''}),el('td',{},el('div',{class:'ws-actions ws-actions--compact'},view,edit,receipt,voidBtn))),detail);
    }
    table.append(tbody);
    const cards=el('div',{class:'ws-finance-mobile-cards'});
    for(const entry of state.rows){
      const details=entryDetails(entry);details.hidden=true;
      const view=button('View',()=>{details.hidden=!details.hidden;},{symbol:'visibility'});
      const edit=button('Edit',()=>startEdit(entry),{symbol:'edit'});edit.disabled=entry.status==='voided'||!can('finance.edit_void');
      const receipt=button('Receipt',()=>printReceipts([entry]),{symbol:'print'});
      const voidBtn=button('Void',()=>voidEntry(entry),{symbol:'block'});voidBtn.disabled=entry.status==='voided'||!can('finance.edit_void');if(!voidBtn.disabled)voidBtn.classList.add('ws-danger');
      cards.append(el('article',{class:'ws-finance-mobile-card '+(entry.status==='voided'?'ws-finance-row-voided':'')},
        el('div',{class:'ws-finance-mobile-card-head'},el('strong',{text:entry.category}),el('strong',{text:money(entry.amountCents)})),
        el('p',{class:'ws-muted',text:entry.date+' · '+[entry.fund,entry.method,entry.party].filter(Boolean).join(' · ')}),
        el('div',{class:'ws-actions'},view,edit,receipt,voidBtn),details));
    }
    wrap.append(el('div',{class:'ws-finance-section-title'},el('div',{},el('h2',{text:'Transaction History'}),el('p',{class:'ws-muted',text:state.rows.length+' matching transaction'+(state.rows.length===1?'':'s')+'.'}))),tools,state.rows.length?el('div',{class:'ws-finance-review-results'},el('div',{class:'ws-table-wrap'},table),cards):el('p',{class:'ws-empty',text:'No transactions match the current filters.'}));
    content.replaceChildren(wrap);
  }
  function entryDescription(entry){
    return el('div',{},el('strong',{text:entry.category+(entry.status==='voided'?' (Voided)':'')}),el('small',{class:'ws-muted',text:[entry.fund,entry.method,entry.party].filter(Boolean).join(' · ')}));
  }
  function entryDetails(entry){
    const grid=el('div',{class:'ws-finance-detail-grid'});
    const rows=[['Date',entry.date],['Type',entry.type==='expense'?'Money Spent':'Money Received'],['Category',entry.category],['Fund',entry.fund],['Payment method',entry.method||'—'],['From / To',entry.party||'—'],['Memo',entry.memo||'—'],['Status',entry.status||'posted']];
    if(entry.voidReason)rows.push(['Void reason',entry.voidReason]);
    for(const row of rows)grid.append(el('strong',{text:row[0]}),el('span',{text:row[1]}));return grid;
  }
  function startEdit(entry){
    state.draft={type:entry.type,date:entry.date,category:entry.category,fund:entry.fund,amount:(entry.amountCents/100).toFixed(2),method:entry.method,party:entry.party,memo:entry.memo};
    state.editingId=entry.id;state.step=1;state.dirty=false;state.saved=null;setTab('record');renderRecord();
  }
  function voidEntry(entry){
    confirmDialog('Void transaction?','The transaction will remain in history and be excluded from active totals.',async reason=>{
      try{await api('/api/admin/workspace/finance/'+encodeURIComponent(entry.id)+'/void',{method:'POST',body:JSON.stringify({reason})});notice('Transaction voided.');await loadBase();await loadReview();}catch(error){notice(error.message||String(error));}
    },{confirmText:'Void Transaction',danger:true,inputLabel:'Reason for voiding'});
  }
  function receiptNumber(entry,index){
    const digits=text(entry.id).replace(/\D/g,'');return 'MMMBC-'+(digits.slice(-4)||String(index+1).padStart(4,'0'));
  }
  function safeHtml(value){
    return text(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }
  function printWindow(title,html){
    const win=window.open('','_blank','width=900,height=700');if(!win){notice('Allow pop-ups to print.');return;}try{win.opener=null;}catch{}
    const css='body{font-family:Arial,sans-serif;color:#29231f;padding:28px}h1{font-size:22px}.receipt{border:1px solid #bbb;padding:22px;margin:0 0 24px;break-inside:avoid}.meta{display:grid;grid-template-columns:140px 1fr;gap:7px 14px}.meta strong{font-size:12px}.signature{margin-top:38px;border-top:1px solid #777;padding-top:8px;width:45%}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left}th{text-transform:uppercase;font-size:11px}@media print{button{display:none}}';
    win.document.write('<!doctype html><html><head><title>'+safeHtml(title)+'</title><style>'+css+'</style></head><body>'+html+'<script>setTimeout(function(){window.print()},150)<\/script></body></html>');win.document.close();
  }
  function printReceipts(entries){
    const rows=(entries||[]).filter(Boolean);if(!rows.length){notice('Select at least one transaction.');return;}
    let html='<h1>Mt. Moriah Missionary Baptist Church</h1><p>Finance receipt'+(rows.length===1?'':'s')+'</p>';
    rows.forEach((entry,index)=>{
      html+='<section class="receipt"><h2>Receipt '+safeHtml(receiptNumber(entry,index))+'</h2><div class="meta">';
      for(const row of [['Date',entry.date],['Type',entry.type==='expense'?'Money Spent':'Money Received'],['Category',entry.category],['Fund',entry.fund||'—'],['Amount',money(entry.amountCents)],['Payment Method',entry.method||'—'],['From / To',entry.party||'—'],['Memo',entry.memo||'—']])html+='<strong>'+safeHtml(row[0])+'</strong><span>'+safeHtml(row[1])+'</span>';
      html+='</div><div class="signature">Authorized Signature</div></section>';
    });
    printWindow('Finance Receipts',html);
  }
  function printHistory(entries){
    const rows=(entries||[]).filter(Boolean),income=rows.filter(e=>e.status!=='voided'&&e.type==='income').reduce((n,e)=>n+e.amountCents,0),expense=rows.filter(e=>e.status!=='voided'&&e.type==='expense').reduce((n,e)=>n+e.amountCents,0);
    let html='<h1>Mt. Moriah Missionary Baptist Church</h1><h2>Transaction History</h2><p>'+rows.length+' entries · Money Received '+safeHtml(money(income))+' · Money Spent '+safeHtml(money(expense))+' · Net '+safeHtml(money(income-expense))+'</p><table><thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Fund</th><th>Amount</th><th>Status</th></tr></thead><tbody>';
    for(const e of rows)html+='<tr><td>'+safeHtml(e.date)+'</td><td>'+safeHtml(e.type==='expense'?'Money Spent':'Money Received')+'</td><td>'+safeHtml(e.category+(e.party?' · '+e.party:''))+'</td><td>'+safeHtml(e.fund||'—')+'</td><td>'+safeHtml(money(e.amountCents))+'</td><td>'+safeHtml(e.status)+'</td></tr>';
    html+='</tbody></table>';printWindow('Transaction History',html);
  }
  function openReceiptSelector(){
    const dialog=el('dialog',{class:'ws-dialog'}),form=el('form',{method:'dialog',class:'ws-dialog-card ws-finance-receipt-picker'});
    const search=el('input',{type:'search',placeholder:'Search transactions…','aria-label':'Search receipt transactions'}),list=el('div',{class:'ws-finance-receipt-list'}),count=el('p',{class:'ws-muted'}),selected=new Set();
    function draw(){
      const q=text(search.value).toLowerCase(),rows=state.rows.filter(e=>!q||contains(e,q));list.replaceChildren(...rows.map(e=>{const cb=el('input',{type:'checkbox',value:e.id});cb.checked=selected.has(e.id);cb.addEventListener('change',()=>{cb.checked?selected.add(e.id):selected.delete(e.id);count.textContent=selected.size+' selected';});return el('label',{class:'ws-finance-receipt-item'},cb,el('span',{text:e.date+' · '+e.category+' · '+money(e.amountCents)}));}));count.textContent=selected.size+' selected';
    }
    search.addEventListener('input',draw);
    form.append(el('h2',{text:'Print Selected Receipts'}),search,el('div',{class:'ws-actions'},button('Select All',()=>{for(const e of state.rows)selected.add(e.id);draw();},{symbol:'done_all'}),button('Clear',()=>{selected.clear();draw();},{symbol:'clear_all'})),count,list,el('div',{class:'ws-actions'},el('button',{type:'submit',class:'ws-button',text:'Cancel'}),button('Print Selected',()=>printReceipts(state.rows.filter(e=>selected.has(e.id))),{symbol:'print',primary:true})));
    dialog.append(form);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();draw();
  }
  function dateRange(kind){
    const end=new Date(),start=new Date(end);if(kind==='week')start.setDate(end.getDate()-6);else start.setDate(1);return {from:start.toISOString().slice(0,10),to:end.toISOString().slice(0,10)};
  }
  async function loadReports(){
    const range=dateRange(state.reportRange);
    try{
      const data=await fetchFinance({from:range.from,to:range.to},500);renderReports(data,range);
    }catch(error){showError(content,error,loadReports);}
  }
  function chartCard(title,a,b,labels,period){
    const total=a+b,angle=total?a/total*360:0,donut=el('div',{class:'ws-finance-donut'+(total?'':' ws-finance-donut--empty'),role:'img','aria-label':title+' '+money(a)+' and '+money(b)});
    donut.style.setProperty('--income-angle',angle+'deg');donut.append(el('div',{class:'ws-finance-donut-center'},el('strong',{text:money(labels.total?total:a-b)}),el('small',{text:labels.total?'Total Giving':'Net Total'})));
    return el('section',{class:'ws-finance-chart-card'},el('h3',{text:title}),el('p',{class:'ws-muted',text:period}),donut,el('div',{class:'ws-finance-legend'},legendRow('income',labels.a,a,total?Math.round(a/total*100):0),legendRow('expense',labels.b,b,total?Math.round(b/total*100):0)));
  }
  function reportAction(title,description,control){
    return el('section',{class:'ws-finance-report-action'},el('div',{},el('h3',{text:title}),el('p',{class:'ws-muted',text:description})),control);
  }
  function renderReports(data,range){
    state.rows=data.entries||[];
    const reportSummary=data.summary||{incomeCents:0,expenseCents:0,netCents:0};
    const reportGiving=data.giving||{tithesCents:0,offeringsCents:0};
    const rangeButtons=el('div',{class:'ws-actions'},button('This Week',()=>{state.reportRange='week';loadReports();},{primary:state.reportRange==='week'}),button('This Month',()=>{state.reportRange='month';loadReports();},{primary:state.reportRange==='month'}));
    const exportControls=el('div',{class:'ws-actions'},button('CSV',exportCsv,{symbol:'download'}),button('Google Sheets',googleSheetsHandoff,{symbol:'table_view'}));
    const actions=el('div',{class:'ws-finance-report-actions'},reportAction('Print Transaction History','Prints the transaction list using your current report range.',button('Print Transaction History',()=>printHistory(state.rows),{symbol:'print',primary:true})),reportAction('Print Selected Receipts','Search and select one, multiple, or all transactions to print as receipts.',button('Print Selected Receipts',openReceiptSelector,{symbol:'receipt_long',primary:true})),reportAction('Export Transactions','Export the current transaction list as CSV or into a new Google Sheet.',exportControls));
    const charts=el('div',{class:'ws-finance-report-charts'},chartCard('Money Flow',reportSummary.incomeCents||0,reportSummary.expenseCents||0,{a:'Money Received',b:'Money Spent'},range.from+' through '+range.to),chartCard('Giving Breakdown',reportGiving.tithesCents||0,reportGiving.offeringsCents||0,{a:'Tithes',b:'Offerings',total:true},state.reportRange==='week'?'This Week':'This Month'));
    content.replaceChildren(el('div',{class:'ws-finance-reports'},el('div',{class:'ws-finance-section-title'},el('div',{},el('h2',{text:'Reports & Printing'}),el('p',{class:'ws-muted',text:'Lightweight operational reports only.'})),rangeButtons),el('div',{class:'ws-finance-report-layout'},actions,charts)));
  }
  function exportCsv(){
    if(!can('finance.export')){notice('You do not have permission to export finance entries.');return;}
    const range=dateRange(state.reportRange);download('/api/admin/workspace/finance/export.csv?'+params({from:range.from,to:range.to},500).toString());
  }
  async function googleSheetsHandoff(){
    if(!can('finance.export')){notice('You do not have permission to export finance entries.');return;}
    const rows=[['Date','Type','Status','Category','Fund','Payment Method','From / To','Memo','Amount'],...state.rows.map(e=>[e.date,e.type,e.status,e.category,e.fund,e.method,e.party,e.memo,(e.amountCents/100).toFixed(2)])];
    const tsv=rows.map(row=>row.map(v=>text(v).replaceAll('\t',' ')).join('\t')).join('\n');
    const sheet=window.open('https://sheets.new','_blank','noopener,noreferrer');
    try{
      await navigator.clipboard.writeText(tsv);
      notice(sheet?'Transactions copied. Paste them into the new Google Sheet.':'Transactions copied. Open Google Sheets and paste them into a new sheet.');
    }catch{
      exportCsv();notice('CSV downloaded. Import it into Google Sheets.');
    }
  }
  function render(){
    if(state.tab==='record'){renderRecord();return;}
    if(state.tab==='review'){loadReview();return;}
    if(state.tab==='reports'){loadReports();return;}
  }

  const guardNavigation=event=>{
    const link=event.target?.closest?.('a.ws-nav-link');
    if(!link||!state.dirty||state.saved||state.tab!=='record')return;
    event.preventDefault();event.stopImmediatePropagation();
    confirmDialog('Discard unsaved entry?','Your unsaved finance entry will be cleared before leaving Church Finances.',()=>{
      resetWizard();link.click();
    },{confirmText:'Discard',danger:true});
  };
  document.addEventListener('click',guardNavigation,true);
  window.addEventListener('beforeunload',event=>{if(state.dirty&&!state.saved){event.preventDefault();event.returnValue='';}});

  setTab('record');body.append(tabs,content);
  root.append(heading('Church Finances','Record gifts and expenses, review transactions, and print lightweight reports.',button('Refresh',()=>{if(state.tab==='review')loadReview();else if(state.tab==='reports')loadReports();else loadBase();},{symbol:'refresh'})),body);
  loadBase();
  return {root,open:async route=>{const requested=route?.params?.view||route?.key||'';if(['record','review','reports'].includes(requested))setTab(requested);await loadBase();render();}};
}
