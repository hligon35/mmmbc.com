import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {previewConfig} from '../scripts/preview-config.mjs';
import {previewResponse,previewHeaders} from './preview-safety.js';
import {sendResendEmail,sendResendBatch} from './email-resend.js';
const production=JSON.parse(fs.readFileSync('wrangler.jsonc'));
test('preview isolates both database bindings, media, origins and schedules',()=>{
 const config=previewConfig(production,'11111111-1111-4111-8111-111111111111','test-audience');
 assert.equal(production.name,'mmmbc');assert.equal(production.workers_dev,true);
 assert.deepEqual(production.routes.map(r=>r.pattern),['mmmbc.com']);
 assert.equal(config.name,'mmmbc-preview');assert.deepEqual(config.routes,[]);assert.deepEqual(config.triggers.crons,[]);
 assert.equal(config.r2_buckets[0].bucket_name,'mmmbc-preview');
 for(const db of config.d1_databases){assert.equal(db.database_name,'mmmbc-preview');assert.notEqual(db.database_id,production.d1_databases[0].database_id);}
 assert.equal(config.vars.CANONICAL_HOST,'mmmbc-preview.hligon.workers.dev');
 assert.throws(()=>previewConfig(production,production.d1_databases[0].database_id,'aud'));
 assert.throws(()=>previewConfig(production,'11111111-1111-4111-8111-111111111111',''));
});
test('training blocks payment routes and production hosts and requests no indexing',()=>{
 const env={ENVIRONMENT:'preview'};
 assert.equal(previewResponse(new Request('https://mmmbc.com/admin'),env).status,503);
 assert.equal(previewResponse(new Request('https://mmmbc.hligon.workers.dev/admin'),env).status,503);
 assert.equal(previewResponse(new Request('https://mmmbc-preview.hligon.workers.dev/give'),env).status,403);
 assert.equal(previewResponse(new Request('https://mmmbc-preview.hligon.workers.dev/admin'),env),null);
 assert.match(previewHeaders(new Response('test'),env).headers.get('X-Robots-Tag'),/noindex/);
});
test('preview never sends email even with inherited provider secrets',async()=>{
 const original=globalThis.fetch;globalThis.fetch=()=>{throw new Error('Must not contact provider');};
 try{const env={ENVIRONMENT:'preview',RESEND_API_KEY:'inherited',RESEND_FROM_EMAIL:'example@example.com'};
 assert.equal((await sendResendEmail(env,{to:'test@example.com'})).ok,false);
 assert.equal((await sendResendBatch(env,{recipients:['test@example.com']})).ok,false);
 }finally{globalThis.fetch=original;}
});
