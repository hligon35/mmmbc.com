// Server-only Zeffy read integration. No checkout/payment creation or donor emails.
const API='https://api.zeffy.com/api/v1';
const ROOT='/api/admin/workspace/finance/zeffy';
const DEFAULT_MAPPING={amount:'amount',currency:'currency',created:'created',status:'status',donorName:'buyer.name',donorEmail:'buyer.email',refunds:'refunds'};
const stamp=()=>new Date().toISOString();
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const fail=(message,status=502,retryAfter=300)=>Object.assign(new Error(message),{status,retryAfter});
const text=(value,max=200)=>typeof value==='string'?value.slice(0,max):'';
const field=(object,path)=>path.split('.').reduce((value,key)=>value&&Object.hasOwn(value,key)?value[key]:undefined,object);
export function zeffyConfig(env) {
  const campaigns=[...new Set(String(env.ZEFFY_CAMPAIGN_IDS||'').split(',').map(s=>s.trim()).filter(Boolean))].sort();
  let mapping={...DEFAULT_MAPPING},error='';
  try {
    const custom=JSON.parse(env.ZEFFY_PAYMENT_MAPPING||'{}');
    if(!custom||Array.isArray(custom)||typeof custom!=='object')throw Error();
    for(const [key,value] of Object.entries(custom)) {
      if(!Object.hasOwn(mapping,key)||typeof value!=='string'||!/^\w+(\.\w+)*$/.test(value)||value.length>120)throw Error();
      mapping[key]=value;
    }
  }catch{error='ZEFFY_PAYMENT_MAPPING must contain supported field paths.';}
  if(campaigns.length>20||campaigns.some(id=>! /^[a-zA-Z0-9_-]{1,150}$/.test(id)))error='Configure up to 20 valid Zeffy campaign IDs.';
  const amountUnit=['minor','major'].includes(env.ZEFFY_AMOUNT_UNIT)?env.ZEFFY_AMOUNT_UNIT:'';
  const ready=Boolean(env.ZEFFY_API_KEY&&campaigns.length&&!error&&env.ZEFFY_SYNC_ENABLED!=='false');
  return {campaigns,mapping,amountUnit,error,ready,scope:JSON.stringify({campaigns,mapping})};
}
function safeRefunds(value) {
  const list=Array.isArray(value)?value:Array.isArray(value?.data)?value.data:null;
  if(!list)return null;
  if(list.length>1000)throw fail('Zeffy returned too many refund records.');
  return list.map(r=>({id:text(r?.id),amount:typeof r?.amount==='number'||typeof r?.amount==='string'?String(r.amount).slice(0,50):'',status:text(r?.status,80),currency:text(r?.currency,3)}));
}
export function normalizeZeffyPayment(payment,campaign,config) {
  if(!payment||typeof payment!=='object'||! /^[a-zA-Z0-9_-]{1,150}$/.test(payment.id||''))throw fail('Zeffy returned a payment without a valid ID.');
  const actual=typeof payment.campaign==='string'?payment.campaign:payment.campaign?.id;
  if(actual&&actual!==campaign)throw fail('Zeffy returned a payment outside the configured campaign.');
  if(payment.type&&payment.type!=='online')throw fail('Zeffy returned an offline payment in the online import.');
  const get=key=>field(payment,config.mapping[key]);
  const status=text(get('status'),80);
  if(!status)throw fail('Zeffy returned an unknown status format. Check the payment field mapping.');
  const created=get('created');
  let date='';
  if(typeof created==='number'&&Number.isFinite(created)&&created>0&&created<10000000000)date=new Date(created*1000).toISOString();
  else if(typeof created==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(created)&&Number.isFinite(Date.parse(created)))date=new Date(created).toISOString();
  const amount=get('amount');
  const numeric=(typeof amount==='number'||typeof amount==='string')&&/^\d+(\.\d+)?$/.test(String(amount))&&Number.isFinite(Number(amount));
  let donor=text(get('donorName'));
  if(!donor&&config.mapping.donorName===DEFAULT_MAPPING.donorName)donor=[text(payment.buyer?.first_name),text(payment.buyer?.last_name)].filter(Boolean).join(' ');
  const currency=text(get('currency'),3).toUpperCase();
  return {id:payment.id,campaign,status,created:date,donor,email:text(get('donorEmail'),254),currency:/^[A-Z]{3}$/.test(currency)?currency:'',amount:numeric?String(amount).slice(0,50):'',refunds:safeRefunds(get('refunds'))};
}
async function zeffyGet(env,path,params,fetcher) {
  const url=new URL(API+path);
  for(const [key,value] of Object.entries(params||{}))if(value!==undefined&&value!=='')url.searchParams.set(key,String(value));
  let response;
  try {response=await fetcher(url,{headers:{authorization:'Bearer '+env.ZEFFY_API_KEY,accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000)});}
  catch{throw fail('Could not reach Zeffy. The next scheduled sync will retry.');}
  if(!response.ok) {
    if(response.status===401||response.status===403)throw fail('Zeffy rejected the API key. Check the Worker secret and organization access.',503);
    if(response.status===429)throw fail('Zeffy rate limit reached. Sync will retry after the cooldown.',503,Math.min(3600,Math.max(60,Number(response.headers.get('retry-after'))||60)));
    // Never expose provider bodies, URLs, or credentials in admin errors/logs.
    throw fail('Zeffy API request failed (HTTP '+response.status+').');
  }
  // Bound unexpected provider responses before retaining any donor data.
  if(Number(response.headers.get('content-length'))>1000000)throw fail('Zeffy response is too large.');
  let data;
  try {const body=await response.text();if(new Blob([body]).size>1000000)throw Error();data=JSON.parse(body);}catch{throw fail('Zeffy returned an invalid response.');}
  return data;
}
function paymentList(data) {
  if(!Array.isArray(data?.data)||data.data.length>100||typeof data.has_more!=='boolean')throw fail('Zeffy returned an unknown list format.');
  if(data.has_more&&(!data.data.length||typeof data.next_cursor!=='string'||!data.next_cursor||data.next_cursor.length>500))throw fail('Zeffy returned an invalid pagination cursor.');
  return data;
}
export async function syncZeffyDonations(env,{force=false,actor='system:zeffy',fetcher=fetch,maxPages=5}={}) {
  const config=zeffyConfig(env),db=env.DB;
  if(!config.ready||!db)return {ok:false,configured:false};
  const clock=Math.floor(Date.now()/1000),token=crypto.randomUUID();
  const claim=await db.prepare(`UPDATE zeffy_sync_state SET lock_token=?,lock_until=?,last_attempt=?
    WHERE id=1 AND lock_until<? AND next_attempt<=? AND (?=1 OR run_id IS NOT NULL OR last_success IS NULL OR last_success<? OR scope<>?)`)
    .bind(token,clock+180,stamp(),clock,clock,Number(force),new Date(Date.now()-3600000).toISOString(),config.scope).run();
  if(!claim.meta?.changes)return {ok:true,busy:true};
  let pages=0,imported=0;
  try {
    let state=await db.prepare('SELECT * FROM zeffy_sync_state WHERE id=1').first();
    if(!state.run_id||state.scope!==config.scope) {
      const run=crypto.randomUUID();
      await db.prepare(`UPDATE zeffy_sync_state SET last_success=CASE WHEN scope<>? THEN NULL ELSE last_success END,scope=?,run_id=?,run_started=?,campaign_index=0,cursor='',last_error=NULL WHERE id=1 AND lock_token=?`).bind(config.scope,config.scope,run,clock,token).run();
      state={...state,scope:config.scope,run_id:run,run_started:clock,campaign_index:0,cursor:''};
    }
    while(pages<Math.min(5,Math.max(1,maxPages))&&state.campaign_index<config.campaigns.length) {
      const campaign=config.campaigns[state.campaign_index];
      // Full scans include pending, failed and refunded records; do not filter succeeded.
      // Online-only excludes offline/imported bookkeeping that may already be entered manually.
      const data=paymentList(await zeffyGet(env,'/payments',{limit:100,type:'online',campaign,'created[lte]':state.run_started,starting_after:state.cursor},fetcher));
      if(data.has_more&&data.next_cursor===state.cursor)throw fail('Zeffy pagination did not advance.');
      const payments=data.data.map(p=>normalizeZeffyPayment(p,campaign,config)),seenAt=stamp();
      if(new Set(payments.map(p=>p.id)).size!==payments.length)throw fail('Zeffy returned duplicate payment IDs in a page.');
      if(payments.length) {
        const duplicates=await db.prepare('SELECT COUNT(*) AS count FROM zeffy_payments WHERE seen_run=? AND id IN (SELECT value FROM json_each(?))').bind(state.run_id,JSON.stringify(payments.map(p=>p.id))).first();
        if(duplicates.count)throw fail('Zeffy pagination repeated a payment. Recheck the provider pagination before retrying.');
      }
      const nextIndex=state.campaign_index+Number(!data.has_more),nextCursor=data.has_more?data.next_cursor:'';
      // One JSON-bound statement per page stays below D1's 100 bind parameters
      // and Free-plan query limits even for a full 100-payment API page.
      const statements=[];
      if(payments.length)statements.push(db.prepare(`INSERT INTO zeffy_payments(id,campaign_id,status,created_at,donor_name,donor_email,currency,amount_value,refund_json,seen_run,removed,synced_at)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.campaign'),json_extract(value,'$.status'),
          json_extract(value,'$.created'),json_extract(value,'$.donor'),json_extract(value,'$.email'),
          json_extract(value,'$.currency'),json_extract(value,'$.amount'),COALESCE(json_extract(value,'$.refunds'),'null'),?,0,?
        FROM json_each(?) WHERE EXISTS(SELECT 1 FROM zeffy_sync_state WHERE id=1 AND lock_token=?)
        ON CONFLICT(id) DO UPDATE SET campaign_id=excluded.campaign_id,status=excluded.status,created_at=excluded.created_at,
          donor_name=excluded.donor_name,donor_email=excluded.donor_email,currency=excluded.currency,amount_value=excluded.amount_value,
          refund_json=excluded.refund_json,seen_run=excluded.seen_run,removed=0,synced_at=excluded.synced_at`)
        .bind(state.run_id,seenAt,JSON.stringify(payments),token));
      statements.push(db.prepare('UPDATE zeffy_sync_state SET campaign_index=?,cursor=?,last_error=NULL WHERE id=1 AND lock_token=?').bind(nextIndex,nextCursor,token));
      await db.batch(statements);
      state.campaign_index=nextIndex;state.cursor=nextCursor;pages++;imported+=payments.length;
    }
    const complete=state.campaign_index>=config.campaigns.length;
    if(complete) {
      // Only a fully successful scan can mark missing/deleted records. Failed/partial
      // runs keep previously imported gifts visible with a stale-sync warning.
      const placeholders=config.campaigns.map(()=>'?').join(',');
      await db.batch([
        db.prepare(`UPDATE zeffy_payments SET removed=1 WHERE campaign_id IN (${placeholders}) AND seen_run<>? AND EXISTS(SELECT 1 FROM zeffy_sync_state WHERE id=1 AND lock_token=?)`).bind(...config.campaigns,state.run_id,token),
        db.prepare(`UPDATE zeffy_sync_state SET run_id=NULL,cursor='',campaign_index=0,last_success=?,last_error=NULL,next_attempt=0 WHERE id=1 AND lock_token=?`).bind(stamp(),token),
        db.prepare(`INSERT INTO workspace_audit(id,actor,item_key,action,value_json,created_at) SELECT ?,?,'zeffy','giving.sync',?,? FROM zeffy_sync_state WHERE id=1 AND lock_token=?`).bind(crypto.randomUUID(),actor,JSON.stringify({runId:state.run_id,campaigns:config.campaigns}),stamp(),token)
      ]);
    }
    return {ok:true,complete,pages,imported};
  } catch(error) {
    const message=error.retryAfter?error.message:'Donation sync could not be saved. Check the D1 migration and retry.';
    await db.prepare('UPDATE zeffy_sync_state SET last_error=?,next_attempt=? WHERE id=1 AND lock_token=?').bind(message,Math.floor(Date.now()/1000)+(error.retryAfter||300),token).run();
    throw fail(message,error.status||503);
  } finally {
    await db.prepare('UPDATE zeffy_sync_state SET lock_token=NULL,lock_until=0 WHERE id=1 AND lock_token=?').bind(token).run();
  }
}
export function zeffyAmount(row,unit) {
  if(!unit||!row.amount_value||!row.currency)return null;
  const n=Number(row.amount_value),minor=unit==='minor'?n:Math.round(n*100);
  if(!Number.isSafeInteger(minor)||minor<0)return null;
  return minor;
}
async function listDonations(env,url) {
  const config=zeffyConfig(env),db=env.DB;
  const page=Math.max(1,Math.min(100000,parseInt(url.searchParams.get('page')||'1',10)||1));
  const where=[],args=[];
  if(config.campaigns.length){where.push('campaign_id IN ('+config.campaigns.map(()=>'?').join(',')+')');args.push(...config.campaigns);}else where.push('0=1');
  const q=text(url.searchParams.get('q'),120).trim();
  if(q){where.push('(donor_name LIKE ? OR donor_email LIKE ? OR id LIKE ?)');args.push(...Array(3).fill('%'+q+'%'));}
  const status=url.searchParams.get('status')||'';
  if(status==='removed')where.push('removed=1');
  else if(status){if(!['succeeded','pending','failed'].includes(status))throw fail('Invalid status filter.',400);where.push('status=? AND removed=0');args.push(status);}
  const sql=where.join(' AND ');
  const [state,count,rows]=await Promise.all([
    db.prepare('SELECT last_success,last_attempt,last_error,run_id,next_attempt,lock_until,scope FROM zeffy_sync_state WHERE id=1').first(),
    db.prepare('SELECT COUNT(*) AS total FROM zeffy_payments WHERE '+sql).bind(...args).first(),
    db.prepare('SELECT * FROM zeffy_payments WHERE '+sql+' ORDER BY created_at DESC,id DESC LIMIT 40 OFFSET ?').bind(...args,(page-1)*40).all()
  ]);
  const currentScope=state?.scope===config.scope;
  return json({items:(rows.results||[]).map(r=>({id:r.id,campaignId:r.campaign_id,status:r.removed?'removed':r.status,createdAt:r.created_at,donor:r.donor_name,email:r.donor_email,currency:r.currency,reportedAmount:r.amount_value,amountCents:zeffyAmount(r,config.amountUnit),refunds:JSON.parse(r.refund_json),syncedAt:r.synced_at})),page,pageSize:40,total:count.total,
    connection:{configured:config.ready,hasApiKey:Boolean(env.ZEFFY_API_KEY),campaignIds:config.campaigns,amountUnit:config.amountUnit,error:config.error,enabled:env.ZEFFY_SYNC_ENABLED!=='false'},
    sync:{lastSuccess:currentScope?state?.last_success:null,lastAttempt:state?.last_attempt,error:state?.last_error,inProgress:Boolean(currentScope&&state?.run_id),retryAt:state?.next_attempt?new Date(state.next_attempt*1000).toISOString():null}});
}
export async function zeffyAdminRequest(request,env,url,actor,permissions) {
  if(!url.pathname.startsWith(ROOT))return null;
  if(!permissions.includes('finance.view'))return json({error:'Finance access is required.'},403);
  if(!env.DB)return json({error:'The finance database is unavailable.'},503);
  try {
    if(url.pathname===ROOT&&request.method==='GET')return await listDonations(env,url);
    if(url.pathname===ROOT+'/sync'&&request.method==='POST') {
      if(!permissions.includes('giving.sync'))return json({error:'Only an administrator or Finance Officer can sync donations.'},403);
      if(!zeffyConfig(env).ready)return json({error:'Configure the Zeffy API key and donation campaign IDs before syncing.'},409);
      return json(await syncZeffyDonations(env,{force:true,actor}));
    }
    if(url.pathname===ROOT+'/campaigns'&&request.method==='GET') {
      if(!permissions.includes('giving.sync'))return json({error:'Only an administrator or Finance Officer can inspect campaigns.'},403);
      if(!env.ZEFFY_API_KEY)return json({error:'Add the Zeffy API key to the Worker first.'},409);
      const cursor=text(url.searchParams.get('cursor'),500);
      const data=paymentList(await zeffyGet(env,'/campaigns',{limit:100,starting_after:cursor},fetch));
      return json({items:data.data.map(c=>({id:text(c.id,150),title:text(c.title)||text(c.name)||'Untitled campaign'})),hasMore:data.has_more,nextCursor:data.next_cursor||''});
    }
    return json({error:'Donation endpoint or method not found.'},404);
  }catch(error){return json({error:error.retryAfter?error.message:'Donation storage is unavailable. Apply migration 0020 and retry.'},error.status||503);}
}
