import { sendResendEmail } from './email-resend.js';
export async function deliverSubmissionEmail(env, { submissionId, submissionType, kind, ...payload }) {
  const id = `${submissionType}-${submissionId}-${kind}`;
  const out=await sendResendEmail(env,{...payload,idempotencyKey:id});
  if(!out.ok && env.SITE_DB) {
    const now=new Date().toISOString();
    await env.SITE_DB.prepare(`INSERT INTO email_delivery_jobs (id,submission_id,submission_type,kind,payload_json,status,attempts,next_attempt_at,error,created_at,updated_at)
      VALUES (?,?,?,?,?,'pending',1,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(id,submissionId,submissionType,kind,JSON.stringify(payload),new Date(Date.now()+300000).toISOString(),String(out.error||'Delivery failed').slice(0,500),now,now).run();
  }
  return out;
}
export async function retrySubmissionEmails(env) {
  if(!env.SITE_DB) return;
  const now=new Date().toISOString();
  const jobs=await env.SITE_DB.prepare("SELECT * FROM email_delivery_jobs WHERE status IN ('pending','sending') AND next_attempt_at<=? ORDER BY created_at LIMIT 20").bind(now).all();
  for(const job of jobs.results||[]) {
    const claim=await env.SITE_DB.prepare("UPDATE email_delivery_jobs SET status='sending',next_attempt_at=? WHERE id=? AND status IN ('pending','sending') AND next_attempt_at<=?").bind(new Date(Date.now()+600000).toISOString(),job.id,now).run();
    if(!claim.meta?.changes) continue;
    let payload;try{payload=JSON.parse(job.payload_json);}catch{payload={};}
    const out=await sendResendEmail(env,{...payload,idempotencyKey:job.id});
    const attempts=Number(job.attempts)+1;
    const status=out.ok?'sent':attempts>=5?'failed':'pending';
    await env.SITE_DB.prepare('UPDATE email_delivery_jobs SET status=?,attempts=?,next_attempt_at=?,error=?,updated_at=? WHERE id=?').bind(status,attempts,new Date(Date.now()+300000*attempts).toISOString(),out.error||'',new Date().toISOString(),job.id).run();
    const table=job.submission_type==='facility_rental'?'facility_rental_requests':job.submission_type==='contact'?'contact_messages':'';
    if(table && job.kind==='confirmation') await env.SITE_DB.prepare(`UPDATE ${table} SET auto_reply_status=?,auto_reply_at=?,auto_reply_error=? WHERE id=?`).bind(out.ok?'sent':status==='failed'?'failed':'retrying',out.ok?new Date().toISOString():null,out.error||'',job.submission_id).run();
    if(table && job.kind==='notification') await env.SITE_DB.prepare(`UPDATE ${table} SET status=?,email_error=? WHERE id=?`).bind(out.ok?'emailed':status==='failed'?'email_failed':'email_retrying',out.error||'',job.submission_id).run();
  }
}
