import { authenticateAdminRequest, requirePermission, authErrorResponse } from './admin-auth.js';

const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
const clean=(value,max=120)=>typeof value==='string'?value.trim().slice(0,max):'';
const parse=value=>{try{return JSON.parse(value);}catch{return {};}};
function fail(message,status=400){const error=new Error(message);error.status=status;throw error;}
function cents(value){
  if(value===undefined||value===null||value==='')return 0;
  const amount=Number(value),result=Math.round(amount*100);
  if(!Number.isFinite(amount)||amount<0||!Number.isSafeInteger(result))fail('Enter a valid nonnegative money amount.');
  return result;
}
function date(value,required=false){
  const s=clean(value,10);
  if(!s&&!required)return '';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)fail('Enter a valid date.');
  return s;
}
function year(value){const s=clean(String(value||''),100);if(s&&!/^\d{4}$/.test(s))fail('Enter a four-digit compensation year.');return s;}
function link(value){const s=clean(value,400);if(s&&!/^https?:\/\//i.test(s)&&!s.startsWith('/'))fail('Documents must use an HTTPS, HTTP, or site-relative URL.');if(s.startsWith('//'))fail('Use an absolute document URL.');return s;}
const restricted=f=>['temporarily_restricted','permanently_restricted'].includes(f.restrictionStatus);
const stamp=()=>new Date().toISOString();
function audit(db,user,action,id,value){return db.prepare('INSERT INTO finance_operations_audit(id,actor,action,record_id,value_json,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),user.email,action,id,JSON.stringify(value),stamp());}

// SQL also used in conditional transfer writes: pending outgoing transfers
// reserve funds; pending incoming deposits never fund a transfer.
function availableSql(alias='f',exclude=''){
  return `(COALESCE((SELECT json_extract(profile_json,'$.openingBalanceCents') FROM finance_fund_profiles WHERE fund_id=${alias}.id),0)
    +COALESCE((SELECT SUM(CASE WHEN type='income' THEN abs(amount_cents) ELSE -abs(amount_cents) END) FROM finance_entries e
      WHERE (e.fund_id=${alias}.id OR ((e.fund_id IS NULL OR e.fund_id='') AND (e.fund=${alias}.fund_name OR (${alias}.fund_code<>'' AND e.fund=${alias}.fund_code))))
      AND e.status NOT IN ('voided','reversed') AND (e.status='posted' OR e.type='expense')),0)
    +COALESCE((SELECT SUM(amount_cents) FROM finance_fund_transfers WHERE to_fund_id=${alias}.id AND status='approved'),0)
    -COALESCE((SELECT SUM(amount_cents) FROM finance_fund_transfers WHERE from_fund_id=${alias}.id AND status IN ('approved','pending_approval') ${exclude}),0))`;
}
async function balances(db,asOf='9999-12-31'){
  const [fundRows,entryRows,transferRows]=await Promise.all([
    db.prepare('SELECT f.*,p.profile_json FROM finance_funds f LEFT JOIN finance_fund_profiles p ON p.fund_id=f.id ORDER BY lower(f.fund_name)').all(),
    db.prepare("SELECT * FROM finance_entries WHERE entry_date<=? AND status NOT IN ('voided','reversed')").bind(asOf).all(),
    db.prepare('SELECT * FROM finance_fund_transfers WHERE substr(created_at,1,10)<=? ORDER BY created_at DESC').bind(asOf).all()
  ]);
  const funds=fundRows.results.map(row=>({fundType:'general_operating',restrictionStatus:'unrestricted',openingBalanceCents:0,minimumBalanceWarningCents:0,budgetAmountCents:0,...parse(row.profile_json),
    id:row.id,fundName:row.fund_name,fundCode:row.fund_code||'',active:Boolean(row.active),createdAt:row.created_at,updatedAt:row.updated_at,currentBalanceCents:0,pendingDepositsCents:0,pendingExpensesCents:0,reservedTransfersCents:0}));
  for(const f of funds){
    f.currentBalanceCents=f.openingBalanceCents;
    for(const e of entryRows.results){
      if(e.fund_id?e.fund_id!==f.id:![f.fundName,f.fundCode].filter(Boolean).includes(e.fund))continue;
      const amount=Math.abs(e.amount_cents);
      if(e.status==='posted')f.currentBalanceCents+=e.type==='income'?amount:-amount;
      else if(e.type==='income')f.pendingDepositsCents+=amount;else f.pendingExpensesCents+=amount;
    }
    for(const t of transferRows.results){
      if(t.status==='approved'){if(t.from_fund_id===f.id)f.currentBalanceCents-=t.amount_cents;if(t.to_fund_id===f.id)f.currentBalanceCents+=t.amount_cents;}
      else if(t.status==='pending_approval'&&t.from_fund_id===f.id)f.reservedTransfersCents+=t.amount_cents;
    }
    f.availableBalanceCents=f.currentBalanceCents-f.pendingExpensesCents-f.reservedTransfersCents;
  }
  return {funds,entries:entryRows.results,transfers:transferRows.results.map(t=>({id:t.id,fromFundId:t.from_fund_id,toFundId:t.to_fund_id,amountCents:t.amount_cents,reason:t.reason,status:t.status,requestedBy:t.requested_by,approvedBy:t.approved_by,createdAt:t.created_at}))};
}
async function fundCreate(db,body,user){
  const fundName=clean(body.fundName),fundCode=clean(body.fundCode,30);
  if(!fundName)fail('Fund name is required.');
  if(await db.prepare('SELECT id FROM finance_funds WHERE lower(fund_name)=lower(?) OR (?<>\'\' AND lower(fund_code)=lower(?))').bind(fundName,fundCode,fundCode).first())fail('A fund with this name or code already exists.',409);
  const restrictionStatus=clean(body.restrictionStatus,40)||'unrestricted';
  if(!['unrestricted','board_designated','temporarily_restricted','permanently_restricted','needs_treasurer_review'].includes(restrictionStatus))fail('Choose a valid restriction status.');
  const id=crypto.randomUUID(),at=stamp(),profile={fundType:clean(body.fundType,60).toLowerCase().replace(/\s+/g,'_')||'general_operating',restrictionStatus,
    description:clean(body.description,500),openingBalanceCents:cents(body.openingBalance),minimumBalanceWarningCents:cents(body.minimumBalanceWarning),budgetAmountCents:cents(body.budgetAmount),
    responsibleMinistry:clean(body.responsibleMinistry),responsibleAdministrator:clean(body.responsibleAdministrator),notes:clean(body.notes,3000),createdBy:user.email};
  await db.batch([
    db.prepare('INSERT INTO finance_funds(id,fund_name,fund_code,active,created_at,updated_at) VALUES(?,?,?,1,?,?)').bind(id,fundName,fundCode,at,at),
    db.prepare('INSERT INTO finance_fund_profiles(fund_id,profile_json,updated_at) VALUES(?,?,?)').bind(id,JSON.stringify(profile),at),
    audit(db,user,'fund.created',id,profile)
  ]);
  return json({ok:true,fund:{id,fundName,fundCode,active:true,...profile}},201);
}
async function transfer(db,body,user){
  const from=clean(body.fromFundId,80),to=clean(body.toFundId,80),amount=cents(body.amount),reason=clean(body.reason,2000);
  if(!from||!to||from===to||!amount||!reason)fail('Choose different funds, a positive amount, and a reason.');
  const {funds}=await balances(db),source=funds.find(f=>f.id===from&&f.active),destination=funds.find(f=>f.id===to&&f.active);
  if(!source||!destination)fail('Choose valid active funds.');
  const key=clean(body.idempotencyKey,100);
  if(!/^[a-zA-Z0-9_-]{16,100}$/.test(key))fail('A valid transfer request key is required.');
  const requestKey=user.email+':'+key;
  const existing=await db.prepare('SELECT * FROM finance_fund_transfers WHERE request_key=?').bind(requestKey).first();
  if(existing){if(existing.from_fund_id!==from||existing.to_fund_id!==to||existing.amount_cents!==amount||existing.reason!==reason)fail('This transfer request key belongs to different details.',409);return json({ok:true,transfer:{id:existing.id,status:existing.status}});}
  const status=restricted(source)||restricted(destination)?'pending_approval':'approved',id=crypto.randomUUID(),at=stamp();
  const result=await db.prepare(`INSERT INTO finance_fund_transfers(id,request_key,from_fund_id,to_fund_id,amount_cents,reason,status,requested_by,approved_by,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,? FROM finance_funds f WHERE f.id=? AND f.active=1 AND ${availableSql()}>=?
      AND EXISTS(SELECT 1 FROM finance_funds WHERE id=? AND active=1)`)
    .bind(id,requestKey,from,to,amount,reason,status,user.email,status==='approved'?user.email:null,at,at,from,amount,to).run();
  if(!result.meta.changes)fail('The source fund has insufficient available funds or changed. Refresh and review.',409);
  await audit(db,user,'transfer.requested',id,{from,to,amount,status,reason}).run();
  return json({ok:true,transfer:{id,status}},201);
}
async function decision(db,id,body,user){
  if(!['approved','declined'].includes(body.status))fail('Choose approved or declined.');
  const row=await db.prepare('SELECT * FROM finance_fund_transfers WHERE id=?').bind(id).first();
  if(!row)fail('Transfer not found.',404);
  if(row.requested_by===user.email)fail('A different Finance Officer must review this restricted transfer.',403);
  const result=await db.prepare(`UPDATE finance_fund_transfers AS reviewing SET status=?,approved_by=?,updated_at=? WHERE id=? AND status='pending_approval'
    AND (?='declined' OR EXISTS(SELECT 1 FROM finance_funds f WHERE f.id=reviewing.from_fund_id AND f.active=1
      AND ${availableSql('f','AND id<>reviewing.id')}>=reviewing.amount_cents
      AND EXISTS(SELECT 1 FROM finance_funds WHERE id=reviewing.to_fund_id AND active=1)))`)
    .bind(body.status,user.email,stamp(),id,body.status).run();
  if(!result.meta.changes)fail('The transfer changed or the balance is insufficient. Refresh and review.',409);
  await audit(db,user,'transfer.'+body.status,id,body).run();
  return json({ok:true});
}
async function housing(db,body,user,annual=false){
  const id=crypto.randomUUID(),at=stamp();let record,profile;
  if(annual){
    profile=await db.prepare('SELECT * FROM finance_housing_profiles WHERE id=?').bind(clean(body.profileId,80)).first();
    if(!profile)fail('Choose an existing minister profile.');
    record={id,profileId:profile.id,compensationYear:year(body.compensationYear)||parse(profile.record_json).compensationYear,notes:clean(body.notes,3000),accountantReviewStatus:'needs_review',createdAt:at,createdBy:user.email};
    for(const key of ['designatedAmount','amountPaid','actualHousingExpenses','fairRentalValue','utilities','parsonageValue'])record[key+'Cents']=cents(body[key]);
    record.recordkeepingComparisonCents=Math.min(record.designatedAmountCents,record.actualHousingExpensesCents,record.fairRentalValueCents+record.utilitiesCents);
    record.recordkeepingNotice='Recordkeeping comparison only. Review with a qualified tax professional.';
  }else{
    const ministerName=clean(body.ministerName);if(!ministerName)fail('Minister name is required.');
    record={id,ministerName,positionTitle:clean(body.positionTitle),ordinationStatus:clean(body.ordinationStatus,40),compensationYear:year(body.compensationYear),
      designationEffectiveDate:date(body.designationEffectiveDate),dateApproved:date(body.dateApproved),approvingBody:clean(body.approvingBody,160),resolutionAttachment:link(body.resolutionAttachment),notes:clean(body.notes,3000),status:'active',createdAt:at,createdBy:user.email};
    for(const key of ['totalCompensation','salaryAmount','housingAllowanceDesignatedAmount'])record[(key==='housingAllowanceDesignatedAmount'?'housingAllowanceDesignated':key)+'Cents']=cents(body[key]);
  }
  const insert=annual?db.prepare('INSERT INTO finance_housing_annual_records(id,profile_id,record_json,created_at) VALUES(?,?,?,?)').bind(id,profile.id,JSON.stringify(record),at):db.prepare('INSERT INTO finance_housing_profiles(id,record_json,created_at) VALUES(?,?,?)').bind(id,JSON.stringify(record),at);
  await db.batch([insert,audit(db,user,annual?'housing.annual.created':'housing.profile.created',id,record)]);
  return json({ok:true,...(annual?{annualRecord:record}:{profile:record})},201);
}
async function board(db,body,user){
  const reportDate=date(body.reportDate,true),priorDate=date(body.priorDate),liabilities=cents(body.liabilitiesCents);
  if(priorDate&&priorDate>reportDate)fail('The comparison date must precede the report date.');
  const {funds,entries}=await balances(db,reportDate),prior=priorDate?await balances(db,priorDate):null;
  const assets=funds.reduce((n,f)=>n+f.currentBalanceCents,0),withRestriction=funds.filter(restricted).reduce((n,f)=>n+f.currentBalanceCents,0);
  const posted=entries.filter(e=>e.status==='posted'),sum=(type,prefix)=>posted.filter(e=>e.type===type&&e.entry_date.startsWith(prefix)).reduce((n,e)=>n+Math.abs(e.amount_cents),0);
  const month=reportDate.slice(0,7),yr=reportDate.slice(0,4),revenue=sum('income',yr),expense=sum('expense',yr);
  const pkg={id:crypto.randomUUID(),generatedAt:stamp(),generatedBy:user.email,reportDate,priorDate,
    statementOfFinancialPosition:{assetsCents:assets,liabilitiesCents:liabilities,netWithoutRestrictionCents:assets-withRestriction-liabilities,netWithRestrictionCents:withRestriction,netAssetsCents:assets-liabilities,funds},
    statementOfActivities:{currentMonthRevenueCents:sum('income',month),currentMonthExpenseCents:sum('expense',month),ytdRevenueCents:revenue,ytdExpenseCents:expense,totalChangeInNetAssetsCents:revenue-expense},
    comparison:prior?{date:priorDate,funds:prior.funds}:null,boardNotes:clean(body.boardNotes,5000),basis:'Recorded fund opening balances and posted ledger entries; review completeness before distribution.'};
  await db.batch([db.prepare('INSERT INTO finance_board_report_packages(id,package_json,created_at) VALUES(?,?,?)').bind(pkg.id,JSON.stringify(pkg),pkg.generatedAt),audit(db,user,'board.generated',pkg.id,{reportDate,priorDate})]);
  return json({ok:true,package:pkg},201);
}

export async function handleFinanceOperations(request,env,ensureSchema){
  const path=new URL(request.url).pathname,method=request.method;
  if(!['/api/finances/funds','/api/finances/funds/dashboard','/api/finances/funds/transfers','/api/finances/clergy-housing','/api/finances/clergy-housing/profiles','/api/finances/clergy-housing/annual-records','/api/finances/controls/dashboard','/api/finances/reports/board','/api/finances/reports/board/generate'].includes(path)&&!/^\/api\/finances\/funds\/transfers\/[^/]+\/review$/.test(path))return null;
  try{
    const {user}=await authenticateAdminRequest(request,env,env.__ACCESS_JWKS?{jwks:env.__ACCESS_JWKS}:{});
    requirePermission(user,path.includes('clergy-housing')?'finance.statements_controls':path.includes('/reports/')?'finance.reports_receipts':'finance.view');
    if(method!=='GET')requirePermission(user,path.includes('/funds')?'finance.funds_categories':'finance.statements_controls');
    await ensureSchema(env);const db=env.DB;
    const body=method==='GET'?{}:await request.json();
    if(path==='/api/finances/funds'&&method==='POST')return await fundCreate(db,body,user);
    if(path==='/api/finances/funds/transfers'&&method==='POST')return await transfer(db,body,user);
    if(path.endsWith('/review')&&method==='POST')return await decision(db,path.split('/').at(-2),body,user);
    if(path==='/api/finances/funds/dashboard'&&method==='GET'){
      const data=await balances(db),active=data.funds.filter(f=>f.active),total=condition=>active.filter(condition).reduce((n,f)=>n+f.currentBalanceCents,0);
      return json({...data,summary:{totalUnrestrictedFundsCents:total(f=>!restricted(f)),totalRestrictedFundsCents:total(restricted),generalOperatingBalanceCents:total(f=>f.fundType==='general_operating'),savingsAndReservesCents:total(f=>/saving|reserve/.test(f.fundType))}});
    }
    if(path==='/api/finances/funds'&&method==='GET')return json({funds:(await balances(db)).funds.filter(f=>f.active)});
    if(path==='/api/finances/clergy-housing'&&method==='GET'){
      const [profiles,annualRecords]=await Promise.all([db.prepare('SELECT record_json FROM finance_housing_profiles ORDER BY created_at DESC').all(),db.prepare('SELECT record_json FROM finance_housing_annual_records ORDER BY created_at DESC').all()]);
      return json({profiles:profiles.results.map(r=>parse(r.record_json)),annualRecords:annualRecords.results.map(r=>parse(r.record_json))});
    }
    if(path==='/api/finances/clergy-housing/profiles'&&method==='POST')return await housing(db,body,user);
    if(path==='/api/finances/clergy-housing/annual-records'&&method==='POST')return await housing(db,body,user,true);
    if(path==='/api/finances/controls/dashboard'&&method==='GET'){
      const rows=await db.prepare("SELECT status,COUNT(*) AS count,SUM(calculated_batch_total_cents) AS totalCents,SUM(discrepancy_cents) AS discrepancyCents FROM finance_collection_batches GROUP BY status").all();
      return json({dashboard:{collectionsByStatus:rows.results,source:'Existing collection batches and approvals'}});
    }
    if(path==='/api/finances/reports/board'&&method==='GET'){
      const rows=await db.prepare('SELECT package_json FROM finance_board_report_packages ORDER BY created_at DESC LIMIT 20').all();return json({packages:rows.results.map(r=>parse(r.package_json))});
    }
    if(path==='/api/finances/reports/board/generate'&&method==='POST')return await board(db,body,user);
    return json({error:'Method not allowed.'},405);
  }catch(error){if(error.code)return authErrorResponse(error);return json({error:error.status?error.message:'Finance request failed. Please try again.'},error.status||500);}
}
