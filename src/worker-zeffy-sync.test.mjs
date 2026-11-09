import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workspaceEnv} from './test-support/workspace-db.mjs';
import {syncZeffyDonations,zeffyAdminRequest,zeffyConfig,zeffyAmount,normalizeZeffyPayment} from './worker-zeffy-sync.js';
import {handleWorkspaceRequest} from './worker-workspace.js';
import {permissionsForRole} from './admin-rbac.js';
import {mutationDenied} from './launch-security.js';
const ROOT='http://localhost/api/admin/workspace/finance/zeffy';
const env=role=>({...workspaceEnv(role),ZEFFY_API_KEY:'test-server-only-key',ZEFFY_CAMPAIGN_IDS:'giving',ZEFFY_AMOUNT_UNIT:'minor'});
const payment=(id='gift-1',rest={})=>({id,type:'online',status:'succeeded',amount:12500,currency:'usd',created:1735689600,campaign:'giving',buyer:{name:'Ada Brown',email:'ada@example.com'},refunds:[],...rest});
const list=(data,has_more=false,next_cursor=null)=>Response.json({data,has_more,next_cursor});
const rows=e=>e.DB.sqlite.prepare('SELECT * FROM zeffy_payments ORDER BY id').all();
const state=e=>e.DB.sqlite.prepare('SELECT * FROM zeffy_sync_state').get();
const clearCooldown=e=>e.DB.sqlite.exec('UPDATE zeffy_sync_state SET next_attempt=0');
test('disabled/unconfigured sync makes no API request',async()=>{
  for(const vars of [{ZEFFY_API_KEY:''},{ZEFFY_CAMPAIGN_IDS:''},{ZEFFY_SYNC_ENABLED:'false'}]) {
    assert.equal((await syncZeffyDonations({...env(),...vars},{fetcher:()=>assert.fail('unexpected fetch')})).configured,false);
  }
});
test('imports persist, upsert once, update refunds/status, and leave manual totals alone',async()=>{
  const e=env();let calls=0;
  const fetcher=async(url,options)=>{
    calls++;assert.equal(url.origin,'https://api.zeffy.com');assert.equal(url.pathname,'/api/v1/payments');
    assert.equal(options.headers.authorization,'Bearer '+e.ZEFFY_API_KEY);assert.equal(options.redirect,'error');
    assert.equal(url.searchParams.get('campaign'),'giving');assert.equal(url.searchParams.get('type'),'online');
    assert.equal(url.searchParams.get('limit'),'100');assert.ok(url.searchParams.get('created[lte]'));assert.equal(url.searchParams.has('status'),false);
    return list([payment('gift-1',calls===1?{}:{status:'failed',refunds:[{id:'refund-1',amount:5000,status:'succeeded',card:'never-store'}]})]);
  };
  assert.equal((await syncZeffyDonations(e,{force:true,fetcher})).complete,true);
  const response=await zeffyAdminRequest(new Request(ROOT),e,new URL(ROOT),'tester',permissionsForRole('finance_entry'));
  const data=await response.json();assert.equal(data.items[0].amountCents,12500);assert.equal(data.items[0].donor,'Ada Brown');
  await syncZeffyDonations(e,{force:true,fetcher});assert.equal(rows(e).length,1);assert.equal(rows(e)[0].status,'failed');
  assert.equal(JSON.parse(rows(e)[0].refund_json)[0].amount,'5000');assert.equal(rows(e)[0].refund_json.includes('card'),false);
  assert.equal(e.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM finance_entries').get().n,0);
  assert.equal(e.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_audit WHERE action='giving.sync'").get().n,2);
  assert.equal(JSON.stringify(data).includes(e.ZEFFY_API_KEY),false);
});
test('cursor checkpoints resume across invocations and mark deletions only after completion',async()=>{
  const e=env();await syncZeffyDonations(e,{force:true,fetcher:async()=>list([payment('old')])});
  let bound;
  const a=await syncZeffyDonations(e,{force:true,maxPages:1,fetcher:async url=>{bound=url.searchParams.get('created[lte]');return list([payment('new')],true,'cursor-two');}});
  assert.equal(a.complete,false);assert.equal(state(e).cursor,'cursor-two');assert.equal(rows(e).find(r=>r.id==='old').removed,0);
  const b=await syncZeffyDonations(e,{fetcher:async url=>{assert.equal(url.searchParams.get('starting_after'),'cursor-two');assert.equal(url.searchParams.get('created[lte]'),bound);return list([payment('other')]);}});
  assert.equal(b.complete,true);assert.equal(rows(e).find(r=>r.id==='old').removed,1);assert.equal(state(e).run_id,null);
  await syncZeffyDonations(e,{force:true,fetcher:async()=>list([payment('old')])});assert.equal(rows(e).find(r=>r.id==='old').removed,0);
});
test('empty successful scan removes missing gifts; hourly cron avoids repeat full scans',async()=>{
  const e=env();await syncZeffyDonations(e,{fetcher:async()=>list([payment()])});
  assert.equal((await syncZeffyDonations(e,{fetcher:()=>assert.fail('too soon')})).busy,true);
  await syncZeffyDonations(e,{force:true,fetcher:async()=>list([])});assert.equal(rows(e)[0].removed,1);
});
test('rate limits preserve cursor/history and respect cooldown even for manual sync',async()=>{
  const e=env();await syncZeffyDonations(e,{force:true,fetcher:async()=>list([payment()])});
  const success=state(e).last_success;
  await assert.rejects(syncZeffyDonations(e,{force:true,fetcher:async()=>new Response('secret provider response',{status:429,headers:{'retry-after':'600'}})}),/rate limit/);
  assert.equal(rows(e)[0].removed,0);assert.equal(state(e).last_success,success);assert.equal(state(e).lock_token,null);
  assert.ok(state(e).next_attempt>Math.floor(Date.now()/1000)+590);
  assert.equal((await syncZeffyDonations(e,{force:true,fetcher:()=>assert.fail('cooldown')})).busy,true);
  assert.equal(state(e).last_error.includes('secret'),false);
});
test('overlapping requests share a D1 lease',async()=>{
  const e=env();let release,started;
  const wait=new Promise(r=>started=r),gate=new Promise(r=>release=r);
  const first=syncZeffyDonations(e,{force:true,fetcher:async()=>{started();await gate;return list([payment()]);}});
  await wait;assert.equal((await syncZeffyDonations(e,{force:true,fetcher:()=>assert.fail('concurrent fetch')})).busy,true);
  release();await first;assert.equal(rows(e).length,1);assert.equal(state(e).lock_until,0);
});
test('bad pagination, wrong campaign, offline payments and unknown status fail visibly',async()=>{
  for(const response of [()=>Response.json({data:[],has_more:true,next_cursor:'x'}),()=>list([payment('x',{campaign:'other'})]),()=>list([payment('x',{type:'manual'})]),()=>list([payment('x',{status:null})]),()=>list([payment(),payment()])]) {
    const e=env();await assert.rejects(syncZeffyDonations(e,{force:true,fetcher:async()=>response()}));assert.equal(rows(e).length,0);assert.ok(state(e).last_error);assert.equal(state(e).last_success,null);
  }
});
test('repeating pagination does not silently complete or delete history',async()=>{
  const e=env();await assert.rejects(syncZeffyDonations(e,{force:true,fetcher:async()=>list([payment()],true,'repeat')}),/pagination|repeated/);
  assert.equal(rows(e).length,1);assert.equal(rows(e)[0].removed,0);assert.equal(state(e).last_success,null);
});
test('provider/network errors are sanitized and retriable',async()=>{
  for(const fetcher of [async()=>new Response('apikey-and-donor',{status:401}),async()=>{throw Error('apikey-and-donor');},async()=>new Response('apikey-and-donor',{status:500}),async()=>new Response('not JSON')]) {
    const e=env();await assert.rejects(syncZeffyDonations(e,{force:true,fetcher}));assert.equal(state(e).last_error.includes('apikey'),false);clearCooldown(e);
    await syncZeffyDonations(e,{force:true,fetcher:async()=>list([payment()])});assert.equal(state(e).last_error,null);
  }
});
test('scope changes restart reconciliation and old campaign rows are hidden',async()=>{
  const e=env();await syncZeffyDonations(e,{force:true,maxPages:1,fetcher:async()=>list([payment()],true,'first-scope')});
  e.ZEFFY_CAMPAIGN_IDS='second';
  await syncZeffyDonations(e,{fetcher:async url=>{assert.equal(url.searchParams.has('starting_after'),false);assert.equal(url.searchParams.get('campaign'),'second');return list([payment('second-gift',{campaign:'second'})]);}});
  const r=await zeffyAdminRequest(new Request(ROOT),e,new URL(ROOT),'tester',permissionsForRole('treasurer'));assert.deepEqual((await r.json()).items.map(i=>i.id),['second-gift']);
});
test('money interpretation is explicit; missing/unsafe amounts never turn into zero',()=>{
  assert.equal(zeffyAmount({amount_value:'12500',currency:'USD'},''),null);
  assert.equal(zeffyAmount({amount_value:'125.50',currency:'USD'},'major'),12550);
  assert.equal(zeffyAmount({amount_value:'',currency:'USD'},'minor'),null);
  assert.equal(zeffyAmount({amount_value:'125.5',currency:'USD'},'minor'),null);
  assert.equal(zeffyAmount({amount_value:'99999999999999999999',currency:'USD'},'minor'),null);
  const e=env();e.ZEFFY_PAYMENT_MAPPING=JSON.stringify({amount:'totals.gift',donorName:'buyer.display_name'});
  const p=normalizeZeffyPayment(payment('mapped',{totals:{gift:42},buyer:{display_name:'Verified'}}),'giving',zeffyConfig(e));assert.equal(p.amount,'42');assert.equal(p.donor,'Verified');
  assert.equal(zeffyConfig({...e,ZEFFY_PAYMENT_MAPPING:'{"amount":"bad[0]"}'}).ready,false);
});
test('finance permissions, authentication and origin protections apply to donations',async()=>{
  for(const role of ['administrator','treasurer','finance_entry','website_editor','auditor']) {
    const e=env(role);const r=await handleWorkspaceRequest(new Request(ROOT),e);
    assert.equal(r.status,['administrator','treasurer','finance_entry'].includes(role)?200:403,role);
    const post=await zeffyAdminRequest(new Request(ROOT+'/sync',{method:'POST'}),{...e,ZEFFY_API_KEY:''},new URL(ROOT+'/sync'),'tester',permissionsForRole(role));
    assert.equal(post.status,['administrator','treasurer'].includes(role)?409:403,role);
  }
  const unauth=await handleWorkspaceRequest(new Request(ROOT),{...env(),DEV_BYPASS_AUTH:'false'});assert.equal(unauth.status,401);
  assert.equal(mutationDenied(new Request(ROOT+'/sync',{method:'POST',headers:{origin:'https://evil.example'}})),true);
});
test('search and status filters paginate server-side and store no cacheable donor data',async()=>{
  const e=env();await syncZeffyDonations(e,{force:true,fetcher:async()=>list(Array.from({length:45},(_,i)=>payment('gift-'+i,{status:i%2?'pending':'succeeded'})))});
  const get=async q=>{const u=new URL(ROOT+q);const r=await zeffyAdminRequest(new Request(u),e,u,'tester',permissionsForRole('finance_entry'));assert.equal(r.headers.get('cache-control'),'no-store');return r.json();};
  const second=await get('?page=2');assert.equal(second.total,45);assert.equal(second.items.length,5);
  const pending=await get('?status=pending&q=Ada');assert.equal(pending.total,22);assert.equal(pending.items.every(p=>p.status==='pending'),true);
  assert.equal((await get('?q=%27%20OR%201%3D1%20--')).total,0);
});
test('full 500-payment batches fit Cloudflare D1 parameter and query limits',async()=>{
  const e=env(),original=e.DB.prepare.bind(e.DB);let queries=0,page=0;
  e.DB.prepare=sql=>{queries++;const statement=original(sql),bind=statement.bind.bind(statement);statement.bind=(...args)=>{assert.ok(args.length<=100,'D1 parameter limit');return bind(...args);};return statement;};
  const result=await syncZeffyDonations(e,{force:true,fetcher:async()=>{page++;return list(Array.from({length:100},(_,i)=>payment('page-'+page+'-'+i)),page<5,'cursor-'+page);}});
  assert.equal(result.complete,true);assert.equal(rows(e).length,500);assert.ok(queries<30,'reserve query budget for the existing cron tasks');
});
