// Full browser interactions against isolated, in-memory SQLite stores. The
// email provider is always mocked; this never connects to production bindings.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import worker from '../src/worker-admin-api-wrapper.js';
import { workspaceEnv } from '../src/test-support/workspace-db.mjs';

const env=workspaceEnv();
env.GALLERY_BUCKET={get:async()=>null,put:async()=>{},list:async()=>({objects:[],truncated:false})};
let acceptedEmails=0,failProvider=false,failList=false;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
  if(String(url).startsWith('https://api.resend.com/')){
    assert.equal(env.RESEND_API_KEY,'mock');acceptedEmails++;
    return failProvider?Response.json({message:'Mock provider failure'},{status:503}):Response.json({id:'mock-provider-'+acceptedEmails});
  }
  return originalFetch(url,options);
};
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json'};
env.ASSETS={async fetch(request){
  const url=new URL(request.url);let pathname=url.pathname;
  if(pathname==='/admin'||pathname==='/admin/')pathname='/admin/index.html';
  const filename=path.resolve('cf_site','.'+pathname);
  if(!filename.startsWith(path.resolve('cf_site')+path.sep))return new Response('Forbidden',{status:403});
  try{return new Response(await fs.readFile(filename),{headers:{'Content-Type':types[path.extname(filename)]||'text/plain'}});}catch{return new Response('Missing asset',{status:404});}
}};
const server=http.createServer(async(incoming,outgoing)=>{
  try {
    let body='';for await(const chunk of incoming)body+=chunk;
    const url='http://127.0.0.1:'+server.address().port+incoming.url;
    const request=new Request(url,{method:incoming.method,headers:incoming.headers,...(!['GET','HEAD'].includes(incoming.method)?{body}: {})});
    const response=failList&&incoming.url.startsWith('/api/admin/mail/items?')?Response.json({error:'Mock list failure'},{status:503}):await worker.fetch(request,env,{waitUntil:()=>{}});
    outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch(error){console.error(error);outgoing.writeHead(500);outgoing.end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const args=process.env.PLAYWRIGHT_EXECUTABLE_PATH?['--no-sandbox','--disable-gpu','--disable-software-rasterizer','--no-zygote','--single-process']:[];
const executablePath=process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined;
const browser=await chromium.launch({headless:true,executablePath,args});
const context=await browser.newContext({viewport:{width:1440,height:960}});
const page=await context.newPage(),errors=[];
page.setDefaultTimeout(10000);
page.on('pageerror',error=>errors.push(error.message));
page.on('dialog',dialog=>dialog.accept());
await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
await page.route('https://fonts.gstatic.com/**',route=>route.abort());
const check=async(label,action)=>{await action();console.log('PASS '+label);};
try {
  await page.goto(origin+'/admin/mail');
  await page.locator('.ws-message').first().waitFor();
  await check('mailbox landing and escaped untrusted body',async()=>{
    await page.locator('.ws-message').filter({hasText:'Ada Brown'}).click();
    await page.locator('.ws-reader h1').filter({hasText:'Church question'}).waitFor();
    assert.match(await page.locator('.ws-message-body').first().innerText(),/<img src=x onerror=alert\(1\)>/);
    assert.equal(await page.locator('.ws-message-body img').count(),0);
    await page.reload();await page.locator('.ws-reader h1').filter({hasText:'Church question'}).waitFor();
  });
  await check('star and mark unread',async()=>{
    await page.locator('.ws-reader-toolbar').getByRole('button',{name:'Star',exact:true}).click();
    await page.locator('.ws-reader-toolbar').getByRole('button',{name:'Unstar',exact:true}).waitFor();
    await page.locator('.ws-reader-toolbar').getByRole('button',{name:'Mark unread',exact:true}).click();
    await page.locator('.ws-reader-toolbar').getByRole('button',{name:'Mark read',exact:true}).waitFor();
    assert.equal(env.SITE_DB.sqlite.prepare("SELECT is_read FROM mailbox_state WHERE item_key='contact:one'").get().is_read,0);
  });
  await check('archive, undo, deleted folder, and restore',async()=>{
    await page.locator('.ws-reader-toolbar').getByRole('button',{name:'Archive',exact:true}).click();
    await page.locator('.ws-toast').getByRole('button',{name:'Undo',exact:true}).click();
    await page.locator('.ws-message').filter({hasText:'Ada Brown'}).waitFor();
    await page.locator('.ws-message').filter({hasText:'Ada Brown'}).click();
    await page.locator('.ws-reader-toolbar').getByRole('button',{name:'Delete',exact:true}).click();
    await page.locator('[data-folder=deleted]').click();
    await page.locator('.ws-message').filter({hasText:'Ada Brown'}).click();
    await page.locator('.ws-reader-toolbar').getByRole('button',{name:'Restore',exact:true}).click();
    await page.locator('[data-folder=inbox]').click();
    await page.locator('.ws-message').filter({hasText:'Ada Brown'}).waitFor();
  });
  await check('reply draft survives refresh and send remains in conversation',async()=>{
    await page.locator('.ws-message').filter({hasText:'Ada Brown'}).click();
    await page.locator('.ws-reader-toolbar').getByRole('button',{name:'Reply',exact:true}).click();
    await page.locator('.ws-compose textarea').fill('Reply draft preserved.');
    await page.locator('.ws-compose [role=status]').filter({hasText:'Draft saved.'}).waitFor();
    await page.reload();await page.locator('.ws-reader-toolbar').getByRole('button',{name:'Reply',exact:true}).click();
    assert.equal(await page.locator('.ws-compose textarea').inputValue(),'Reply draft preserved.');
    await page.locator('.ws-compose').getByRole('button',{name:'Send message',exact:true}).click();
    await page.locator('.ws-thread-reply').filter({hasText:'Reply draft preserved.'}).waitFor();
    assert.equal(acceptedEmails,1);
  });
  await check('search, categories, and sort',async()=>{
    await page.locator('.ws-list-filters input').fill('Ada');
    await page.waitForFunction(()=>document.querySelectorAll('.ws-message').length===1);
    assert.match(await page.locator('.ws-message').innerText(),/Ada/);
    await page.locator('.ws-list-filters input').fill('');
    await page.locator('.ws-list-filters select').selectOption('oldest');
    await page.locator('.ws-folders').getByRole('button',{name:'Non-member rentals',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.ws-message').length===1);
    assert.match(await page.locator('.ws-message').innerText(),/Non-member rental/i);
  });
  await check('rentals and schedule preserve source workflows',async()=>{
    await page.goto(origin+'/admin/rentals/record/facility_rental%3Arent-a');
    await page.locator('.ws-rental-context').getByRole('button',{name:'Approve',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.ws-rental-context')?.textContent.includes('approved'));
    await page.locator('.ws-rental-context').getByRole('button',{name:'View Schedule',exact:true}).click();
    await page.locator('.ws-calendar').waitFor();assert.match(await page.locator('.ws-module').innerText(),/Community event/);
    await page.goBack();await page.locator('.ws-rental-context').waitFor();
    await page.goForward();await page.locator('.ws-calendar').waitFor();
  });
  await check('operational reports export without finance navigation',async()=>{
    await page.goto(origin+'/admin/reports');await page.locator('.ws-report-section').first().waitFor();
    const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export CSV',exact:true}).click();assert.match((await download).suggestedFilename(),/church-operations/);
    assert.equal(await page.locator('[data-module=finances],[data-module=giving]').count(),0);
  });
  await check('standalone site editor is removed from the workspace',async()=>{
    await page.goto(origin+'/admin');
    assert.equal(await page.locator('[data-module=site-editor]').count(),0);
    const status=await page.evaluate(async()=>{const response=await fetch('/api/admin/site-pages',{credentials:'same-origin'});return response.status;});
    assert.equal(status,404);
  });
  await check('existing church modules load inside the same application',async()=>{
    const failures=[];
    const watch=response=>{if(new URL(response.url()).pathname.startsWith('/api/')&&response.status()>=500)failures.push(response.url());};
    page.on('response',watch);
    for(const [route,title]of [['directory','Church Directory'],['newsletter','Newsletter'],['access','Access Management'],['settings','Settings & Support'],['announcements','Announcements & Bulletins'],['photos','Photos']]){
      await page.locator('[data-module="'+route+'"]').click();
      await page.waitForFunction(title=>document.title===title+' · Mount Moriah',title);
      assert.equal(await page.locator('.ws-shell').count(),1);
    }
    page.off('response',watch);assert.deepEqual(failures,[],'Existing modules have no failed server requests');
  });
  await check('failed outbound send remains saved and retries without another message record',async()=>{
    await page.goto(origin+'/admin/mail');await page.locator('.ws-message').first().waitFor();
    await page.locator('.ws-drawer').getByRole('button',{name:'New Message',exact:true}).click();
    await page.locator('.ws-compose').getByLabel('To',{exact:true}).fill('test@example.com');
    await page.locator('.ws-compose').getByLabel('Subject',{exact:true}).fill('Mock retry verification');
    await page.locator('.ws-compose').getByLabel('Message',{exact:true}).fill('Never sent to a real email provider.');
    failProvider=true;
    await page.locator('.ws-compose').getByRole('button',{name:'Send message',exact:true}).click();
    await page.locator('.ws-compose [role=status]').filter({hasText:'failed'}).waitFor();
    assert.equal(env.SITE_DB.sqlite.prepare('SELECT count(*) AS n FROM mailbox_outbound').get().n,2);
    failProvider=false;
    await page.locator('.ws-compose').getByRole('button',{name:'Send message',exact:true}).click();
    await page.locator('.ws-message').filter({hasText:'Mock retry verification'}).waitFor();
    assert.equal(env.SITE_DB.sqlite.prepare('SELECT count(*) AS n FROM mailbox_outbound').get().n,2);
    assert.equal(env.SITE_DB.sqlite.prepare("SELECT status FROM mailbox_outbound WHERE subject='Mock retry verification'").get().status,'accepted');
  });
  await check('error retry preserves loaded records',async()=>{
    await page.goto(origin+'/admin/mail');await page.locator('.ws-message').first().waitFor();
    const count=await page.locator('.ws-message').count();failList=true;
    await page.locator('.ws-list-head').getByRole('button',{name:'Refresh',exact:true}).click();await page.locator('.ws-collection .ws-error').waitFor();
    assert.equal(await page.locator('.ws-message').count(),count);failList=false;await page.locator('.ws-collection .ws-error').getByRole('button',{name:'Try Again',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.ws-collection .ws-error'));
  });
  await check('desktop panes stay inside viewport',async()=>{
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await page.locator('.ws-shell').evaluate(n=>n.getBoundingClientRect().top),0);
    await page.screenshot({path:process.env.WORKSPACE_SCREENSHOT_DIR?process.env.WORKSPACE_SCREENSHOT_DIR+'/workspace-desktop.png':'/tmp/mmmbc-workspace-desktop.png',fullPage:true});
  });
  await check('phone drawer and single-pane reader navigation',async()=>{
    for(const [width,height] of [[430,932],[390,844],[360,800],[320,568]]){
      await page.setViewportSize({width,height});
      await page.goto(origin+'/admin/mail');
      await page.locator('.ws-message').first().waitFor();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'workspace overflow at '+width);
    }
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'Menu',exact:true}).click();await page.locator('.ws-drawer-open').waitFor();
    await page.locator('[data-module=mail]').click();await page.locator('.ws-message').first().click();await page.locator('.ws-reading').waitFor();
    assert.equal(await page.locator('.ws-collection').isVisible(),false);assert.equal(await page.locator('.ws-reader').isVisible(),true);
    await page.locator('.ws-mobile-back').click();await page.waitForFunction(()=>!document.querySelector('.ws-reading'));
    assert.equal(await page.locator('.ws-collection').isVisible(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await page.locator('.ws-shell').evaluate(n=>n.getBoundingClientRect().top),0);
    await page.screenshot({path:process.env.WORKSPACE_SCREENSHOT_DIR?process.env.WORKSPACE_SCREENSHOT_DIR+'/workspace-mobile.png':'/tmp/mmmbc-workspace-mobile.png',fullPage:true});
  });
  assert.deepEqual(errors,[],'No browser runtime exceptions');
  console.log('Browser workspace verification passed.');
}finally{
  await browser.close();await new Promise(resolve=>server.close(resolve));globalThis.fetch=originalFetch;
}
