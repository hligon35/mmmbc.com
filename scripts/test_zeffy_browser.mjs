import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../',import.meta.url));
// Reserve the normal icon width while running offline without Google's icon font.
const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/admin/workspace/workspace.css"><style>:root{--bg:#fff;--border:#e3ddd5;--text:#29231f;--muted:#6b625b;--accent:#a54c1e}body{margin:0;font-family:Arial,sans-serif}.ws-module{padding:20px}input,select{font:inherit;padding:8px;min-width:0}button{cursor:pointer}dialog{border:1px solid #e3ddd5;max-width:90vw}.ws-dialog-card{max-width:560px}.ws-button .material-icons-round{font-size:0;display:inline-block;width:18px;flex-shrink:0}</style></head><body><main id="app"></main><script type="module">import{financeRecorder}from'/admin/workspace/finance.mjs';const role=new URL(location.href).searchParams.get('role');const permissions=role==='entry'?['finance.view']:['finance.view','giving.sync'];const view=financeRecorder({permissions,notice:message=>{window.lastNotice=message}});document.querySelector('#app').append(view.root);window.finance=view;</script></body></html>`;
const server=http.createServer(async(req,res)=>{
  try{
    if(req.url.startsWith('/fixture')){res.setHeader('content-type','text/html');res.end(html);return;}
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(!pathname.startsWith('/admin/workspace/'))throw Error();
    res.setHeader('content-type',pathname.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(path.join(root,'admin/public/workspace',path.basename(pathname))));
  }catch{res.statusCode=404;res.end('Not found');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.GIVING_CHROMIUM_PATH||undefined,args:['--no-sandbox','--disable-gpu']});
let checks=0;
try{
  for(const width of [1440,390,320]){
    const page=await browser.newPage();await page.setViewportSize({width,height:1000});
    let mode='connected',syncCalls=0,lastQuery='',getCalls=0,filtered=false;
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const item={id:'payment-abc',campaignId:'giving',createdAt:'2026-10-06T12:00:00Z',donor:'<img src=x onerror=alert(1)>',email:'donor@example.com',currency:'USD',reportedAmount:'12500',amountCents:12500,status:'succeeded',refunds:[{id:'refund-1',amount:'5000',currency:'usd',status:'succeeded'}],syncedAt:'2026-10-06T13:00:00Z'};
    await page.route('**/api/admin/workspace/finance**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname.endsWith('/sync')){syncCalls++;await route.fulfill({json:{ok:true,complete:true}});return;}
      if(url.pathname.endsWith('/campaigns')){await route.fulfill({json:{items:[{id:'giving',title:'Tithes and Offering'}],hasMore:false,nextCursor:''}});return;}
      if(!url.pathname.endsWith('/zeffy')){await route.fulfill({json:{entries:[],meta:{categories:['Offering'],funds:['General']},summary:{incomeCents:0,expenseCents:0,netCents:0},giving:{tithesCents:0,offeringsCents:0}}});return;}
      getCalls++;lastQuery=url.search;
      if(mode==='error'){await route.fulfill({status:503,json:{error:'Donation storage unavailable'}});return;}
      const configured=mode!=='setup',amountUnit=mode==='units'?'':'minor';
      await route.fulfill({json:{items:mode==='empty'||mode==='setup'||filtered?[]:[{...item,amountCents:amountUnit?12500:null}],total:filtered||mode==='empty'||mode==='setup'?0:1,page:1,pageSize:40,connection:{configured,hasApiKey:configured,campaignIds:configured?['giving']:[],amountUnit,error:'',enabled:true},sync:{lastSuccess:configured?'2026-10-06T13:00:00Z':null,lastAttempt:null,error:mode==='cooldown'?'Zeffy rate limit reached':null,inProgress:false,retryAt:mode==='cooldown'?new Date(Date.now()+3600000).toISOString():null}}});
    });
    await page.goto(origin+'/fixture');await page.getByRole('tab',{name:'Zeffy Donations'}).click();await page.getByText('Connected to Zeffy',{exact:true}).waitFor();
    assert.equal(await page.getByRole('tab',{name:'Zeffy Donations'}).getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('.ws-zeffy img').count(),0);await page.getByText('$125.00',{exact:true}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow at '+width);checks++;
    await page.getByText('View',{exact:true}).click();await page.getByText('5000 · usd · succeeded · refund-1',{exact:true}).waitFor();checks++;
    await page.getByRole('button',{name:'Sync Now',exact:true}).click();await page.waitForFunction(()=>window.lastNotice==='Zeffy donations reconciled.');assert.equal(syncCalls,1);checks++;
    await page.getByRole('button',{name:'View Campaign IDs'}).click();await page.getByRole('heading',{name:'Zeffy Campaign IDs'}).waitFor();await page.getByText('Tithes and Offering',{exact:true}).waitFor();await page.getByRole('button',{name:'Close',exact:true}).click();checks++;
    await page.getByRole('searchbox',{name:'Search Zeffy donations'}).fill('Nobody');await page.getByRole('combobox',{name:'Payment status'}).selectOption('pending');filtered=true;await page.getByRole('button',{name:'Filter',exact:true}).click();await page.getByText(/No donations match/).waitFor();assert.match(lastQuery,/q=Nobody/);assert.match(lastQuery,/status=pending/);checks++;
    filtered=false;mode='units';await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('12500 USD (API units)',{exact:true}).waitFor();checks++;
    mode='cooldown';await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('Zeffy rate limit reached',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Sync Now',exact:true}).isDisabled(),true);checks++;
    mode='setup';await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('Zeffy API key needed',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Sync Now',exact:true}).isDisabled(),true);checks++;
    mode='error';await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('alert').filter({hasText:'Donation storage unavailable'}).waitFor();mode='connected';await page.getByRole('button',{name:'Try Again'}).click();await page.getByText('Connected to Zeffy',{exact:true}).waitFor();checks++;
    await page.reload();await page.getByRole('tab',{name:'Zeffy Donations'}).click();await page.getByText('$125.00',{exact:true}).waitFor();assert.ok(getCalls>5);checks++;
    if(width===390&&process.env.ZEFFY_SCREENSHOT_PATH)await page.screenshot({path:process.env.ZEFFY_SCREENSHOT_PATH,fullPage:true});
    await page.goto(origin+'/fixture?role=entry');await page.getByRole('tab',{name:'Zeffy Donations'}).click();await page.getByText('Connected to Zeffy',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Sync Now',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'View Campaign IDs'}).count(),0);checks++;
    assert.deepEqual(errors,[]);await page.close();
  }
  console.log('Passed '+checks+' Zeffy admin browser checks at desktop, 390px and 320px.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
