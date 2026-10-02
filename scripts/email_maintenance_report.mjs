import { readFileSync } from 'node:fs';
const apiKey=process.env.RESEND_API_KEY, to=process.env.MAINTENANCE_TO_EMAIL, from=process.env.RESEND_FROM_EMAIL;
if(!apiKey||!to||!from) throw new Error('Configure RESEND_API_KEY, MAINTENANCE_TO_EMAIL, and RESEND_FROM_EMAIL repository secrets.');
const report=readFileSync('monthlyReport.md','utf8');
const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json','Idempotency-Key':`maintenance-${process.env.GITHUB_RUN_ID||Date.now()}`},body:JSON.stringify({from,to:[to],subject:'MMMBC monthly maintenance report',text:report})});
if(!response.ok) throw new Error(`Maintenance report delivery failed (${response.status}). Check Resend verification and permissions.`);
console.log('Maintenance report accepted by Resend.');
