export const modules = Object.freeze([
  {id:'mail',label:'Mailbox',icon:'inbox',permissions:['submissions.view'],view:'mail'},
  {id:'rentals',label:'Facility Rentals',icon:'meeting_room',permissions:['submissions.view'],view:'mail'},
  {id:'calendar',label:'Calendar / Schedule',icon:'calendar_month',permissions:['events.view','submissions.view'],view:'calendar'},
  {id:'directory',label:'Church Directory',icon:'contacts',permissions:['directory.view'],panel:'tab-directory'},
  {id:'ministries',label:'Ministry Profiles',icon:'groups',permissions:['settings.manage'],panel:'tab-ministries',profile:'ministries'},
  {id:'leadership',label:'Leadership & Staff',icon:'badge',permissions:['settings.manage'],panel:'tab-ministries',profile:'leadership'},
  {id:'newsletter',label:'Newsletter',icon:'campaign',permissions:['newsletter.view'],panel:'tab-newsletter'},
  {id:'reports',label:'Reports',icon:'bar_chart',permissions:['submissions.view','newsletter.view'],view:'reports'},
  {id:'site-editor',label:'Site Editor',icon:'edit_note',permissions:['settings.manage'],view:'editor'},
  {id:'announcements',label:'Announcements & Bulletins',icon:'feed',permissions:['announcements.view'],panel:'tab-content'},
  {id:'photos',label:'Photos',icon:'photo_library',permissions:['photos.view'],panel:'tab-photos'},
  {id:'access',label:'Access Management',icon:'admin_panel_settings',permissions:['users.manage'],panel:'tab-settings'},
  {id:'settings',label:'Settings & Support',icon:'settings',permissions:['support.send'],panel:'tab-support'},
]);
export const canOpen = (module,permissions) => module.permissions.some(p=>permissions.includes(p));
export const legacyRoutes = Object.freeze({});
export function resolveRoute(path,hash='') {
  const normalized=path.replace(/\/$/,'');
  if(legacyRoutes[normalized])return {module:legacyRoutes[normalized],key:''};
  const match=/^\/admin\/(mail|rentals)\/(?:thread|record)\/([^/]+)$/.exec(normalized);
  if(match) {
    try{return {module:match[1],key:decodeURIComponent(match[2])};}catch{return null;}
  }
  if(normalized!=='/admin'&&!normalized.startsWith('/admin/'))return null;
  const id=normalized.replace(/^\/admin\/?/,'');
  if(modules.some(m=>m.id===id))return {module:id,key:''};
  if(['','index.html'].includes(id)) {
    const aliases={home:'mail',submissions:'mail',events:'calendar',content:'announcements',settings:'access',support:'settings'};
    const old=hash.replace(/^#/,'');
    return {module:aliases[old] || (modules.some(m=>m.id===old)?old:'mail'),key:''};
  }
  return null;
}
export function routeUrl(id,key='') {
  return '/admin/'+id+(key?'/'+(id==='rentals'?'record':'thread')+'/'+encodeURIComponent(key):'');
}
