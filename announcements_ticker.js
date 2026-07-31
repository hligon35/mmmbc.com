// Homepage announcement ticker: rotates through active announcements.
(function () {
  const ROTATE_MS = 6500;
  const SLIDE_MS = 460;

  function isExpired(expiresAtIso) {
    if (!expiresAtIso) return false;
    const t = Date.parse(expiresAtIso);
    if (Number.isNaN(t)) return false;
    return t <= Date.now();
  }

  function hasNotStarted(startsAtIso) {
    if (!startsAtIso) return false;
    const t = Date.parse(startsAtIso);
    if (Number.isNaN(t)) return false;
    return t > Date.now();
  }

  function safeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function buildTickerText(post) {
    const title = safeText(post?.title);
    const body = safeText(post?.body);
    const combined = title && body ? `${title}: ${body}` : (title || body || '');
    return combined.length > 220 ? `${combined.slice(0, 217)}…` : combined;
  }

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function startRotation({ wrap, stack, lineA, lineB, srEl, messages }) {
    let idx = 0;
    let paused = false;

    const show = (text) => {
      lineA.textContent = text;
      lineB.textContent = '';
      srEl.textContent = text;
    };

    const slideToNext = () => {
      if (paused) return;
      if (messages.length <= 1) return;
      if (stack.classList.contains('is-sliding')) return;

      const nextIdx = (idx + 1) % messages.length;
      const nextText = messages[nextIdx];

      lineB.textContent = nextText;
      stack.classList.add('is-sliding');

      window.setTimeout(() => {
        stack.classList.remove('is-sliding');
        idx = nextIdx;
        show(nextText);
      }, SLIDE_MS);
    };

    const onPause = () => { paused = true; };
    const onResume = () => { paused = false; };

    wrap.addEventListener('mouseenter', onPause);
    wrap.addEventListener('mouseleave', onResume);
    wrap.addEventListener('focusin', onPause);
    wrap.addEventListener('focusout', onResume);

    show(messages[0]);
    const timer = window.setInterval(slideToNext, ROTATE_MS);

    return () => {
      window.clearInterval(timer);
      wrap.removeEventListener('mouseenter', onPause);
      wrap.removeEventListener('mouseleave', onResume);
      wrap.removeEventListener('focusin', onPause);
      wrap.removeEventListener('focusout', onResume);
    };
  }

  async function loadTicker() {
    const wrap = document.getElementById('announcementTickerWrap');
    const srEl = document.getElementById('announcementTickerSr');
    const linkEl = document.getElementById('announcementTicker');
    const stack = document.getElementById('announcementTickerStack');
    const lineA = document.getElementById('announcementTickerLineA');
    const lineB = document.getElementById('announcementTickerLineB');

    if (!wrap || !srEl || !linkEl || !stack || !lineA || !lineB) return;

    const hideTicker = () => {
      wrap.hidden = true;
      lineA.textContent = '';
      lineB.textContent = '';
      srEl.textContent = '';
    };

    try {
      let data = null;
      const endpoints = ['/api/public/announcements', 'announcements.json'];
      for (const endpoint of endpoints) {
        try {
          const res = await fetch(endpoint, { cache: 'no-store' });
          if (!res.ok) continue;
          data = await res.json();
          break;
        } catch {
          // Continue trying fallbacks.
        }
      }
      if (!data) throw new Error('Failed to load announcements');
      const posts = Array.isArray(data?.posts) ? data.posts : [];

      const active = posts
        .filter((p) => p && (p.title || p.body))
        .filter((p) => !hasNotStarted(p.startsAt))
        .filter((p) => !isExpired(p.expiresAt))
        .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));

      const messages = active
        .map(buildTickerText)
        .map(safeText)
        .filter(Boolean);

      if (!messages.length) {
        hideTicker();
        return;
      }

      wrap.hidden = false;

      if (prefersReducedMotion() || messages.length === 1) {
        lineA.textContent = messages[0];
        lineB.textContent = '';
        srEl.textContent = messages[0];
        return;
      }

      startRotation({ wrap: linkEl, stack, lineA, lineB, srEl, messages });
    } catch {
      hideTicker();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    void loadTicker();
  });

})();
