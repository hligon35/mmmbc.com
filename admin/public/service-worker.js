// Admin records, session responses, drafts, and HTML are never cached. This
// service worker only prepares push/click hooks; actual subscriptions require
// a future authenticated push backend and VAPID configuration.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let data={};try{data=event.data?.json()||{};}catch{return;}
  let path='/admin/mail';
  try{const url=new URL(data.url,self.location.origin);if(url.origin===self.location.origin&&url.pathname.startsWith('/admin/'))path=url.pathname+url.search;}catch{}
  event.waitUntil(self.registration.showNotification('Mount Moriah',{body:'New church administration activity.',icon:'/admin/icons/icon-192.png',badge:'/admin/icons/icon-192.png',data:{url:path}}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const url=new URL(event.notification.data?.url||'/admin/mail',self.location.origin);
  if(url.origin!==self.location.origin||!url.pathname.startsWith('/admin/'))return;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{
    const client=clients.find(c=>new URL(c.url).pathname.startsWith('/admin/'));
    if(client){await client.navigate(url.href);await client.focus();}else await self.clients.openWindow(url.href);
  }));
});
