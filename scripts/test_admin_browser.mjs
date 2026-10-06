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
let apiRequests=[];
page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/'))apiRequests.push(url.pathname);});
const clickTab=async id=>{
  if(await page.locator('#adminSideNav').getAttribute('aria-hidden')!=='false'){await page.locator('#navDrawerToggle').click();await page.waitForFunction(()=>document.getElementById('adminSideNav').getAttribute('aria-hidden')==='false');}
  await page.locator('#tabBtn-'+id).click();
};
const countApi=prefix=>apiRequests.filter(p=>p.startsWith(prefix)).length;
try {
  await page.goto(origin+'/admin/');
  await page.locator('#dashboardCard:not([hidden])').waitFor();
  await page.locator('#tab-home:not([hidden])').waitFor();
  await page.waitForLoadState('networkidle');
  await check('mailbox workspace boots as the primary admin without runtime errors',async()=>{
    assert.equal(await page.evaluate(()=>window.MMWorkspaceEnabled),true);
    assert.equal(await page.locator('.ws-shell').count(),1);
    assert.equal(await page.locator('script[src*="workspace/shell.mjs"]').count(),1);
    assert.equal(await page.locator('#adminLayoutRefinementStyles').count(),1);
    assert.deepEqual(errors,[]);
  });
  await check('served assets match the deployment fingerprint',async()=>{
    const info=await page.evaluate(async()=> (await fetch('/api/build-info')).json());
    assert.equal(info.adminBuild.layout,'mailbox-workspace');
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
    assert.equal(await page.locator('.ws-shell').count(),1);
  });
  await check('one tab click activates one section and loads only that section',async()=>{
    await page.goto(origin+'/admin/#home');await page.reload();await page.locator('#tab-home:not([hidden])').waitFor();await page.waitForLoadState('networkidle');
    await page.evaluate(()=>{window.__activations=[];window.addEventListener('admin:section-activated',e=>window.__activations.push(e.detail.sectionId));});
    apiRequests=[];
    await clickTab('submissions');
    await page.locator('#tab-submissions:not([hidden])').waitFor();await page.waitForLoadState('networkidle');
    assert.deepEqual(await page.evaluate(()=>window.__activations),['tab-submissions']);
    assert.equal(countApi('/api/submissions'),1);
    for(const unrelated of ['/api/me','/api/csrf','/api/gallery','/api/announcements','/api/bulletins','/api/events','/api/subscribers','/api/newsletter','/api/dashboard'])assert.equal(countApi(unrelated),0,unrelated+' was requested');
    apiRequests=[];await clickTab('submissions');
    assert.equal(apiRequests.length,0,'re-selecting the active tab must not reload');
  });
  await check('Back and Forward move between sections without session reloads',async()=>{
    await clickTab('support');await page.locator('#tab-support:not([hidden])').waitFor();
    apiRequests=[];
    await page.goBack();await page.locator('#tab-submissions:not([hidden])').waitFor();
    await page.goForward();await page.locator('#tab-support:not([hidden])').waitFor();
    assert.equal(countApi('/api/me'),0);assert.equal(countApi('/api/csrf'),0);
  });
  await check('open drawer and unsaved form values survive background navigation',async()=>{
    await page.setViewportSize({width:390,height:844});
    await page.locator('#navDrawerToggle').click();
    await page.waitForFunction(()=>document.getElementById('adminSideNav').getAttribute('aria-hidden')==='false');
    await page.evaluate(()=>{location.hash='#newsletter';});
    await page.locator('#tab-newsletter:not([hidden])').waitFor();
    assert.equal(await page.locator('#adminSideNav').getAttribute('aria-hidden'),'false');
    await page.setViewportSize({width:1440,height:960});
  });
  await check('historical deep links reach equivalent current sections',async()=>{
    for(const [url,section] of [['/admin/#events','tab-content'],['/admin/mail','tab-submissions'],['/admin/rentals','tab-submissions'],['/admin/calendar','tab-content'],['/admin/reports','tab-home'],['/admin/access','tab-settings']]){
      await page.goto(origin+url);
      await page.locator('#'+section+':not([hidden])').waitFor();
      assert.equal(await page.locator('.tabPanel:not([hidden])').count(),1,url);
    }
    await page.goto(origin+'/admin/rentals');await page.locator('#tab-submissions:not([hidden])').waitFor();
    assert.equal(await page.locator('[data-submission-type-filter="facility_rental"]').first().getAttribute('aria-pressed'),'true');
  });
  await check('more than 300 submissions page on the server and rapid searches never show stale results',async()=>{
    const sql=env.SITE_DB.sqlite,insert=sql.prepare('INSERT INTO contact_messages(id,name,email,subject,message,created_at) VALUES(?,?,?,?,?,?)');
    sql.exec('BEGIN');
    for(let i=0;i<354;i++)insert.run('bulk-'+i,'Sender '+i,'sender'+i+'@example.com',i===5?'L'+'ong subject '.repeat(40):'Subject '+i,'Body '+i,new Date(Date.UTC(2026,0,1,0,0,i)).toISOString());
    sql.exec('COMMIT');
    await openSection('submissions');
    const info=page.locator('#submissionsPageInfo');
    await info.filter({hasText:'1\u201325 of 358'}).waitFor();
    assert.equal(await page.locator('#submissionsTableBody tr').count(),25);
    assert.ok(await page.locator('#submissionsNextBtn').isEnabled());
    await page.locator('#submissionsNextBtn').click();
    await info.filter({hasText:'26\u201350 of 358'}).waitFor();
    const search=page.locator('#submissionsSearch');
    await search.fill('');
    await search.pressSequentially('Sender 353',{delay:5});
    await page.locator('#submissionsTableBody tr').filter({hasText:'Sender 353'}).first().waitFor();
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#submissionsTableBody tr').count(),1);
    await search.fill('');await page.waitForLoadState('networkidle');
  });
  await check('large galleries load one bounded page at a time',async()=>{
    const sql=env.DB.sqlite,insert=sql.prepare('INSERT INTO gallery_items(id,album,label,tags_json,file_key,thumb_key,original_name,created_at,position) VALUES(?,?,?,?,?,?,?,?,?)');
    sql.exec('BEGIN');
    for(let i=0;i<1200;i++)insert.run('bg'+i,i%2?'Easter':'Choir','Label '+i,'[]','k'+i+'.jpg',null,'img'+i+'.jpg',new Date(Date.UTC(2026,0,1,0,0,i)).toISOString(),i);
    sql.exec('COMMIT');
    const sizes=[];
    const onResponse=async response=>{const url=new URL(response.url());if(url.pathname==='/api/gallery'&&response.request().method()==='GET')sizes.push((await response.json()).items.length);};
    page.on('response',onResponse);
    await openSection('photos');
    await page.locator('#photoPageInfo').filter({hasText:'1200 photo'}).waitFor();
    page.off('response',onResponse);
    assert.ok(sizes.length>0&&sizes.every(n=>n<=200),'gallery list must be bounded: '+sizes);
    assert.ok(await page.locator('#photoGrid > *').count()<=200);
  });
  await check('long content does not overflow desktop, tablet, or phone layouts',async()=>{
    for(const [width,height] of [[1440,960],[820,1180],[390,844]]){
      await page.setViewportSize({width,height});
      for(const id of ['submissions','content','photos']){
        await openSection(id);
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
        assert.ok(overflow<=1,id+' overflows by '+overflow+'px at '+width);
      }
    }
    await page.setViewportSize({width:1440,height:960});
  });
  await check('toasts are dismissible and last about five seconds',async()=>{
    await page.evaluate(()=>showToast('Saved for testing'));
    const toast=page.locator('.toast').filter({hasText:'Saved for testing'});
    await toast.waitFor();
    await toast.locator('.toast__dismiss').click();
    await toast.waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>TOAST_DEFAULT_MS),5000);
  });
  await check('individual API failure does not replace the admin or disconnect navigation',async()=>{
    failList=true;await page.goto(origin+'/admin/#photos');await page.locator('#tab-photos:not([hidden])').waitFor();
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
    assert.equal(await page.locator('.ws-shell').count(),1);
    assert.deepEqual(errors,[]);
  });
  assert.equal(acceptedEmails,0,'No email sent during deployment verification');
  console.log('Mailbox workspace browser verification passed.');
}finally{
  await browser.close();await new Promise(resolve=>server.close(resolve));globalThis.fetch=originalFetch;
}
