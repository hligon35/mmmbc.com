import assert from 'node:assert/strict';
import test from 'node:test';
import { zonedSchedule, unsubscribeToken, tokenEmail, eligibleRecipients } from './newsletter-preferences.js';
import { mutationDenied, checkBodySize, imageBytesAllowed } from './launch-security.js';
import worker from './worker-admin-api-wrapper.js';
test('newsletter scheduling applies Central time and rejects invalid or ambiguous local times',()=>{
 assert.equal(zonedSchedule('2026-10-11','11:00','America/Chicago'),'2026-10-11T16:00:00.000Z');
 assert.equal(zonedSchedule('2026-12-11','11:00','America/Chicago'),'2026-12-11T17:00:00.000Z');
 assert.throws(()=>zonedSchedule('2026-03-08','02:30','America/Chicago'));
 assert.throws(()=>zonedSchedule('2026-11-01','01:30','America/Chicago'));
 assert.throws(()=>zonedSchedule('2026-02-30','11:00','America/Chicago'));
});
test('unsubscribe links cannot be tampered with or generated without a secret',async()=>{
 const env={NEWSLETTER_UNSUBSCRIBE_SECRET:'a'.repeat(40)};
 const token=await unsubscribeToken(env,'MEMBER@example.com');
 assert.equal(await tokenEmail(env,token),'member@example.com');
 assert.equal(await tokenEmail(env,token+'x'),'');
 await assert.rejects(()=>unsubscribeToken({},'member@example.com'));
});
test('newsletter suppression overrides active records across both stores',async()=>{
 const db=rows=>({prepare:sql=>({all:async()=>({results:sql.includes('suppressions')?rows.suppressed||[]:rows.subscribers||[]})})});
 const env={SITE_DB:db({subscribers:[{email:'a@example.com',status:'active'},{email:'b@example.com',status:'active'}]}),DB:db({subscribers:[{email:'a@example.com',status:'unsubscribed'}],suppressed:[]})};
 assert.deepEqual(await eligibleRecipients(env,['a@example.com','b@example.com']),['b@example.com']);
});
test('cross-origin mutations and oversized requests are rejected',async()=>{
 assert.ok(mutationDenied(new Request('https://example.com/api/finances',{method:'POST',headers:{Origin:'https://attacker.example'}})));
 assert.equal(await checkBodySize(new Request('https://example.com/api',{method:'POST',body:'a'.repeat(100)}),50),false);
 assert.equal(imageBytesAllowed(new TextEncoder().encode('<html>'),'image/png'),false);
});
test('scanner and disabled Stripe endpoints are unavailable and security headers cover APIs',async()=>{
 const response=await worker.fetch(new Request('https://example.com/scan'),{},{});
 assert.equal(response.status,410);
 assert.equal(response.headers.get('Permissions-Policy'),'camera=(), microphone=(), geolocation=()');
 const stripe=await worker.fetch(new Request('https://example.com/api/giving/checkout',{method:'POST',body:'{}'}),{GIVING_PROVIDER:'zeffy'},{});
 assert.equal(stripe.status,404);
});
