import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceEnv } from './test-support/workspace-db.mjs';
import { handleWorkspaceRequest, sendOutbound, escapeHtml, csvCell } from './worker-workspace.js';
import { modules, canOpen, resolveRoute, routeUrl } from '../admin/public/workspace/modules.mjs';
import worker from './worker-admin-api-wrapper.js';

const req=(path,method='GET',body)=>new Request('https://localhost'+path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
const call=(env,path,method,body)=>handleWorkspaceRequest(req(path,method,body),env);

test('mailbox authenticates, rejects inactive users, and preserves role boundaries',async()=>{
  const env=workspaceEnv();
  assert.equal((await handleWorkspaceRequest(new Request('https://church.example/api/admin/mail/items'),env)).status,401);
  env.DB.sqlite.exec("UPDATE admin_users SET status='suspended' WHERE id='tester'");
  assert.equal((await call(env,'/api/admin/mail/items')).status,403);
  const auditor=workspaceEnv('auditor');
  assert.equal((await call(auditor,'/api/admin/mail/items')).status,403);
  assert.equal((await call(auditor,'/api/admin/workspace/reports')).status,403);
  assert.equal((await call(auditor,'/api/admin/workspace/reports?format=csv')).status,403);
});
test('paged lists search, filter, sort, unread and star on separate metadata; delete/restore preserve sources',async()=>{
  const env=workspaceEnv();
  let data=await (await call(env,'/api/admin/mail/items')).json();
  assert.equal(data.total,4);assert.equal(data.items[0].key,'contact:one');assert.equal(data.unread,4);
  const key='contact:one',path='/api/admin/mail/items/'+key;
  await call(env,path,'PATCH',{isRead:true,starred:true});
  data=await(await call(env,'/api/admin/mail/items?folder=unread')).json();assert.equal(data.total,3);
  data=await(await call(env,'/api/admin/mail/items?folder=starred')).json();assert.equal(data.total,1);
  data=await(await call(env,'/api/admin/mail/items?q=Ada&sort=oldest')).json();assert.equal(data.total,1);
  data=await(await call(env,'/api/admin/mail/items?category=non_member')).json();assert.equal(data.total,1);
  await call(env,path,'PATCH',{folder:'archive'});assert.equal((await(await call(env,'/api/admin/mail/items?folder=archive')).json()).total,1);
  await call(env,path,'PATCH',{folder:'deleted'});assert.equal((await(await call(env,'/api/admin/mail/items?folder=deleted')).json()).total,1);
  assert.equal(env.SITE_DB.sqlite.prepare('SELECT count(*) AS n FROM contact_messages').get().n,1);
  await call(env,path,'PATCH',{folder:'inbox',isRead:false});
  assert.equal((await(await call(env,path)).json()).isRead,false);
  assert.equal((await call(env,path,'PATCH',{folder:'trash'})).status,400);
  assert.equal((await call(env,'/api/admin/mail/items/contact:missing')).status,404);
  for(let i=0;i<80;i++)env.SITE_DB.sqlite.prepare('INSERT INTO contact_messages(id,name,email,message,created_at) VALUES(?,?,?,?,?)').run('page-'+i,'Paging','p@example.com','Pagination test','2026-10-01');
  const page1=await(await call(env,'/api/admin/mail/items?page=1')).json(),page2=await(await call(env,'/api/admin/mail/items?page=2')).json();
  assert.equal(page1.items.length,40);assert.equal(page2.items.length,40);assert.equal(page1.total,84);
  assert.equal(page1.items.some(a=>page2.items.some(b=>a.key===b.key)),false);
});
test('drafts survive reload and are private to their administrator',async()=>{
  const env=workspaceEnv(),path='/api/admin/mail/drafts/contact:one';
  const draft={recipient:'ada@example.com',subject:'Re: Question',body:'Draft body',idempotencyKey:'draft-test-key-0001'};
  assert.equal((await call(env,path,'PUT',draft)).status,200);
  assert.equal((await(await call(env,path)).json()).draft.body,'Draft body');
  env.DB.sqlite.prepare("INSERT INTO admin_users(id,email,role,status,invited_at,created_at,updated_at) VALUES('second','second@example.com','administrator','active','2026-10-01','2026-10-01','2026-10-01')").run();env.DEV_BYPASS_EMAIL='second@example.com';
  assert.equal((await(await call(env,path)).json()).draft,null);
  env.DEV_BYPASS_EMAIL='tester@example.com';await call(env,path,'DELETE');assert.equal((await(await call(env,path)).json()).draft,null);
});
test('outbound persists before sending, replays once, rejects changed keys, and retries with original provider key',async()=>{
  const env=workspaceEnv();const original=globalThis.fetch;let attempts=0,headers=[],payloads=[];
  globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.resend.com/emails');attempts++;headers.push(options.headers);payloads.push(JSON.parse(options.body));assert.equal(env.SITE_DB.sqlite.prepare('SELECT count(*) AS n FROM mailbox_outbound').get().n,1);return Response.json({id:'provider-1'},{status:200});};
  try {
    const body={recipient:'ada@example.com',subject:'Re: Question',body:'Reply <script>bad()</script>',itemKey:'contact:one',idempotencyKey:'send-test-key-0001'};
    let response=await call(env,'/api/admin/mail/send','POST',body);assert.equal(response.status,200);
    assert.equal((await response.json()).outbound.status,'accepted');
    response=await call(env,'/api/admin/mail/send','POST',body);assert.equal(response.status,200);assert.equal(attempts,1);
    assert.match(payloads[0].html,/&lt;script&gt;/);assert.doesNotMatch(payloads[0].html,/<script>/);
    assert.equal((await call(env,'/api/admin/mail/send','POST',{...body,body:'Changed'})).status,409);
    assert.equal((await(await call(env,'/api/admin/mail/items/contact:one')).json()).replies.length,1);
    const row=env.SITE_DB.sqlite.prepare('SELECT * FROM mailbox_outbound').get();env.SITE_DB.sqlite.exec("UPDATE mailbox_outbound SET status='failed'");
    globalThis.fetch=async(url,options)=>{attempts++;headers.push(options.headers);return Response.json({id:'provider-1'});};
    response=await call(env,'/api/admin/mail/outbound/'+row.id+'/retry','POST',{});assert.equal(response.status,200);assert.equal(headers[0]['Idempotency-Key'],headers[1]['Idempotency-Key']);
    env.SITE_DB.sqlite.exec("UPDATE mailbox_outbound SET status='uncertain',created_at='2020-01-01'");
    response=await call(env,'/api/admin/mail/outbound/'+row.id+'/retry','POST',{});assert.equal(response.status,409);assert.equal(attempts,2);
    assert.equal((await call(env,'/api/admin/mail/send','POST',{...body,recipient:'bad\naddress'})).status,400);
  }finally{globalThis.fetch=original;}
});
test('send claim serializes concurrent requests and preserves uncertain failures',async()=>{
  const env=workspaceEnv();await env.SITE_DB.prepare("INSERT INTO mailbox_outbound(id,actor,recipient,subject,body,idempotency_key,created_at,updated_at) VALUES('send-a','tester@example.com','ada@example.com','Test','Body','concurrent-key-0001',?,?)").bind(new Date().toISOString(),new Date().toISOString()).run();
  let release;const blocker=new Promise(r=>release=r);let sends=0;
  const first=sendOutbound(env,'send-a','tester@example.com',{send:async()=>{sends++;await blocker;return {ok:false,status:0,error:'Network timeout'};}});
  await new Promise(r=>setTimeout(r,0));
  await assert.rejects(sendOutbound(env,'send-a','tester@example.com',{send:async()=>{sends++;return {ok:true};}}),/already being sent/);
  release();assert.equal((await first).status,'uncertain');assert.equal(sends,1);
  await assert.rejects(sendOutbound(env,'send-a','other@example.com'),/not found/);
});
test('rental decisions retain source delivery status, guard versions and reject overlapping approved facilities',async()=>{
  const env=workspaceEnv();const path=id=>'/api/admin/workspace/rentals/'+id;
  assert.equal((await call(env,path('rent-a'),'PATCH',{status:'approved',version:0})).status,200);
  assert.equal((await call(env,path('rent-b'),'PATCH',{status:'approved',version:0})).status,409);
  assert.equal((await call(env,path('rent-c'),'PATCH',{status:'approved',version:0})).status,200);
  assert.equal((await call(env,path('rent-a'),'PATCH',{status:'declined',version:0})).status,409);
  assert.equal((await call(env,path('rent-a'),'PATCH',{status:'declined',version:1})).status,200);
  assert.equal((await call(env,path('rent-b'),'PATCH',{status:'approved',version:0})).status,200);
  assert.equal(env.SITE_DB.sqlite.prepare("SELECT status FROM facility_rental_requests WHERE id='rent-a'").get().status,'received');
  const schedule=await(await call(env,'/api/admin/workspace/schedule?from=2026-10-01&to=2026-10-31')).json();assert.equal(schedule.rentals.length,3);assert.equal(schedule.rentals[0].facilities[0],'Fellowship Hall');
});
test('reports use bounded operational data and enforce role access',async()=>{
  const env=workspaceEnv();let response=await call(env,'/api/admin/workspace/reports?from=2026-10-01&to=2026-10-31');
  const data=await response.json();assert.equal(data.sections.submissions.reduce((n,r)=>n+r.count,0),4);assert.equal(data.sections.finance,undefined);
  response=await call(env,'/api/admin/workspace/reports?from=2026-10-01&to=2026-10-31&format=csv');assert.match(await response.text(),/"facility_rental"/);
  const auditor=workspaceEnv('auditor');assert.equal((await call(auditor,'/api/admin/workspace/reports?format=csv')).status,403);
  assert.equal((await call(env,'/api/admin/workspace/reports?from=2020-01-01&to=2026-10-31')).status,400);
  assert.equal(csvCell('=HYPERLINK("evil")'),'"\'=HYPERLINK(""evil"")"');assert.equal(escapeHtml('<img>'),'&lt;img&gt;');
});
test('deep links resolve modules and legacy routes without resurrecting retired dashboard',()=>{
  assert.deepEqual(resolveRoute(routeUrl('mail','contact:one')),{module:'mail',key:'contact:one'});
  assert.equal(resolveRoute('/admin/finances_funds.html'),null);
  assert.equal(resolveRoute('/admin/finances/dashboard'),null);
  assert.equal(resolveRoute('/admin/finances_dashboard.html'),null);
  assert.equal(modules.some(m=>m.id==='finances'||m.id==='giving'),false);
  assert.equal(resolveRoute('/admin','#submissions').module,'mail');
});
test('unauthenticated shell deep links redirect to Access and never return admin HTML',async()=>{
  const response=await worker.fetch(new Request('https://church.example/admin/mail/thread/contact%3Aone'),{},{});
  assert.equal(response.status,302);assert.match(response.headers.get('location'),/cdn-cgi\/access\/login/);assert.equal(await response.text(),'');
});
