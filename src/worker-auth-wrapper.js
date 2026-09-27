import worker from './worker.js';
import {
  authenticateAdminRequest,
  authErrorResponse,
  handleMeRequest
} from './admin-auth.js';
import { handleAdminUserSettingsRequest, isAdminUserSettingsPath } from './admin-user-settings.js';

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

async function authenticate(request, env) {
  return authenticateAdminRequest(request, env, env.__ACCESS_JWKS ? { jwks: env.__ACCESS_JWKS } : {});
}

const LOGIN_STYLE = `
<style id="mmmbc-login-fixes">
  #authShell.loginShell {
    width: min(1080px, calc(100% - 32px));
    min-height: calc(100dvh - 28px);
    margin: 0 auto;
    display: grid;
    grid-template-columns: minmax(0, 42fr) minmax(0, 58fr);
    gap: clamp(32px, 5vw, 64px);
    align-items: center;
    justify-content: center;
  }
  #authShell .loginStage { min-width: 0; display: flex; align-items: center; }
  #authShell .loginCard { width: 100%; max-width: 560px; margin: 0; }
  #authShell .peekBtn { border: 0 !important; background: transparent !important; border-radius: 999px; }
  #authShell .peekBtn:hover { border: 0 !important; background: rgba(255,255,255,.08) !important; }
  #photoGrid.grid {
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    align-items: stretch;
  }
  #photoGrid .thumb {
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  #photoGrid .thumb__img {
    width: 100%;
    aspect-ratio: 4 / 3;
    height: auto;
    object-fit: contain;
    object-position: center;
    background: #111;
    display: block;
  }
  #photoGrid .thumb__meta { min-width: 0; flex: 1; }
  #photoGrid .thumb__label,
  #photoGrid .thumb__small { overflow-wrap: anywhere; word-break: break-word; }
  #photoGrid .row__actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    width: 100%;
    min-width: 0;
  }
  #photoGrid .row__actions .btn {
    width: 100%;
    min-width: 0;
    padding: 10px 8px;
    text-align: center;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  #photoPager,
  #photoPagerBottom {
    width: 100%;
    justify-content: center !important;
    align-items: center;
    gap: 14px;
  }
  #photoPager { margin: 24px 0 18px !important; }
  #photoPagerBottom { margin: 22px 0 8px !important; }

  #photoBulkBar { display: none !important; }
  .photoHeaderBulkActions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
  }
  .photoHeaderBulkActions .btn { min-height: 42px; }
  .photoHeaderBulkActions #photoBulkCount { width: 100%; text-align: right; }

  @media (max-width: 760px) {
    #authShell.loginShell { min-height: calc(100dvh - 20px); grid-template-columns: 1fr; gap: 18px; padding: 24px 0; }
    #authShell .loginBrand { min-height: auto; padding: 0 16px; }
    #authShell .loginBrand__logo { width: min(100%, 300px); max-height: 220px; }
    #authShell .loginStage { justify-content: center; }
    #photoGrid.grid { grid-template-columns: 1fr; }
    .photoHeaderBulkActions { width: 100%; justify-content: stretch; }
    .photoHeaderBulkActions .btn { flex: 1 1 180px; }
    .photoHeaderBulkActions #photoBulkCount { text-align: left; }
  }
</style>`;

const ADMIN_LAYOUT_SCRIPT = `
<script id="mmmbc-admin-layout-fixes">
(() => {
  const moveBulkActions = () => {
    const bar = document.getElementById('photoBulkBar');
    const headerRow = document.querySelector('#tab-photos .sectionHeader .iconGroup__row');
    if (!bar || !headerRow || document.querySelector('.photoHeaderBulkActions')) return;

    const wrap = document.createElement('div');
    wrap.className = 'photoHeaderBulkActions';
    wrap.setAttribute('aria-label', 'Bulk photo actions');

    const edit = document.getElementById('photoBulkEditBtn');
    const del = document.getElementById('photoBulkDeleteBtn');
    const count = document.getElementById('photoBulkCount');
    if (edit) wrap.appendChild(edit);
    if (del) wrap.appendChild(del);
    if (count) wrap.appendChild(count);

    headerRow.appendChild(wrap);
    bar.remove();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', moveBulkActions, { once: true });
  } else {
    moveBulkActions();
  }
})();
</script>`;

async function injectLoginStyle(response) {
  const type = String(response.headers.get('Content-Type') || '').toLowerCase();
  if (!type.includes('text/html')) return response;
  const html = await response.text();
  let next = html;
  if (!next.includes('id="mmmbc-login-fixes"')) next = next.replace('</head>', `${LOGIN_STYLE}\n</head>`);
  if (!next.includes('id="mmmbc-admin-layout-fixes"')) next = next.replace('</body>', `${ADMIN_LAYOUT_SCRIPT}\n</body>`);
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.set('Cache-Control', 'no-store');
  return new Response(next, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/csrf' && request.method === 'GET') {
      return json({ csrfToken: crypto.randomUUID() });
    }

    if (url.pathname === '/api/auth/logout' && (request.method === 'GET' || request.method === 'POST')) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${url.origin}/cdn-cgi/access/logout`,
          'Cache-Control': 'no-store'
        }
      });
    }

    if (url.pathname === '/api/me' && request.method === 'GET') {
      return handleMeRequest(request, env, ctx);
    }

    if (isAdminUserSettingsPath(url.pathname)) {
      try {
        return handleAdminUserSettingsRequest(request, env, await authenticate(request, env));
      } catch (error) {
        return authErrorResponse(error);
      }
    }

    const response = await worker.fetch(request, env, ctx);
    if (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname.startsWith('/admin/')) {
      return injectLoginStyle(response);
    }
    return response;
  },

  async scheduled(event, env, ctx) {
    if (typeof worker.scheduled === 'function') {
      return worker.scheduled(event, env, ctx);
    }
  }
};
