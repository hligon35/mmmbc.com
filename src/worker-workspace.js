import { authenticateAdminRequest, authErrorResponse, requirePermission, requireAnyPermission, isValidEmail } from './admin-auth.js';
import { sendResendEmail } from './email-resend.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const now = () => new Date().toISOString();
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const parse = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[\s]*[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
function invalid(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
export function parseItemKey(key) {
  const match = /^(contact|facility_rental|outbound):([a-zA-Z0-9_-]{1,100})$/.exec(key || '');
  if (!match) invalid('Invalid message identifier.');
  return { type: match[1], id: match[2] };
}
function metadata(row) {
  return { folder: row.folder || 'inbox', isRead: Boolean(row.is_read), starred: Boolean(row.starred) };
}
function rental(row) {
  const form = parse(row.form_json);
  return { id: row.id, requester: row.person_responsible, email: row.contact_email || '', phone: row.phone,
    audience: row.audience, facilities: Array.isArray(form.facilities) ? form.facilities.map(String) : [],
    date: row.date_of_use, timeFrom: row.time_from, timeTo: row.time_to, purpose: row.purpose,
    address: row.address || '', form, status: row.workflow_status || 'pending', version: row.workflow_version || 0 };
}
async function audit(db, actor, itemKey, action, value) {
  await db.prepare('INSERT INTO workspace_audit(id,actor,item_key,action,value_json,created_at) VALUES(?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), actor, itemKey, action, JSON.stringify(value), now()).run();
}
const SOURCE = `
  SELECT 'contact:'||c.id AS item_key, c.id, 'contact' AS type, c.name AS sender_name,
    c.email AS sender_email, c.subject, substr(c.message,1,220) AS preview, c.message AS search_body, c.created_at,
    '' AS audience, c.status AS source_status, '' AS workflow_status
    FROM contact_messages c
  UNION ALL
  SELECT 'facility_rental:'||r.id, r.id, 'facility_rental', r.person_responsible,
    COALESCE(r.contact_email,''), 'Facility rental · '||r.date_of_use, substr(r.purpose,1,220), r.purpose, r.created_at,
    r.audience, r.status, COALESCE(w.status,'pending') FROM facility_rental_requests r
    LEFT JOIN rental_workflow w ON w.rental_id=r.id
  UNION ALL
  SELECT 'outbound:'||o.id, o.id, 'outbound', o.actor, o.recipient, o.subject,
    substr(o.body,1,220), o.body, o.created_at, '', o.status, '' FROM mailbox_outbound o`;
function listWhere(url) {
  const folder = url.searchParams.get('folder') || 'inbox';
  if (!['inbox','unread','starred','sent','archive','deleted'].includes(folder)) invalid('Invalid folder.');
  const args = [], where = [];
  if (folder === 'sent') where.push("s.type='outbound' AND COALESCE(m.folder,'inbox')='inbox'");
  else if (['archive','deleted'].includes(folder)) { where.push("COALESCE(m.folder,'inbox')=?"); args.push(folder); }
  else { where.push("s.type<>'outbound' AND COALESCE(m.folder,'inbox')='inbox'"); }
  const filter = url.searchParams.get('filter');
  if (folder === 'unread' || filter === 'unread') where.push('COALESCE(m.is_read,0)=0');
  if (folder === 'starred' || filter === 'starred') where.push('COALESCE(m.starred,0)=1');
  const category = url.searchParams.get('category') || 'all';
  if (['contact','facility_rental'].includes(category)) { where.push('s.type=?'); args.push(category); }
  else if (['member','non_member'].includes(category)) { where.push("s.type='facility_rental' AND s.audience=?"); args.push(category); }
  else if (category !== 'all') invalid('Invalid message category.');
  const q = clean(url.searchParams.get('q') || '', 120);
  if (q) { where.push('(s.sender_name LIKE ? OR s.sender_email LIKE ? OR s.subject LIKE ? OR s.search_body LIKE ?)'); args.push(...Array(4).fill('%'+q+'%')); }
  return { where: where.join(' AND '), args };
}
async function listItems(env, url) {
  const { where, args } = listWhere(url);
  const page = Math.max(1, Math.min(100000, Number.parseInt(url.searchParams.get('page') || '1',10) || 1));
  const limit = 40;
  const order = url.searchParams.get('sort') === 'oldest' ? 'ASC' : 'DESC';
  const base = `FROM (${SOURCE}) s LEFT JOIN mailbox_state m ON m.item_key=s.item_key WHERE ${where}`;
  const [count, rows, badge] = await Promise.all([
    env.SITE_DB.prepare(`SELECT COUNT(*) AS total ${base}`).bind(...args).first(),
    env.SITE_DB.prepare(`SELECT s.item_key,s.id,s.type,s.sender_name,s.sender_email,s.subject,s.preview,s.created_at,s.audience,s.source_status,s.workflow_status,COALESCE(m.folder,'inbox') AS folder,COALESCE(m.is_read,0) AS is_read,
      COALESCE(m.starred,0) AS starred ${base} ORDER BY s.created_at ${order},s.item_key ${order} LIMIT ? OFFSET ?`)
      .bind(...args,limit,(page-1)*limit).all(),
    env.SITE_DB.prepare(`SELECT COUNT(*) AS total FROM (${SOURCE}) s LEFT JOIN mailbox_state m ON m.item_key=s.item_key
      WHERE s.type<>'outbound' AND COALESCE(m.folder,'inbox')='inbox' AND COALESCE(m.is_read,0)=0`).first()
  ]);
  return json({ items: (rows.results || []).map(r => ({ key:r.item_key, id:r.id, type:r.type, sender:r.sender_name,
    email:r.sender_email, subject:r.subject, preview:r.preview, createdAt:r.created_at, audience:r.audience,
    status:r.workflow_status || r.source_status, ...metadata(r) })), page, pageSize:limit, total:count.total, unread:badge.total });
}
async function getItem(env, key) {
  const { type, id } = parseItemKey(key);
  let row, item;
  if (type === 'contact') {
    row = await env.SITE_DB.prepare('SELECT * FROM contact_messages WHERE id=?').bind(id).first();
    if (row) item = { sender:row.name, email:row.email, phone:row.phone, address:row.address, subject:row.subject,
      body:row.message, createdAt:row.created_at, status:row.status, autoReplyStatus:row.auto_reply_status };
  } else if (type === 'facility_rental') {
    row = await env.SITE_DB.prepare(`SELECT r.*,w.status AS workflow_status,w.version AS workflow_version
      FROM facility_rental_requests r LEFT JOIN rental_workflow w ON w.rental_id=r.id WHERE r.id=?`).bind(id).first();
    if (row) item = { sender:row.person_responsible, email:row.contact_email || '', subject:'Facility rental · '+row.date_of_use,
      body:row.purpose, createdAt:row.created_at, status:row.workflow_status || 'pending', rental:rental(row), autoReplyStatus:row.auto_reply_status };
  } else {
    row = await env.SITE_DB.prepare('SELECT * FROM mailbox_outbound WHERE id=?').bind(id).first();
    if (row) item = { sender:row.actor, email:row.recipient, subject:row.subject, body:row.body, createdAt:row.created_at,
      status:row.status, error:row.error, outboundId:row.id, actor:row.actor, itemKey:row.item_key };
  }
  if (!item) invalid('Message not found.',404);
  const [state,replies] = await Promise.all([
    env.SITE_DB.prepare('SELECT * FROM mailbox_state WHERE item_key=?').bind(key).first(),
    env.SITE_DB.prepare('SELECT id,actor,recipient,subject,body,status,error,created_at,accepted_at FROM mailbox_outbound WHERE item_key=? ORDER BY created_at ASC LIMIT 100')
      .bind(type === 'outbound' ? (row.item_key || key) : key).all()
  ]);
  return { key,type,...item,...metadata(state || {}),replies:replies.results || [] };
}
async function patchItem(env,key,body,actor) {
  await getItem(env,key);
  const keys=Object.keys(body || {});
  if (!keys.length || keys.some(k=>!['folder','isRead','starred'].includes(k))) invalid('Invalid mailbox update.');
  if (body.folder !== undefined && !['inbox','archive','deleted'].includes(body.folder)) invalid('Invalid folder.');
  for (const k of ['isRead','starred']) if(body[k] !== undefined && typeof body[k] !== 'boolean') invalid('Invalid '+k+'.');
  const fields=keys.map(k=>({folder:'folder',isRead:'is_read',starred:'starred'}[k]));
  await env.SITE_DB.batch([
    env.SITE_DB.prepare('INSERT INTO mailbox_state(item_key,updated_at,updated_by) VALUES(?,?,?) ON CONFLICT(item_key) DO NOTHING').bind(key,now(),actor),
    env.SITE_DB.prepare(`UPDATE mailbox_state SET ${fields.map(k=>k+'=?').join(',')},updated_at=?,updated_by=? WHERE item_key=?`)
      .bind(...keys.map(k=>k === 'folder' ? body[k] : Number(body[k])),now(),actor,key),
    env.SITE_DB.prepare('INSERT INTO workspace_audit(id,actor,item_key,action,value_json,created_at) VALUES(?,?,?,?,?,?)')
      .bind(crypto.randomUUID(),actor,key,'mail.organize',JSON.stringify(body),now())
  ]);
  return json(await getItem(env,key));
}
export function validateOutbound(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Invalid message.');
  const recipient=clean(body.recipient,254),subject=clean(body.subject,200),text=clean(body.body,20000);
  if (!isValidEmail(recipient) || /[\r\n]/.test(recipient)) invalid('Enter a valid recipient email.');
  if (!subject || /[\r\n]/.test(subject)) invalid('Enter a valid subject.');
  if (!text || body.body.length>20000) invalid('Enter a message of up to 20,000 characters.');
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(body.idempotencyKey || '')) invalid('A valid send identifier is required.');
  const itemKey=body.itemKey || '';
  if (itemKey) parseItemKey(itemKey);
  return {recipient,subject,body:text,itemKey,idempotencyKey:body.idempotencyKey};
}
export async function sendOutbound(env,id,actor,{send=sendResendEmail}={}) {
  const db=env.SITE_DB;
  let row=await db.prepare('SELECT * FROM mailbox_outbound WHERE id=? AND actor=?').bind(id,actor).first();
  if(!row) invalid('Outgoing message not found.',404);
  if(row.status==='accepted')return row;
  // Resend keys expire after 24h. Ambiguous sends older than that need manual
  // provider reconciliation; blindly retrying could send a second email.
  if (row.attempts>0 && Date.now()-Date.parse(row.created_at)>23*60*60*1000) {
    invalid('The email service retry window has expired. Check the provider before composing a new message.',409);
  }
  const claim=await db.prepare(`UPDATE mailbox_outbound SET status='sending',attempts=attempts+1,updated_at=?
    WHERE id=? AND actor=? AND (status IN ('queued','failed','uncertain') OR (status='sending' AND updated_at<?))`)
    .bind(now(),id,actor,new Date(Date.now()-60000).toISOString()).run();
  if(!claim.meta?.changes) invalid('This message is already being sent. Refresh to check its status.',409);
  const html=`<div style="background:#f4f1ed;padding:24px;font-family:Arial,sans-serif;color:#29231f"><div style="max-width:640px;margin:auto;background:white;border:1px solid #e3ddd5"><div style="padding:20px;background:#7e381c;color:white;font-weight:bold">Mount Moriah Missionary Baptist Church</div><div style="padding:24px;white-space:pre-wrap">${escapeHtml(row.body)}</div><div style="padding:16px 24px;border-top:1px solid #e3ddd5;color:#6b625b;font-size:12px">Church Administration</div></div></div>`;
  const result=await send(env,{to:row.recipient,subject:row.subject,text:row.body,html,idempotencyKey:'workspace-'+row.idempotency_key});
  const status=result.ok?'accepted':result.status===0?'uncertain':'failed';
  await db.prepare('UPDATE mailbox_outbound SET status=?,provider_id=?,error=?,updated_at=?,accepted_at=? WHERE id=? AND actor=?')
    .bind(status,result.id || null,result.ok?null:result.error || 'Email service unavailable.',now(),result.ok?now():null,id,actor).run();
  return db.prepare('SELECT * FROM mailbox_outbound WHERE id=? AND actor=?').bind(id,actor).first();
}
async function queueOutbound(env,body,actor) {
  const message=validateOutbound(body);
  if(message.itemKey) await getItem(env,message.itemKey);
  const id=crypto.randomUUID(),stamp=now();
  await env.SITE_DB.prepare(`INSERT INTO mailbox_outbound(id,item_key,actor,recipient,subject,body,idempotency_key,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`)
    .bind(id,message.itemKey,actor,message.recipient,message.subject,message.body,message.idempotencyKey,stamp,stamp).run();
  const row=await env.SITE_DB.prepare('SELECT * FROM mailbox_outbound WHERE idempotency_key=?').bind(message.idempotencyKey).first();
  if(row.actor!==actor || row.recipient!==message.recipient || row.subject!==message.subject || row.body!==message.body || row.item_key!==message.itemKey) invalid('Send identifier already belongs to a different message.',409);
  const sent=await sendOutbound(env,row.id,actor);
  if(sent.status==='accepted' && body.draftKey) await env.SITE_DB.prepare('DELETE FROM mailbox_drafts WHERE actor=? AND draft_key=?').bind(actor,clean(body.draftKey,140)).run();
  return json({outbound:sent},sent.status==='accepted'?200:202);
}
async function draftRequest(request,env,key,actor) {
  if(!/^(compose|contact:[a-zA-Z0-9_-]{1,100}|facility_rental:[a-zA-Z0-9_-]{1,100})$/.test(key)) invalid('Invalid draft identifier.');
  if(key!=='compose') await getItem(env,key);
  const db=env.SITE_DB;
  if(request.method==='GET')return json({draft:await db.prepare('SELECT * FROM mailbox_drafts WHERE actor=? AND draft_key=?').bind(actor,key).first()});
  if(request.method==='DELETE'){await db.prepare('DELETE FROM mailbox_drafts WHERE actor=? AND draft_key=?').bind(actor,key).run();return json({ok:true});}
  if(request.method!=='PUT')return json({error:'Method not allowed.'},405);
  const body=await request.json(),recipient=clean(body.recipient,254),subject=clean(body.subject,200),text=clean(body.body,20000);
  if(!/^[a-zA-Z0-9_-]{16,100}$/.test(body.idempotencyKey||''))invalid('Invalid draft send identifier.');
  await db.prepare(`INSERT INTO mailbox_drafts(actor,draft_key,recipient,subject,body,item_key,idempotency_key,updated_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(actor,draft_key) DO UPDATE SET recipient=excluded.recipient,subject=excluded.subject,
    body=excluded.body,item_key=excluded.item_key,idempotency_key=excluded.idempotency_key,updated_at=excluded.updated_at`)
    .bind(actor,key,recipient,subject,text,key==='compose'?'':key,body.idempotencyKey,now()).run();
  return json({ok:true,updatedAt:now()});
}
async function rentalAction(env,id,body,actor) {
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))invalid('Invalid rental identifier.');
  if(!['pending','approved','declined'].includes(body.status) || !Number.isInteger(body.version))invalid('Invalid rental decision.');
  const item=await getItem(env,'facility_rental:'+id),r=item.rental;
  if(body.status==='approved' && (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !/^\d{2}:\d{2}$/.test(r.timeFrom) || !/^\d{2}:\d{2}$/.test(r.timeTo) || r.timeFrom>=r.timeTo)) invalid('The requested date/time must be corrected before approval.',409);
  await env.SITE_DB.prepare('INSERT INTO rental_workflow(rental_id,updated_by,updated_at) VALUES(?,?,?) ON CONFLICT(rental_id) DO NOTHING').bind(id,actor,now()).run();
  const form=JSON.stringify(r.form);
  const result=await env.SITE_DB.prepare(`UPDATE rental_workflow SET status=?,version=version+1,updated_by=?,updated_at=?
    WHERE rental_id=? AND version=? AND (?<>'approved' OR NOT EXISTS (
      SELECT 1 FROM facility_rental_requests other JOIN rental_workflow w ON w.rental_id=other.id
      WHERE other.id<>? AND w.status='approved' AND other.date_of_use=? AND other.time_from<? AND other.time_to>?
      AND (json_array_length(COALESCE(json_extract(other.form_json,'$.facilities'),'[]'))=0
        OR json_array_length(COALESCE(json_extract(?,'$.facilities'),'[]'))=0
        OR EXISTS(SELECT 1 FROM json_each(other.form_json,'$.facilities') a JOIN json_each(?,'$.facilities') b ON a.value=b.value))
    ))`).bind(body.status,actor,now(),id,body.version,body.status,id,r.date,r.timeTo,r.timeFrom,form,form).run();
  if(!result.meta?.changes)invalid('This request changed or conflicts with an approved rental. Refresh and review the schedule.',409);
  await audit(env.SITE_DB,actor,item.key,'rental.'+body.status,{previous:r.status,status:body.status});
  return json(await getItem(env,item.key));
}
function dateRange(url, {max=93}={}) {
  const from=url.searchParams.get('from')||new Date(Date.now()-30*86400000).toISOString().slice(0,10);
  const to=url.searchParams.get('to')||new Date().toISOString().slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||from>to||Date.parse(to)-Date.parse(from)>max*86400000)invalid('Choose a valid date range of up to '+max+' days.');
  return {from,to,end:new Date(Date.parse(to)+86400000).toISOString().slice(0,10)};
}
async function schedule(env,url,permissions) {
  const {from,to}=dateRange(url);
  const events=permissions.includes('events.view') ? (await env.DB.prepare('SELECT id,title,event_date AS date,event_time AS time FROM events WHERE event_date>=? AND event_date<=? ORDER BY event_date,event_time LIMIT 500').bind(from,to).all()).results : [];
  const rentals=permissions.includes('submissions.view') ? (await env.SITE_DB.prepare(`SELECT r.*,w.status AS workflow_status,w.version AS workflow_version FROM facility_rental_requests r
    LEFT JOIN rental_workflow w ON w.rental_id=r.id WHERE date_of_use>=? AND date_of_use<=? ORDER BY date_of_use,time_from LIMIT 500`).bind(from,to).all()).results.map(rental) : [];
  return json({events:events || [],rentals:rentals || [],from,to,limit:500});
}
async function financeRecorder(env,url,request,actor,permissions) {
  if(!env.DB)invalid('Finance database is unavailable.',503);
  if(!permissions.includes('finance.view'))invalid('You do not have permission to view finance entries.',403);
  if(request.method==='GET') {
    const limit=Math.max(1,Math.min(250,Number.parseInt(url.searchParams.get('limit')||'100',10)||100));
    const [rows,totals]=await Promise.all([
      env.DB.prepare(`SELECT id,entry_date,type,category,fund,method,party,memo,amount_cents,created_at,updated_at
        FROM finance_entries ORDER BY entry_date DESC,created_at DESC LIMIT ?`).bind(limit).all(),
      env.DB.prepare(`SELECT
        COALESCE(SUM(CASE WHEN type='income' THEN amount_cents ELSE 0 END),0) AS income_cents,
        COALESCE(SUM(CASE WHEN type='expense' THEN amount_cents ELSE 0 END),0) AS expense_cents
        FROM finance_entries`).first()
    ]);
    const incomeCents=Number(totals?.income_cents||0),expenseCents=Number(totals?.expense_cents||0);
    return json({entries:(rows.results||[]).map(r=>({
      id:r.id,date:r.entry_date,type:r.type,category:r.category||'',fund:r.fund||'',method:r.method||'',
      party:r.party||'',memo:r.memo||'',amountCents:Number(r.amount_cents||0),createdAt:r.created_at,updatedAt:r.updated_at
    })),summary:{incomeCents,expenseCents,netCents:incomeCents-expenseCents},limit});
  }
  if(request.method!=='POST')return json({error:'Method not allowed.'},405);
  if(!permissions.includes('finance.record'))invalid('You do not have permission to record finance entries.',403);
  const body=await request.json();
  const type=clean(body.type,20),date=clean(body.date,10),category=clean(body.category,120),fund=clean(body.fund,120),
    method=clean(body.method,60),party=clean(body.party,120),memo=clean(body.memo,500);
  if(!['income','expense'].includes(type))invalid('Choose Money Received or Money Spent.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date)))invalid('Enter a valid date.');
  if(!category)invalid('Enter a category.');
  const amount=Number(body.amount);
  const amountCents=Math.round(amount*100);
  if(!Number.isFinite(amount)||amount<=0||!Number.isSafeInteger(amountCents)||amountCents<=0)invalid('Enter an amount greater than zero.');
  const id=crypto.randomUUID(),stamp=now();
  await env.DB.prepare(`INSERT INTO finance_entries(id,entry_date,type,category,fund,method,party,memo,amount_cents,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(id,date,type,category,fund,method,party,memo,amountCents,stamp,stamp).run();
  await audit(env.SITE_DB||env.DB,actor,'finance:'+id,'finance.record',{type,date,category,fund,method,party,amountCents});
  return json({ok:true,id},201);
}

async function reports(env,url,permissions) {
  const {from,to,end}=dateRange(url),data={from,to,sections:{}};
  if(permissions.includes('submissions.view')) {
    data.sections.submissions=(await env.SITE_DB.prepare(`SELECT type,status,COUNT(*) AS count FROM (
      SELECT 'contact' AS type,status,created_at FROM contact_messages UNION ALL SELECT 'facility_rental',status,created_at FROM facility_rental_requests
    ) WHERE created_at>=? AND created_at<? GROUP BY type,status`).bind(from,end).all()).results;
    data.sections.outbound=(await env.SITE_DB.prepare('SELECT status,COUNT(*) AS count FROM mailbox_outbound WHERE created_at>=? AND created_at<? GROUP BY status').bind(from,end).all()).results;
    data.sections.rentals=(await env.SITE_DB.prepare(`SELECT COALESCE(w.status,'pending') AS status,COUNT(*) AS count FROM facility_rental_requests r LEFT JOIN rental_workflow w ON w.rental_id=r.id
      WHERE r.created_at>=? AND r.created_at<? GROUP BY COALESCE(w.status,'pending')`).bind(from,end).all()).results;
  }
  if(permissions.includes('newsletter.view'))data.sections.newsletter=(await env.DB.prepare('SELECT status,COUNT(*) AS count,SUM(sent_count) AS acceptedCount FROM newsletter_records WHERE created_at>=? AND created_at<? GROUP BY status').bind(from,end).all()).results;
  if(permissions.includes('finance.view'))data.sections.finance=(await env.DB.prepare("SELECT type,'recorded' AS status,COUNT(*) AS count FROM finance_entries WHERE created_at>=? AND created_at<? GROUP BY type").bind(from,end).all()).results;
  if(url.searchParams.get('format')==='csv') {
    const lines=[['Module','Type','Status','Count','Accepted by provider'].map(csvCell).join(',')];
    for(const [section,rows] of Object.entries(data.sections))for(const row of rows)lines.push([section,row.type,row.status,row.count,row.acceptedCount].map(csvCell).join(','));
    return new Response(lines.join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="church-operations-'+from+'.csv"','Cache-Control':'no-store'}});
  }
  return json(data);
}

export async function handleWorkspaceRequest(request,env) {
  const url=new URL(request.url),path=url.pathname;
  if(!path.startsWith('/api/admin/mail/') && !['/api/admin/workspace/reports','/api/admin/workspace/schedule','/api/admin/workspace/finance'].includes(path) && !path.startsWith('/api/admin/workspace/rentals/'))return null;
  try {
    const session=await authenticateAdminRequest(request,env,env.__ACCESS_JWKS?{jwks:env.__ACCESS_JWKS}:{});
    const {user,permissions}=session,actor=user.email;
    if(path.includes('/workspace/reports')) {
      requireAnyPermission(user,['submissions.view','newsletter.view','finance.view']);
      if(request.method!=='GET')return json({error:'Method not allowed.'},405);
      return await reports(env,url,permissions);
    }
    if(path.includes('/workspace/schedule')) {
      requireAnyPermission(user,['events.view','submissions.view']);
      if(request.method!=='GET')return json({error:'Method not allowed.'},405);
      return await schedule(env,url,permissions);
    }
    if(path==='/api/admin/workspace/finance') {
      requireAnyPermission(user,['finance.view','finance.record']);
      return await financeRecorder(env,url,request,actor,permissions);
    }
    requirePermission(user,'submissions.view');
    if(request.method!=='GET')requirePermission(user,'submissions.manage');
    if(!env.SITE_DB)invalid('Site database is unavailable.',503);
    if(path==='/api/admin/mail/items' && request.method==='GET')return await listItems(env,url);
    if(path==='/api/admin/mail/send' && request.method==='POST')return await queueOutbound(env,await request.json(),actor);
    const retry=/^\/api\/admin\/mail\/outbound\/([a-zA-Z0-9_-]{1,100})\/retry$/.exec(path);
    if(retry && request.method==='POST')return json({outbound:await sendOutbound(env,retry[1],actor)});
    const draft=/^\/api\/admin\/mail\/drafts\/([^/]+)$/.exec(path);
    if(draft) { requirePermission(user,'submissions.manage'); return await draftRequest(request,env,decodeURIComponent(draft[1]),actor); }
    const item=/^\/api\/admin\/mail\/items\/([^/]+)$/.exec(path);
    if(item) {
      const key=decodeURIComponent(item[1]);
      if(request.method==='GET')return json(await getItem(env,key));
      if(request.method==='PATCH')return await patchItem(env,key,await request.json(),actor);
    }
    const decision=/^\/api\/admin\/workspace\/rentals\/([^/]+)$/.exec(path);
    if(decision && request.method==='PATCH')return await rentalAction(env,decodeURIComponent(decision[1]),await request.json(),actor);
    return json({error:'Workspace endpoint not found.'},404);
  } catch(error) {
    if(error.name==='AdminAuthError')return authErrorResponse(error);
    if(error.status)return json({error:error.message},error.status);
    if(error instanceof SyntaxError || error instanceof URIError)return json({error:'Invalid request.'},400);
    console.error('Workspace request failed',{path,name:error.name});
    return json({error:'Workspace data could not be loaded. Apply the workspace migrations and try again.'},503);
  }
}
