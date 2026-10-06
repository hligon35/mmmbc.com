import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from './worker-admin-api-wrapper.js';
import {workspaceEnv} from './test-support/workspace-db.mjs';
import {modules,resolveRoute} from '../admin/public/workspace/modules.mjs';
import {publicRoleDefinitions} from './admin-rbac.js';
import {ZEFFY_DONATION_URL} from './worker-giving-pages.js';
import {buildData,buildAdminSql} from '../scripts/seed_demo_data.mjs';

test('fresh migrations and demo data require no financial dashboard tables',()=>{
  const env=workspaceEnv();
  assert.deepEqual(env.DB.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'finance_%' ORDER BY name").all(),[{name:'finance_entries'}]);
  const sql=buildAdminSql(buildData({count:10,asOf:'2026-10-04T12:00:00Z'}));
  assert.doesNotMatch(sql,/finance_(?:funds|donors|collection|scan|housing|board|operations)/);
  assert.match(sql,/directory_contacts/);
});
test('removed finance URLs and assets have no handlers or shell aliases',async()=>{
  const env=workspaceEnv();env.ASSETS={fetch:async()=>new Response('Missing',{status:404})};
  for(const path of ['/admin/finances/funds','/admin/finances/controls','/admin/finances/clergy-housing','/admin/finances/envelopes','/admin/finances/reports/board','/admin/finances_funds.html','/admin/finances_donors.html','/admin/finance_modern.js','/admin/finance_envelope_designer.js','/admin/giving']) {
    assert.equal(resolveRoute(path),null,path);
    const response=await worker.fetch(new Request('https://localhost'+path),env,{});
    assert.equal(response.status,404,path);
  }
  for(const path of ['/api/finances','/api/finances/entries','/api/finances/funds','/api/finances/funds/transfers','/api/finances/controls/dashboard','/api/finances/clergy-housing','/api/finances/reports/board/generate','/api/finances/donors','/api/finances/collections','/api/finances/statements'])for(const method of ['GET','POST','PUT','DELETE']) {
    const response=await worker.fetch(new Request('https://localhost'+path,{method}),env,{});
    assert.equal(response.status,404,method+' '+path);
  }
  assert.equal(modules.some(m=>m.id==='finances'),true);
  assert.equal(modules.some(m=>m.id==='giving'),false);
  const roles=publicRoleDefinitions();
  assert.equal(roles.find(r=>r.key==='finance_entry').permissions.includes('finance.record'),true);
  assert.equal(roles.find(r=>r.key==='auditor').permissions.some(p=>p.startsWith('finance.')),false);
  assert.doesNotMatch(fs.readFileSync('admin/public/index.html','utf8'),/tab-finances|\/admin\/finance_.*\.js/);
});
test('Giving remains independent and checkout stays opt-in',async()=>{
  const env=workspaceEnv();env.ASSETS={fetch:async()=>new Response('Missing',{status:404})};
  for(const method of ['GET','HEAD']) {
    const response=await worker.fetch(new Request('https://localhost/give',{method}),env,{});
    assert.equal(response.status,302);assert.equal(response.headers.get('Location'),ZEFFY_DONATION_URL);
  }
  const checkout=await worker.fetch(new Request('https://localhost/api/giving/checkout',{method:'POST'}),env,{});
  assert.equal(checkout.status,404);
  env.GIVING_PROVIDER='stripe';
  const configured=await worker.fetch(new Request('https://localhost/api/giving/checkout',{method:'POST'}),env,{});
  assert.equal(configured.status,503);
});

test('directory saves, updates, and lists contacts without financial donor tables',async()=>{
  const env=workspaceEnv();
  const call=(path,method,body)=>worker.fetch(new Request('https://localhost'+path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env,{});
  const body={firstName:'Ada',lastName:'Brown',primaryEmail:'ada@example.com',contactType:'member',status:'active',accountNumber:'MM-12345678'};
  const created=await call('/api/directory/contacts','POST',body);
  assert.equal(created.status,201);
  const id=env.DB.sqlite.prepare("SELECT id FROM directory_contacts WHERE account_number='MM-12345678'").get().id;
  assert.equal((await call('/api/directory/contacts/'+id,'PUT',{...body,firstName:'Adaline'})).status,200);
  const list=await call('/api/directory/contacts','GET');assert.equal(list.status,200);
  assert.match(JSON.stringify(await list.json()),/Adaline/);
  assert.deepEqual(env.DB.sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'finance_%' ORDER BY name").all(),[{name:'finance_entries'}]);
});

test('optional Stripe checkout and signed webhook work without a finance ledger',async()=>{
  const env=workspaceEnv();Object.assign(env,{GIVING_PROVIDER:'stripe',STRIPE_SECRET_KEY:'mock',STRIPE_CONNECTED_ACCOUNT_ID:'acct_mock',STRIPE_WEBHOOK_SECRET:'mock_webhook'});
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
    assert.equal(String(url),'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(init.headers['Stripe-Account'],'acct_mock');
    return Response.json({id:'cs_mock',url:'https://checkout.stripe.com/mock'});
  };
  try {
    const response=await worker.fetch(new Request('https://localhost/api/giving/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amountCents:1000,fund:'offering',donorName:'Test Donor',donorEmail:'donor@example.com'})}),env,{});
    assert.equal(response.status,200);
    assert.equal((await response.json()).sessionId,'cs_mock');
  } finally {globalThis.fetch=originalFetch;}
  const timestamp=String(Math.floor(Date.now()/1000));
  const body=JSON.stringify({id:'evt_mock',type:'checkout.session.completed',account:'acct_mock',data:{object:{id:'cs_mock',payment_status:'paid',amount_total:1000,metadata:{fund:'offering'},customer_details:{email:'donor@example.com'}}}});
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+'.'+body))).toString('hex');
  const webhook=()=>new Request('https://localhost/api/stripe/webhook',{method:'POST',headers:{'Stripe-Signature':`t=${timestamp},v1=${signature}`},body});
  assert.equal((await worker.fetch(webhook(),env,{})).status,200);
  assert.equal((await(await worker.fetch(webhook(),env,{})).json()).duplicate,true);
  assert.equal(env.DB.sqlite.prepare("SELECT payment_status FROM giving_donations WHERE stripe_checkout_session_id='cs_mock'").get().payment_status,'paid');
  assert.deepEqual(env.DB.sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'finance_%' ORDER BY name").all(),[{name:'finance_entries'}]);
});
