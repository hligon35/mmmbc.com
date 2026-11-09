const PREVIEW_HOST = 'mmmbc.hligon.workers.dev';
export function previewConfig(production, databaseId, accessAudience) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(databaseId || '') || production.d1_databases.some(d => d.database_id === databaseId)) throw new Error('Supply the UUID of mmmbc-preview, distinct from production.');
  if (!String(accessAudience || '').trim()) throw new Error('MMMBC_PREVIEW_ACCESS_AUD is required.');
  return {
    ...production, name: 'mmmbc', workers_dev: true, preview_urls: false, routes: [], triggers: { crons: [] },
    d1_databases: ['DB', 'SITE_DB'].map(binding => ({binding, database_name:'mmmbc-preview', database_id:databaseId, migrations_dir:'./migrations'})),
    r2_buckets: [{binding:'GALLERY_BUCKET',bucket_name:'mmmbc-preview'}],
    vars: {...production.vars, ENVIRONMENT:'preview', CANONICAL_HOST:PREVIEW_HOST, PUBLIC_SITE_URL:'https://'+PREVIEW_HOST,
      CF_ACCESS_AUD:accessAudience, TURNSTILE_ALLOWED_HOSTNAMES:PREVIEW_HOST, DEMO_MODE:'false',
      DEV_BYPASS_AUTH:'false', ALLOW_SERVICE_TOKEN_ADMIN:'false', ZEFFY_SYNC_ENABLED:'false', GIVING_PROVIDER:'disabled'},
    observability: {...production.observability,redact_query_string:true}
  };
}
