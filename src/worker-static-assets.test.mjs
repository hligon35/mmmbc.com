import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker-admin-api-wrapper.js';
import { workspaceEnv } from './test-support/workspace-db.mjs';

test('admin HTML is fetched without compression before Worker transformation', async () => {
  let assetRequest;
  const response = await worker.fetch(new Request('https://localhost/admin'), {
    ...workspaceEnv(),
    ASSETS: {
      fetch: async (request) => {
        assetRequest = request;
        return new Response('<!doctype html><html><head></head><body></body></html>', {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Encoding': 'gzip'
          }
        });
      }
    }
  }, {});

  const body = await response.text();
  assert.equal(assetRequest.headers.get('Accept-Encoding'), 'identity');
  assert.match(body, /mmmbc-admin-structure-js/);
  assert.equal(response.headers.get('Content-Encoding'), null);
});
