import {el,button,api,showError,time} from './shared.mjs';
const ENDPOINT='/api/admin/workspace/finance/zeffy';
const date=value=>value?time(value):'—';
function amount(item) {
  if(item.amountCents!==null) {
    try{return new Intl.NumberFormat('en-US',{style:'currency',currency:item.currency}).format(item.amountCents/100);}catch{}
  }
  return item.reportedAmount?item.reportedAmount+' '+item.currency+' (API units)':'Unavailable';
}
export function zeffyDonations(ctx) {
  const root=el('section',{class:'ws-zeffy'});
  const state={page:1,q:'',status:'',data:null,busy:false,request:0};
  const canSync=ctx.permissions.includes('giving.sync');
  async function load() {
    const request=++state.request;
    root.setAttribute('aria-busy','true');
    if(!state.data)root.replaceChildren(el('p',{text:'Loading Zeffy donations…',role:'status'}));
    try {
      const params=new URLSearchParams({page:String(state.page),q:state.q,status:state.status});
      const data=await api(ENDPOINT+'?'+params);
      if(request!==state.request)return;
      state.data=data;render();
    }catch(error){if(request===state.request)showError(root,error,load);}
    finally{if(request===state.request)root.setAttribute('aria-busy','false');}
  }
  async function sync() {
    if(state.busy)return;
    state.busy=true;render();
    try {
      const result=await api(ENDPOINT+'/sync',{method:'POST',body:'{}'});
      ctx.notice(result.busy?'Sync is running or waiting for its retry window.':result.complete?'Zeffy donations reconciled.':'Import started. The next scheduled sync will continue the remaining pages.');
    }catch(error){ctx.notice(error.message);}
    finally{state.busy=false;await load();}
  }
  async function campaigns() {
    const dialog=el('dialog',{class:'ws-dialog'}),content=el('div',{class:'ws-dialog-card'});
    const list=el('div'),close=button('Close',()=>dialog.close(),{symbol:'close'});
    content.append(el('h2',{text:'Zeffy Campaign IDs'}),el('p',{text:'Choose only the donation campaigns to import. Match the title to your giving form.'}),list,close);
    dialog.append(content);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();
    let cursor='',loading=false;
    async function next() {
      if(loading)return;loading=true;
      const pending=el('p',{text:'Loading campaigns…',role:'status'});list.append(pending);
      try {
        const data=await api(ENDPOINT+'/campaigns?'+new URLSearchParams({cursor}));pending.remove();
        list.querySelector('[data-more]')?.remove();
        for(const campaign of data.items)list.append(el('p',{},el('strong',{text:campaign.title}),el('br'),el('code',{text:campaign.id})));
        if(!data.items.length&&!cursor)list.append(el('p',{text:'No campaigns found in this organization.'}));
        cursor=data.nextCursor;
        if(data.hasMore){const more=button('More campaigns',next,{symbol:'expand_more'});more.dataset.more='true';list.append(more);}
      }catch(error){pending.remove();list.append(el('p',{role:'alert',text:error.message}),button('Retry',next,{symbol:'refresh'}));}
      finally{loading=false;}
    }
    next();
  }
  function render() {
    const {items,connection,sync:status,total,page,pageSize}=state.data;
    const statusPanel=el('div',{class:'ws-zeffy-status'});
    let connectionText=connection.configured?'Connected to Zeffy':!connection.enabled?'Automatic sync is disabled':!connection.hasApiKey?'Zeffy API key needed':!connection.campaignIds.length?'Select donation campaign IDs to finish setup':'Check Zeffy configuration';
    statusPanel.append(el('strong',{text:connectionText}),el('p',{class:'ws-muted',text:'Last complete reconciliation: '+date(status.lastSuccess)+(status.inProgress?' · Import in progress':'')}));
    if(connection.error||status.error)statusPanel.append(el('p',{role:'alert',text:connection.error||status.error}));
    if(status.retryAt&&Date.parse(status.retryAt)>Date.now())statusPanel.append(el('p',{text:'Next retry after '+date(status.retryAt)}));
    if(status.lastSuccess&&Date.now()-Date.parse(status.lastSuccess)>7200000)statusPanel.append(el('p',{role:'status',text:'These records may be out of date. Check the sync status before using them.'}));
    const actions=el('div',{class:'ws-actions'});
    if(canSync) {
      const syncBtn=button(state.busy?'Syncing…':'Sync Now',sync,{symbol:'sync',primary:true});
      syncBtn.disabled=state.busy||!connection.configured||Boolean(status.retryAt&&Date.parse(status.retryAt)>Date.now());actions.append(syncBtn);
      if(connection.hasApiKey)actions.append(button('View Campaign IDs',campaigns,{symbol:'list'}));
    }
    const search=el('input',{type:'search',value:state.q,placeholder:'Search donor or payment ID','aria-label':'Search Zeffy donations'});
    const select=el('select',{'aria-label':'Payment status'},...['','succeeded','pending','failed','removed'].map(value=>el('option',{value,text:value?value[0].toUpperCase()+value.slice(1):'All statuses'})));select.value=state.status;
    const filters=el('form',{class:'ws-zeffy-filters',onsubmit:event=>{event.preventDefault();state.q=search.value;state.status=select.value;state.page=1;load();}},search,select,el('button',{type:'submit',class:'ws-button',text:'Filter'}));
    const table=el('table',{class:'ws-table ws-zeffy-table'},el('thead',{},el('tr',{},...['Date','Donor','Reported amount','Status','Details'].map(text=>el('th',{scope:'col',text}))))),rows=el('tbody');
    for(const item of items) {
      const details=el('details',{},el('summary',{text:'View'}),el('p',{text:'Payment: '+item.id}),el('p',{text:'Campaign: '+item.campaignId}),el('p',{text:'Last imported: '+date(item.syncedAt)}));
      if(item.refunds===null)details.append(el('p',{text:'Refund details unavailable in the mapped response. Verify in Zeffy.'}));
      else if(item.refunds.length)details.append(el('p',{text:'Refund records (API values):'}),...item.refunds.map(r=>el('p',{text:[r.amount,r.currency,r.status,r.id].filter(Boolean).join(' · ')})));
      else details.append(el('p',{text:'No refund records reported.'}));
      rows.append(el('tr',{},el('td',{'data-label':'Date',text:date(item.createdAt)}),el('td',{'data-label':'Donor'},el('strong',{text:item.donor||'Name unavailable'}),el('div',{class:'ws-muted',text:item.email})),el('td',{'data-label':'Reported amount',text:amount(item)}),el('td',{'data-label':'Status',text:item.status}),el('td',{'data-label':'Details'},details)));
    }
    table.append(rows);
    const previous=button('Previous',()=>{state.page--;load();},{symbol:'chevron_left'}),next=button('Next',()=>{state.page++;load();},{symbol:'chevron_right'});
    previous.disabled=page<=1;next.disabled=page*pageSize>=total;
    const pager=el('div',{class:'ws-actions'},previous,el('span',{text:total+' imported payments · Page '+page}),next);
    root.replaceChildren(el('h2',{text:'Zeffy Donations'}),el('p',{class:'ws-muted',text:'Online gifts from your selected Zeffy donation campaigns. Imported records are separate from manually recorded money and its reports.'}),statusPanel,actions);
    if(!connection.amountUnit)root.append(el('p',{role:'status',class:'ws-muted',text:'Amount format needs verification. Values are shown in API units until configured. Reported amounts are not adjusted for refunds or bank payouts.'}));
    else root.append(el('p',{class:'ws-muted',text:'Reported amounts are not adjusted for refunds or bank payouts. See Details for refund records.'}));
    root.append(filters,items.length?el('div',{class:'ws-table-wrap'},table):el('p',{role:'status',text:connection.configured?'No donations match this view. Use Sync Now to import your first payments.':'Donation imports will appear here after setup.'}),pager);
  }
  return {root,open:load};
}
