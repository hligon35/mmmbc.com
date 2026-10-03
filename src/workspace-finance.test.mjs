import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './worker-admin-api-wrapper.js';
import { workspaceEnv } from './test-support/workspace-db.mjs';
import { handleSitePageGet, handleSitePageDraftPut, handleSitePagePublishPost } from './worker-site-editor.js';

const request=(path,method='GET',body)=>new Request('https://localhost'+path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
const call=(env,path,method,body)=>worker.fetch(request(path,method,body),env,{waitUntil(){}});
async function createFund(env,name,amount='100.00',restriction='unrestricted'){
  const response=await call(env,'/api/finances/funds','POST',{fundName:name,openingBalance:amount,fundType:'General Operating',restrictionStatus:restriction});
  assert.equal(response.status,201,JSON.stringify(await response.clone().json()));return (await response.json()).fund;
}
test('D1 funds preserve profiles and combine posted, pending, voided and transferred money',async()=>{
  const env=workspaceEnv(),a=await createFund(env,'General'),b=await createFund(env,'Building','0');
  assert.equal((await call(env,'/api/finances/funds','POST',{fundName:'General'})).status,409);
  const put=env.DB.sqlite.prepare('INSERT INTO finance_entries(id,entry_date,type,fund_id,amount_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
  for(const [id,type,amount,status]of [['income','income',2000,'posted'],['expense','expense',500,'posted'],['pending','expense',1000,'pending'],['deposit','income',20000,'pending'],['void','income',50000,'voided']])put.run(id,'2026-10-01',type,a.id,amount,status,'2026-10-01','2026-10-01');
  put.run('unassigned','2026-10-01','income',null,999999,'posted','2026-10-01','2026-10-01');
  let dashboard=await(await call(env,'/api/finances/funds/dashboard')).json(),fund=dashboard.funds.find(f=>f.id===a.id);
  assert.equal(fund.currentBalanceCents,11500);assert.equal(fund.availableBalanceCents,10500);assert.equal(fund.pendingDepositsCents,20000);assert.equal(fund.fundType,'general_operating');
  assert.equal((await call(env,'/api/finances/funds/transfers','POST',{idempotencyKey:crypto.randomUUID(),fromFundId:a.id,toFundId:b.id,amount:'106',reason:'Too much'})).status,409);
  assert.equal((await call(env,'/api/finances/funds/transfers','POST',{idempotencyKey:crypto.randomUUID(),fromFundId:a.id,toFundId:b.id,amount:'25',reason:'Building allocation'})).status,201);
  dashboard=await(await call(env,'/api/finances/funds/dashboard')).json();assert.equal(dashboard.funds.find(f=>f.id===a.id).currentBalanceCents,9000);assert.equal(dashboard.funds.find(f=>f.id===b.id).currentBalanceCents,2500);
});
test('restricted transfers reserve balances and require independent review with stale checks',async()=>{
  const env=workspaceEnv(),a=await createFund(env,'Restricted','100','temporarily_restricted'),b=await createFund(env,'General','0');
  const body={idempotencyKey:crypto.randomUUID(),fromFundId:a.id,toFundId:b.id,amount:'60',reason:'Board-reviewed request'};
  const response=await call(env,'/api/finances/funds/transfers','POST',body),transfer=(await response.json()).transfer;
  assert.equal(response.status,201);assert.equal(transfer.status,'pending_approval');
  assert.equal((await call(env,'/api/finances/funds/transfers','POST',body)).status,200);
  assert.equal((await call(env,'/api/finances/funds/transfers','POST',{...body,idempotencyKey:crypto.randomUUID()})).status,409);
  const path='/api/finances/funds/transfers/'+transfer.id+'/review';
  assert.equal((await call(env,path,'POST',{status:'approved'})).status,403);
  env.DB.sqlite.prepare("INSERT INTO admin_users(id,email,role,status,invited_at,created_at,updated_at) VALUES('officer','officer@example.com','treasurer','active','2026-10-01','2026-10-01','2026-10-01')").run();env.DEV_BYPASS_EMAIL='officer@example.com';
  assert.equal((await call(env,path,'POST',{status:'approved'})).status,200);
  assert.equal((await call(env,path,'POST',{status:'approved'})).status,409);
  const dashboard=await(await call(env,'/api/finances/funds/dashboard')).json();assert.equal(dashboard.funds.find(f=>f.id===a.id).currentBalanceCents,4000);assert.equal(dashboard.funds.find(f=>f.id===b.id).currentBalanceCents,6000);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM finance_operations_audit').get().n,4);
});
test('finance APIs honor active roles, auditor read-only, and finance-entry limits',async()=>{
  for(const role of ['auditor','finance_entry','website_editor']){
    const env=workspaceEnv(role),read=role==='website_editor'?403:200;
    assert.equal((await call(env,'/api/finances/funds/dashboard')).status,read);
    assert.equal((await call(env,'/api/finances/funds','POST',{fundName:'Denied'})).status,403);
    assert.equal((await call(env,'/api/finances/clergy-housing')).status,403);
    assert.equal((await call(env,'/api/finances/reports/board/generate','POST',{reportDate:'2026-10-01'})).status,403);
  }
  const env=workspaceEnv('auditor');assert.equal((await call(env,'/api/finances/reports/board')).status,200);
  assert.equal((await call(env,'/api/finances/collections','POST',{serviceDate:'2026-10-03'})).status,403);
});
test('housing records, controls, and dated board reports persist real D1 results',async()=>{
  const env=workspaceEnv();await createFund(env,'Operating','250');
  assert.equal((await call(env,'/api/finances/clergy-housing/profiles','POST',{ministerName:'Minister',resolutionAttachment:'javascript:alert(1)'})).status,400);
  let response=await call(env,'/api/finances/clergy-housing/profiles','POST',{ministerName:'Minister',compensationYear:'2026',totalCompensation:'50000',housingAllowanceDesignatedAmount:'10000'});
  assert.equal(response.status,201);const profile=(await response.json()).profile;
  response=await call(env,'/api/finances/clergy-housing/annual-records','POST',{profileId:profile.id,designatedAmount:'10000',actualHousingExpenses:'12000',fairRentalValue:'8000',utilities:'1000'});
  assert.equal(response.status,201);assert.equal((await response.json()).annualRecord.recordkeepingComparisonCents,900000);
  const housing=await(await call(env,'/api/finances/clergy-housing')).json();assert.equal(housing.profiles[0].totalCompensationCents,5000000);assert.equal(housing.annualRecords.length,1);
  assert.equal((await call(env,'/api/finances/controls/dashboard')).status,200);
  response=await call(env,'/api/finances/reports/board/generate','POST',{reportDate:'2026-10-03',priorDate:'2026-09-30',liabilitiesCents:'50',boardNotes:'Review'});
  assert.equal(response.status,201);const p=(await response.json()).package,s=p.statementOfFinancialPosition;
  assert.equal(s.assetsCents,25000);assert.equal(s.liabilitiesCents,5000);assert.equal(s.netAssetsCents,20000);assert.equal(s.assetsCents,s.liabilitiesCents+s.netAssetsCents);
  assert.equal((await(await call(env,'/api/finances/reports/board')).json()).packages.length,1);
});
test('site editor rejects stale saved drafts and publishing versions',async()=>{
  const env=workspaceEnv(),initial=await(await handleSitePageGet(request('/'),env,'home')).json();
  const save=(version,title)=>handleSitePageDraftPut(request('/','PUT',{fields:{'hero.cta.text':title},baseVersion:version}),env,'home','tester@example.com');
  assert.equal((await save(initial.draft.version,'Updated title')).status,200);
  assert.equal((await save(initial.draft.version,'Stale title')).status,409);
  assert.equal((await handleSitePagePublishPost(request('/','POST',{baseVersion:initial.draft.version}),env,'home','tester@example.com')).status,409);
  assert.equal((await handleSitePagePublishPost(request('/','POST',{baseVersion:initial.draft.version+1}),env,'home','tester@example.com')).status,200);
});
