import {el,icon,button,api,time,statusLabel,showError} from './shared.mjs';

export class Mailbox {
  constructor(ctx) {
    this.ctx=ctx;this.root=el('section',{class:'ws-mailbox','aria-label':'Mailbox'});
    this.list=el('section',{class:'ws-collection','aria-label':'Conversations'});
    this.reader=el('section',{class:'ws-reader','aria-label':'Selected message',tabindex:'-1'});
    this.root.append(this.list,this.reader);this.items=[];this.page=1;this.folder='inbox';this.category='all';this.sort='newest';this.filter='all';this.q='';this.selected='';this.sequence=0;
    this.manage=ctx.permissions.includes('submissions.manage');
    this.composeDialog=el('dialog',{class:'ws-compose','aria-label':'Compose message'});document.body.append(this.composeDialog);
    this.composeDialog.addEventListener('cancel',e=>{e.preventDefault();if(this.sending||this.draftSaving)return;this.saveDraft().then(()=>this.composeDialog.close()).catch(()=>{});});
    window.addEventListener('beforeunload',e=>{if(this.sending||this.draftSaving||this.draftError){e.preventDefault();e.returnValue='';}});
    this.reader.append(el('div',{class:'ws-empty',text:'Select a conversation to read its message.'}));
  }
  async open(route) {
    const openSeq=this.openSequence=(this.openSequence||0)+1;
    const rentalMode=route.module==='rentals';
    if(this.mode!==route.module && !rentalMode){this.category=route.params?.category||'all';this.folder=route.params?.folder||'inbox';this.page=1;}
    this.mode=route.module;
    if(rentalMode){this.category='facility_rental';this.folder='inbox';}
    this.selected=route.key || '';
    await this.load();
    if(openSeq!==this.openSequence)return;
    if(route.key)await this.read(route.key);
    else {this.root.classList.remove('ws-reading');this.reader.replaceChildren(el('div',{class:'ws-empty',text:'Select a conversation to read its message.'}));}
  }
  async load() {
    const seq=++this.sequence;
    const title=this.mode==='rentals'?'Facility Rentals':({inbox:'Inbox',unread:'Unread',starred:'Starred',sent:'Sent',archive:'Archive',deleted:'Deleted'}[this.folder]);
    this.list.setAttribute('aria-busy','true');
    const status=el('div',{class:'ws-status',role:'status',text:'Loading conversations…'});
    if(!this.list.children.length)this.list.append(status);
    try {
      const query=new URLSearchParams({folder:this.folder,category:this.category,filter:this.filter,sort:this.sort,q:this.q,page:this.page});
      const data=await api('/api/admin/mail/items?'+query);
      if(seq!==this.sequence)return;
      this.items=data.items;this.total=data.total;this.ctx.badge(data.unread);this.ctx.mailCounts(data.unread);
      const oldSearch=this.list.querySelector('input[type=search]'),focusedSearch=document.activeElement===oldSearch;
      const sort=el('select',{'aria-label':'Sort conversations',onchange:e=>{this.sort=e.target.value;this.page=1;this.load();}},el('option',{value:'newest',text:'Newest first'}),el('option',{value:'oldest',text:'Oldest first'}));sort.value=this.sort;
      const chips=el('div',{class:'ws-chips'},...['all','unread','starred'].map(v=>button(v[0].toUpperCase()+v.slice(1),()=>{this.filter=v;this.page=1;this.load();},{'aria-pressed':String(this.filter===v)})));
      const search=el('input',{type:'search',placeholder:'Search conversations','aria-label':'Search conversations',value:this.q,oninput:e=>{this.q=e.target.value;clearTimeout(this.searchTimer);this.searchTimer=setTimeout(()=>{this.page=1;this.load();},250);}});
      const rows=el('div',{class:'ws-message-list',role:'list'});let day='';
      for(const item of this.items) {
        const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago'}).format(new Date(item.createdAt));
        if(date!==day){day=date;const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago'}).format(new Date());const yesterday=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago'}).format(new Date(Date.now()-86400000));rows.append(el('p',{class:'ws-date-group',text:date===today?'TODAY':date===yesterday?'YESTERDAY':new Date(item.createdAt).toLocaleDateString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',year:'numeric'}).toUpperCase()}));}
        const row=button('',()=>this.ctx.navigate(this.mode,item.key),{class:'ws-message'+(!item.isRead?' ws-unread':'')+(this.selected===item.key?' ws-selected':''),'aria-label':item.sender+', '+item.subject,'aria-current':this.selected===item.key?'true':'false'});
        row.replaceChildren(el('div',{class:'ws-message-meta'},el('strong',{text:item.sender}),el('time',{datetime:item.createdAt,text:new Date(item.createdAt).toLocaleTimeString('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit'})})),
          el('div',{class:'ws-message-subject'},item.starred?icon('star'):null,el('span',{text:item.subject})),el('p',{class:'ws-preview',text:item.preview}),
          el('div',{class:'ws-badges'},el('span',{class:'ws-badge',text:item.type==='facility_rental'?(item.audience==='member'?'Member rental':'Non-member rental'):item.type==='outbound'?'Outgoing':'Contact'}),el('span',{class:'ws-badge',text:statusLabel(item.status)})));
        rows.append(el('div',{role:'listitem'},row));
      }
      if(!this.items.length)rows.append(el('div',{class:'ws-empty',text:'No conversations match these filters.'}));
      this.list.replaceChildren(el('header',{class:'ws-list-head'},el('h1',{text:title}),el('span',{class:'ws-muted',text:data.total+' conversations'}),button('Refresh',()=>this.load(),{symbol:'refresh'})),
        el('div',{class:'ws-list-filters'},search,el('div',{class:'ws-filter-row'},chips,sort)),rows,
        el('footer',{class:'ws-pager'},button('Previous',()=>{this.page--;this.load();},{symbol:'chevron_left',disabled:this.page<=1?'':null}),el('span',{text:'Page '+this.page+' of '+Math.max(1,Math.ceil(data.total/data.pageSize))}),button('Next',()=>{this.page++;this.load();},{symbol:'chevron_right',disabled:this.page*data.pageSize>=data.total?'':null})));
      if(focusedSearch){search.focus();search.setSelectionRange(search.value.length,search.value.length);}
    } catch(error){if(seq===this.sequence){const node=el('div');showError(node,error,()=>this.load());this.list.prepend(node);}}
    finally {if(seq===this.sequence)this.list.setAttribute('aria-busy','false');}
  }
  async read(key,{markRead=true}={}) {
    const requestKey=key;this.selected=key;this.root.classList.add('ws-reading');this.reader.setAttribute('aria-busy','true');
    try {
      let item=await api('/api/admin/mail/items/'+encodeURIComponent(key));
      if(this.selected!==requestKey)return;
      if(markRead&&this.manage&&!item.isRead&&item.type!=='outbound') {
        item=await api('/api/admin/mail/items/'+encodeURIComponent(key),{method:'PATCH',body:JSON.stringify({isRead:true})});
        this.load();
      }
      if(this.selected!==requestKey)return;
      this.current=item;
      const toolbar=el('div',{class:'ws-reader-toolbar'},button('Back',()=>this.ctx.navigate(this.mode),{symbol:'arrow_back',class:'ws-button ws-mobile-back'}));
      if(this.manage) {
        if(item.type!=='outbound'&&item.email)toolbar.append(button('Reply',()=>this.compose(item),{symbol:'reply'}));
        toolbar.append(button(item.starred?'Unstar':'Star',()=>this.patch({starred:!item.starred}),{symbol:item.starred?'star':'star_border'}),button(item.isRead?'Mark unread':'Mark read',()=>this.patch({isRead:!item.isRead}),{symbol:item.isRead?'mark_email_unread':'mark_email_read'}));
        if(item.folder==='inbox')toolbar.append(button('Archive',()=>this.patch({folder:'archive'},true),{symbol:'archive'}));
        else toolbar.append(button('Restore',()=>this.patch({folder:'inbox'},true),{symbol:'restore'}));
        if(item.folder!=='deleted')toolbar.append(button('Delete',()=>{if(confirm('Move this conversation to Deleted? The original church record will be preserved.'))this.patch({folder:'deleted'},true);},{symbol:'delete'}));
      }
      const idx=this.items.findIndex(i=>i.key===key);
      toolbar.append(button('Previous',()=>this.ctx.navigate(this.mode,this.items[idx-1].key),{symbol:'chevron_left',disabled:idx<=0?'':null}),button('Next',()=>this.ctx.navigate(this.mode,this.items[idx+1].key),{symbol:'chevron_right',disabled:idx<0||idx>=this.items.length-1?'':null}));
      const body=el('div',{class:'ws-message-body',text:item.body});
      this.reader.replaceChildren(toolbar,el('header',{class:'ws-message-header'},el('h1',{text:item.subject}),el('strong',{text:item.sender}),el('p',{class:'ws-muted',text:item.email}),el('time',{datetime:item.createdAt,text:time(item.createdAt)}),el('span',{class:'ws-badge',text:statusLabel(item.status)})),body);
      if(item.type==='contact')this.reader.append(el('dl',{class:'ws-context'},...['phone','address'].flatMap(k=>item[k]?[el('dt',{text:k}),el('dd',{text:item[k]})]:[])));
      if(item.rental)this.renderRental(item);
      if(item.type==='outbound'&&item.status!=='accepted') {
        this.reader.append(el('p',{class:'ws-error',text:item.error || statusLabel(item.status)}));
        if(this.manage&&item.actor===this.ctx.user.email)this.reader.append(button('Retry send',()=>this.retry(item.outboundId),{symbol:'refresh'}));
      }
      for(const reply of item.replies) {
        const card=el('article',{class:'ws-thread-reply'},el('strong',{text:reply.actor+' → '+reply.recipient}),el('p',{class:'ws-muted',text:time(reply.created_at)+' · '+statusLabel(reply.status)}),el('div',{class:'ws-message-body',text:reply.body}));
        if(reply.error)card.append(el('p',{class:'ws-error',text:reply.error}));
        if(this.manage&&reply.actor===this.ctx.user.email&&reply.status!=='accepted')card.append(button('Retry send',()=>this.retry(reply.id),{symbol:'refresh'}));
        this.reader.append(card);
      }
      this.reader.focus({preventScroll:true});
    } catch(error){showError(this.reader,error,()=>this.read(key));}
    finally{this.reader.setAttribute('aria-busy','false');}
  }
  renderRental(item) {
    const r=item.rental,fields=[['Requester',r.requester],['Membership',r.audience==='member'?'Member':'Non-member'],['Facilities',r.facilities.join(', ')||'See request details'],['Requested date',r.date],['Requested time',r.timeFrom+' – '+r.timeTo],['Event / purpose',r.purpose],['Email',r.email],['Phone',r.phone],['Address',r.address],['Request status',statusLabel(r.status)]];
    const context=el('section',{class:'ws-rental-context'},el('h2',{text:'Rental request'}),el('dl',{class:'ws-context'},...fields.flatMap(([name,value])=>[el('dt',{text:name}),el('dd',{text:value||'—'})])));
    const actions=el('div',{class:'ws-actions'});
    if(this.manage)for(const [label,status]of [['Approve','approved'],['Decline','declined'],['Reopen','pending']])if(r.status!==status)actions.append(button(label,()=>this.decide(r,status),{primary:status==='approved'}));
    actions.append(button('View Schedule',()=>this.ctx.navigate('calendar','',{date:r.date}),{symbol:'calendar_month'}),button('Open Rental Record',()=>this.ctx.navigate('rentals',item.key),{symbol:'open_in_full'}));
    context.append(actions,el('details',{},el('summary',{text:'Complete submitted form'}),el('dl',{class:'ws-context'},...Object.entries(r.form).flatMap(([k,v])=>[el('dt',{text:k}),el('dd',{text:typeof v==='object'?JSON.stringify(v):String(v??'')})]))));this.reader.append(context);
  }
  async decide(r,status) {
    if(!confirm((status==='approved'?'Approve':status==='declined'?'Decline':'Reopen')+' this rental request?'))return;
    try {await api('/api/admin/workspace/rentals/'+encodeURIComponent(r.id),{method:'PATCH',body:JSON.stringify({status,version:r.version})});this.ctx.notice('Rental '+status+'.');await this.read('facility_rental:'+r.id);await this.load();}
    catch(error){this.ctx.notice(error.message,true);}
  }
  async patch(patch,leave=false) {
    const item=this.current,key=item.key,previous={folder:item.folder,isRead:item.isRead,starred:item.starred};
    try {
      await api('/api/admin/mail/items/'+encodeURIComponent(key),{method:'PATCH',body:JSON.stringify(patch)});
      if(leave)this.ctx.navigate(this.mode);else await this.read(key,{markRead:false});
      await this.load();
      if(leave)this.ctx.notice('Conversation moved.',false,async()=>{await api('/api/admin/mail/items/'+encodeURIComponent(key),{method:'PATCH',body:JSON.stringify(previous)});this.load();});
    }catch(error){this.ctx.notice(error.message,true);}
  }
  async retry(id) {
    this.ctx.notice('Retrying send…');
    try {const data=await api('/api/admin/mail/outbound/'+id+'/retry',{method:'POST',body:'{}'});this.ctx.notice(statusLabel(data.outbound.status),data.outbound.status!=='accepted');await this.read(this.selected);await this.load();}
    catch(error){this.ctx.notice(error.message,true);}
  }
  async compose(item=null) {
    if(!this.manage)return;
    const key=item?.key||'compose';
    if(this.composeDialog.open){this.composeDialog.focus();return;}
    try {
      const {draft}=await api('/api/admin/mail/drafts/'+encodeURIComponent(key));
      this.draftKey=key;this.idempotencyKey=draft?.idempotency_key||crypto.randomUUID();this.draftError=false;
      this.to=el('input',{type:'email',required:'',maxlength:'254',value:draft?.recipient||item?.email||''});
      this.subject=el('input',{required:'',maxlength:'200',value:draft?.subject||(item?'Re: '+item.subject:'')});
      this.message=el('textarea',{required:'',maxlength:'20000',rows:'12'});this.message.value=draft?.body||'';
      this.draftStatus=el('p',{class:'ws-muted',role:'status',text:draft?'Draft restored.':'Drafts save automatically.'});
      const form=el('form',{},el('header',{class:'ws-compose-head'},el('h2',{text:item?'Reply':'New Message'}),button('Close',async()=>{if(this.sending)return;try{await this.saveDraft();this.composeDialog.close();}catch(e){this.draftStatus.textContent=e.message;}},{symbol:'close'})),
        ...[['To',this.to],['Subject',this.subject],['Message',this.message]].map(([label,input])=>el('label',{},el('span',{text:label}),input)),this.draftStatus);
      this.sendButton=el('button',{class:'ws-button ws-primary',type:'submit',text:'Send message'});
      const discard=button('Discard draft',async()=>{if(this.sending||!confirm('Discard this unsent draft?'))return;clearTimeout(this.draftTimer);try{if(this.pendingDraft)await this.pendingDraft;await api('/api/admin/mail/drafts/'+encodeURIComponent(key),{method:'DELETE'});this.composeDialog.close();this.draftError=false;}catch(e){this.draftStatus.textContent=e.message;}});
      form.append(el('div',{class:'ws-actions'},this.sendButton,discard));
      form.addEventListener('input',()=>{this.draftError=true;clearTimeout(this.draftTimer);this.draftTimer=setTimeout(()=>this.saveDraft().catch(()=>{}),600);});
      form.addEventListener('submit',e=>{e.preventDefault();this.send();});
      this.composeDialog.replaceChildren(form);this.composeDialog.showModal();this.to.focus();
    }catch(error){this.ctx.notice(error.message,true);}
  }
  draftBody() {return {recipient:this.to.value,subject:this.subject.value,body:this.message.value,itemKey:this.draftKey==='compose'?'':this.draftKey,idempotencyKey:this.idempotencyKey,draftKey:this.draftKey};}
  async saveDraft() {
    clearTimeout(this.draftTimer);if(!this.to)return;
    const snapshot=this.draftBody();const previous=this.pendingDraft;
    this.draftSaving=true;
    const task=(async()=>{if(previous)await previous.catch(()=>{});return api('/api/admin/mail/drafts/'+encodeURIComponent(snapshot.draftKey),{method:'PUT',body:JSON.stringify(snapshot)});})();
    this.pendingDraft=task;
    try{await task;this.draftError=JSON.stringify(snapshot)!==JSON.stringify(this.draftBody());this.draftStatus.textContent=this.draftError?'Saving newer changes…':'Draft saved.';}
    catch(error){this.draftError=true;this.draftStatus.replaceChildren(el('span',{text:'Draft could not be saved. '+error.message}),button('Retry',()=>this.saveDraft().catch(()=>{})));throw error;}
    finally{if(this.pendingDraft===task)this.draftSaving=false;}
  }
  async send() {
    if(this.sending)return;this.sending=true;this.sendButton.disabled=true;
    for(const input of [this.to,this.subject,this.message])input.readOnly=true;
    this.draftStatus.textContent='Saving and sending…';
    try {
      await this.saveDraft();const body=this.draftBody();
      const data=await api('/api/admin/mail/send',{method:'POST',body:JSON.stringify(body)});
      if(data.outbound.status!=='accepted'){this.draftStatus.textContent=statusLabel(data.outbound.status)+': '+(data.outbound.error||'Open Sent to retry.');return;}
      this.composeDialog.close();this.draftError=false;this.ctx.notice('Accepted by email service.');
      if(body.itemKey)await this.read(body.itemKey);else {this.folder='sent';this.category='all';this.ctx.navigate('mail','',{folder:'sent'});}
      await this.load();
    }catch(error){this.draftStatus.textContent=error.message+' Your draft is preserved. Retry uses the same send identifier.';}
    finally{this.sending=false;this.sendButton.disabled=false;for(const input of [this.to,this.subject,this.message])input.readOnly=false;}
  }
}
