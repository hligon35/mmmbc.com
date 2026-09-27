#!/usr/bin/env node

const inputBase = process.env.BASE_URL || process.argv[2] || 'http://127.0.0.1:8787';
const baseUrl = String(inputBase).replace(/\/+$/, '');

function joinUrl(pathname) {
  return `${baseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

async function runCheck(check) {
  const url = joinUrl(check.path);
  const init = {
    method: check.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(check.headers || {})
    }
  };

  if (check.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(check.body);
  }

  try {
    const response = await fetch(url, init);
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    const okStatus = check.expectedStatuses.includes(response.status);
    let okShape = true;
    if (typeof check.validate === 'function') {
      try {
        okShape = Boolean(check.validate(parsed, response));
      } catch {
        okShape = false;
      }
    }

    return {
      name: check.name,
      method: init.method,
      path: check.path,
      status: response.status,
      pass: okStatus && okShape,
      detail: okStatus ? (okShape ? 'ok' : 'response shape mismatch') : `expected ${check.expectedStatuses.join('/')} got ${response.status}`
    };
  } catch (error) {
    return {
      name: check.name,
      method: init.method,
      path: check.path,
      status: 0,
      pass: false,
      detail: String(error?.message || error)
    };
  }
}

const checks = [
  {
    name: 'Public announcements feed',
    method: 'GET',
    path: '/api/public/announcements',
    expectedStatuses: [200],
    validate: (json) => Array.isArray(json?.posts)
  },
  {
    name: 'Public events feed',
    method: 'GET',
    path: '/api/public/events',
    expectedStatuses: [200],
    validate: (json) => Array.isArray(json?.events)
  },
  {
    name: 'Public bulletins feed',
    method: 'GET',
    path: '/api/public/bulletins',
    expectedStatuses: [200],
    validate: (json) => Array.isArray(json?.bulletins)
  },
  {
    name: 'Public gallery feed',
    method: 'GET',
    path: '/api/public/gallery',
    expectedStatuses: [200],
    validate: (json) => Array.isArray(json?.items)
  },
  {
    name: 'Public YouTube feed',
    method: 'GET',
    path: '/api/public/youtube',
    expectedStatuses: [200],
    validate: (json) => Array.isArray(json?.videos)
  },
  {
    name: 'Public site settings',
    method: 'GET',
    path: '/api/public/site-settings',
    expectedStatuses: [200],
    validate: (json) => json && typeof json === 'object' && typeof json.email === 'string'
  },
  {
    name: 'Public livestream payload',
    method: 'GET',
    path: '/api/public/livestream',
    expectedStatuses: [200],
    validate: (json) => json && typeof json === 'object' && json.active && json.embeds
  },
  {
    name: 'Newsletter subscribe validation',
    method: 'POST',
    path: '/api/public/newsletter/subscribe',
    body: { email: 'not-an-email' },
    expectedStatuses: [400],
    validate: (json) => typeof json?.error === 'string'
  },
  {
    name: 'Contact message validation',
    method: 'POST',
    path: '/api/public/contact-message',
    body: { name: '', email: '', message: '' },
    expectedStatuses: [400],
    validate: (json) => typeof json?.error === 'string'
  },
  {
    name: 'Facility request validation',
    method: 'POST',
    path: '/api/public/facility-rental-request',
    body: { audience: 'member', form: {} },
    expectedStatuses: [400],
    validate: (json) => typeof json?.error === 'string'
  },
  {
    name: 'Admin integration health requires auth',
    method: 'GET',
    path: '/api/admin/integration-health',
    expectedStatuses: [401],
    validate: (json) => typeof json?.error === 'string'
  },
  {
    name: 'Unknown API returns JSON 404',
    method: 'GET',
    path: '/api/does-not-exist',
    expectedStatuses: [404],
    validate: (json) => typeof json?.error === 'string'
  }
];

const results = [];
for (const check of checks) {
  // Run serially to keep output stable and avoid overlapping request logs.
  // eslint-disable-next-line no-await-in-loop
  results.push(await runCheck(check));
}

const nameWidth = Math.max(...results.map((r) => r.name.length), 12);
const methodWidth = Math.max(...results.map((r) => r.method.length), 6);
const pathWidth = Math.max(...results.map((r) => r.path.length), 12);

const line = '-'.repeat(nameWidth + methodWidth + pathWidth + 28);
console.log(`BASE_URL: ${baseUrl}`);
console.log(line);
console.log(
  `${'Check'.padEnd(nameWidth)}  ${'Method'.padEnd(methodWidth)}  ${'Path'.padEnd(pathWidth)}  Status  Result  Detail`
);
console.log(line);

for (const r of results) {
  console.log(
    `${r.name.padEnd(nameWidth)}  ${r.method.padEnd(methodWidth)}  ${r.path.padEnd(pathWidth)}  ${String(r.status).padEnd(6)}  ${r.pass ? 'PASS' : 'FAIL'}    ${r.detail}`
  );
}

console.log(line);
const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.error(`Integration verification failed: ${failed.length} check(s) failed.`);
  process.exit(1);
}
console.log('Integration verification passed.');
