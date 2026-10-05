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
let acceptedEmails=0,failList=false;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
  if(String(url).startsWith('https://api.resend.com/')){
    assert.equal(env.RESEND_API_KEY,'mock');acceptedEmails++;
    return Response.json({id:'mock-provider-'+acceptedEmails});
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
    const response=failList&&incoming.url.startsWith('/api/gallery')?Response.json({error:'Mock list failure'},{status:503}):await worker.fetch(request,env,{waitUntil:()=>{}});
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
  await page.goto(origin+'/admin/');
  await page.locator('#dashboardCard:not([hidden])').waitFor();
  await page.locator('#tab-home:not([hidden])').waitFor();
  await page.waitForLoadState('networkidle');
  await check('current tabbed admin boots without mailbox or runtime errors',async()=>{
    assert.equal(await page.evaluate(()=>window.MMWorkspaceEnabled),false);
    assert.equal(await page.locator('.ws-shell').count(),0);
    assert.equal(await page.locator('script[src*="workspace/shell.mjs"]').count(),0);
    assert.equal(await page.locator('#adminLayoutRefinementStyles').count(),1);
    assert.deepEqual(errors,[]);
  });
  await check('served assets match the deployment fingerprint',async()=>{
    const info=await page.evaluate(async()=> (await fetch('/api/build-info')).json());
    assert.equal(info.adminBuild.layout,'tabbed');
    assert.equal(info.adminBuild.fingerprint,await page.locator('meta[name="mmmbc-admin-build"]').getAttribute('content'));
    const entryAssets=await page.locator('script[src^="/admin/"],link[rel=stylesheet][href^="/admin/"]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('src')||n.getAttribute('href')));
    assert.ok(entryAssets.length>=6);
    assert.ok(entryAssets.every(url=>/\?v=[a-f0-9]{14}$/.test(url)));
  });
  const openSection=async(id)=>{
    const hash=id==='content'?'announcements':id;
    await page.goto(origin+'/admin/#'+hash);
    await page.locator('#tab-'+id+':not([hidden])').waitFor();
    await page.waitForLoadState('networkidle');
  };
  await check('existing operational sections remain reachable',async()=>{
    for(const id of ['content','directory','ministries','photos','submissions','newsletter','settings','support','home'])await openSection(id);
    assert.equal(await page.locator('#tab-content .contentEventsSplit__pane--events').count(),1);
    assert.equal(await page.locator('#tab-finances').count(),0);
    assert.equal(await page.locator('#tab-site-editor').count(),0);
    assert.deepEqual(errors,[]);
  });
  await check('hash navigation and reload retain the current admin',async()=>{
    await page.goto(origin+'/admin/#submissions');
    await page.locator('#tab-submissions:not([hidden])').waitFor();
    await page.reload();await page.locator('#tab-submissions:not([hidden])').waitFor();
    assert.equal(await page.locator('.ws-shell').count(),0);
  });
  await check('individual API failure does not replace the admin or disconnect navigation',async()=>{
    failList=true;await page.reload();await page.locator('#dashboardCard:not([hidden])').waitFor();
    await page.locator('#adminLiveRegion').filter({hasText:'Some admin data could not be loaded'}).waitFor({state:'attached'});
    await page.waitForLoadState('networkidle');
    await openSection('content');await openSection('home');failList=false;
  });
  await check('phone menu and current layout remain usable',async()=>{
    await page.setViewportSize({width:390,height:844});
    await openSection('content');await openSection('submissions');
    await page.locator('#navDrawerToggle').click();
    await page.waitForFunction(()=>document.getElementById('adminSideNav').getAttribute('aria-hidden')==='false');
    await page.locator('#tabBtn-content').click();
    await page.locator('#tab-content:not([hidden])').waitFor();
    assert.equal(await page.locator('#adminLayoutRefinementStyles').count(),1);
    assert.equal(await page.locator('.ws-shell').count(),0);
    assert.deepEqual(errors,[]);
  });
  assert.equal(acceptedEmails,0,'No email sent during deployment verification');
  console.log('Current admin browser verification passed.');
}finally{
  await browser.close();await new Promise(resolve=>server.close(resolve));globalThis.fetch=originalFetch;
}
