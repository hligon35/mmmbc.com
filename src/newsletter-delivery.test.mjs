import assert from 'node:assert/strict';
import test from 'node:test';
import { processScheduledNewsletters } from './worker-communications.js';
import { handleNewsletterPreferences, unsubscribeToken } from './newsletter-preferences.js';
import { deliverSubmissionEmail, retrySubmissionEmails } from './submission-delivery.js';

function database(handler) {
 return {prepare(sql) { let args=[];const statement={bind(...values){args=values;return statement;},first:async()=>handler(sql,args,'first'),all:async()=>({results:handler(sql,args,'all')||[]}),run:async()=>handler(sql,args,'run')||{meta:{changes:1}}};return statement;}};
}

test('newsletter retries skip successful recipients and recheck later opt-outs',async()=>{
 const deliveries=new Map(), suppressed=new Set(), calls=[];
 const emails=['a@example.com','b@example.com','c@example.com'];
 let due=true, campaignStatus='scheduled';
 const record={id:'campaign',subject:'Church news',message:'Hello',emails:JSON.stringify(emails),retry_count:0};
 const DB=database((sql,args)=>{
  if(sql.includes('SELECT * FROM newsletter_records'))return due?[record]:[];
  if(sql.includes('SELECT email, status FROM newsletter_subscribers'))return [];
  if(sql.includes('SELECT email FROM newsletter_suppressions'))return [...suppressed].map(email=>({email}));
  if(sql.includes('INSERT INTO newsletter_deliveries')) {if(!deliveries.has(args[1]))deliveries.set(args[1],{email:args[1],status:'pending',attempts:0});}
  if(sql.includes('SELECT email,status,attempts FROM newsletter_deliveries'))return [...deliveries.values()].map(x=>({...x}));
  if(sql.includes('UPDATE newsletter_deliveries')){const row=deliveries.get(args[5]);row.status=args[0];row.attempts++;}
  if(sql.includes('COUNT(*)'))return {c:[...deliveries.values()].filter(x=>x.status==='sent').length};
  if(sql.includes("SET status='sent', sent_count")){campaignStatus='sent';due=false;assert.equal(args[0],2);}
 });
 const env={DB,SITE_DB:database(()=>emails.map(email=>({email,status:'active'}))),PUBLIC_SITE_URL:'https://church.example',NEWSLETTER_UNSUBSCRIBE_SECRET:'s'.repeat(40),RESEND_API_KEY:'test',RESEND_FROM_EMAIL:'church@example.com'};
 const original=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.resend.com/emails');const body=JSON.parse(options.body);const email=body.to[0];calls.push(email);assert.ok(body.headers['List-Unsubscribe']);assert.match(body.text,/newsletter\/unsubscribe/);return email==='b@example.com'?Response.json({message:'Try later'},{status:429}):Response.json({id:`sent-${email}`});};
 try{
  await processScheduledNewsletters(env);
  assert.equal(deliveries.get('a@example.com').status,'sent');
  assert.equal(deliveries.get('b@example.com').status,'pending');
  suppressed.add('b@example.com');
  await processScheduledNewsletters(env);
  assert.deepEqual(calls,emails);
  assert.equal(campaignStatus,'sent');
 }finally{globalThis.fetch=original;}
});

test('unsubscribe GET confirms without changing consent; signed POST persists suppression first',async()=>{
 const writes=[];const DB=database((sql,args,kind)=>{if(kind==='run')writes.push(sql);});
 const env={DB,SITE_DB:DB,NEWSLETTER_UNSUBSCRIBE_SECRET:'s'.repeat(40)};
 const token=await unsubscribeToken(env,'member@example.com');
 const url=`https://church.example/newsletter/unsubscribe?token=${encodeURIComponent(token)}`;
 const get=await handleNewsletterPreferences(new Request(url),env);
 assert.equal(get.status,200);assert.deepEqual(writes,[]);
 const post=await handleNewsletterPreferences(new Request(url,{method:'POST',body:'List-Unsubscribe=One-Click',headers:{'content-type':'application/x-www-form-urlencoded'}}),env);
 assert.equal(post.status,200);assert.match(writes[0],/newsletter_suppressions/);assert.equal(writes.length,3);
});

test('submission email failures are queued and retry with the same idempotency key',async()=>{
 const keys=[],updates=[];let job;
 const SITE_DB=database((sql,args)=>{
  if(sql.includes('INSERT INTO email_delivery_jobs')) job={id:args[0],submission_id:args[1],submission_type:args[2],kind:args[3],payload_json:args[4],attempts:1};
  if(sql.includes('SELECT * FROM email_delivery_jobs'))return job?[job]:[];
  if(sql.includes('UPDATE email_delivery_jobs SET status=?'))updates.push(args[0]);
 });
 const env={SITE_DB,RESEND_API_KEY:'test',RESEND_FROM_EMAIL:'church@example.com'};const original=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{keys.push(options.headers['Idempotency-Key']);return keys.length===1?Response.json({message:'Unavailable'},{status:503}):Response.json({id:'retry-success'});};
 try{
  const out=await deliverSubmissionEmail(env,{submissionId:'rental-1',submissionType:'facility_rental',kind:'confirmation',to:'visitor@example.com',subject:'Received',text:'Thanks'});
  assert.equal(out.ok,false);assert.ok(job);
  await retrySubmissionEmails(env);
  assert.deepEqual(keys,['facility_rental-rental-1-confirmation','facility_rental-rental-1-confirmation']);
  assert.deepEqual(updates,['sent']);
 }finally{globalThis.fetch=original;}
});
