// Homepage bulletin frame: shows the currently scheduled bulletin (PDF or image)
(function () {
  function parseTime(v) {
    if (!v) return null;
    const t = Date.parse(v);
    if (Number.isNaN(t)) return null;
    return t;
  }

  function isActive(b) {
    const start = parseTime(b?.startsAt);
    const end = parseTime(b?.endsAt);
    const now = Date.now();
    if (start != null && now < start) return false;
    if (end != null && now >= end) return false;
    if (start == null && end == null) return false;
    return true;
  }

  function guessKind(b) {
    const mime = String(b?.mimeType || '').toLowerCase();
    const url = String(b?.url || '').toLowerCase();
    const name = String(b?.originalName || b?.fileName || '').toLowerCase();
    if (mime.includes('pdf') || url.endsWith('.pdf') || name.endsWith('.pdf')) return 'pdf';
    if (mime.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/.test(url) || /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/.test(name)) return 'image';
    return 'file';
  }

  function setText(el, text) {
    if (el) el.textContent = String(text || '');
  }

  function renderBulletin(bulletin) {
    const wrap = document.getElementById('bulletinFrameWrap');
    const titleEl = document.getElementById('bulletinTitle');
    const openEl = document.getElementById('bulletinOpenLink');
    const bodyEl = document.getElementById('bulletinFrameBody');
    if (!wrap || !titleEl || !openEl || !bodyEl) return;
    if (!bulletin) {
      wrap.hidden = true;
      return;
    }

    const title = String(bulletin.title || 'Bulletin');
    setText(titleEl, title);
    openEl.href = bulletin.url;
    openEl.hidden = !bulletin.url;
    bodyEl.innerHTML = '';

    const kind = guessKind(bulletin);
    if (kind === 'image') {
      const img = document.createElement('img');
      img.className = 'bulletin-frame__image';
      img.src = bulletin.url;
      img.alt = title;
      img.loading = 'lazy';
      bodyEl.appendChild(img);
    } else if (kind === 'pdf') {
      const iframe = document.createElement('iframe');
      iframe.className = 'bulletin-frame__pdf';
      iframe.src = bulletin.url;
      iframe.title = title;
      iframe.loading = 'lazy';
      bodyEl.appendChild(iframe);
      const note = document.createElement('div');
      note.className = 'bulletin-frame__note';
      note.textContent = 'If the PDF does not display here, use “Open”.';
      bodyEl.appendChild(note);
    } else {
      const link = document.createElement('a');
      link.className = 'bulletin-frame__fallbackLink';
      link.href = bulletin.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open bulletin';
      bodyEl.appendChild(link);
    }
    wrap.hidden = false;
  }

  async function loadBulletin() {
    try {
      const res = await fetch('bulletins.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load bulletins');
      const data = await res.json();
      const all = Array.isArray(data?.bulletins) ? data.bulletins : [];
      const active = all.filter(isActive).sort((a, b) => (parseTime(b.startsAt) || 0) - (parseTime(a.startsAt) || 0));
      renderBulletin(active[0] || null);
    } catch {
      renderBulletin(null);
    }
  }

  function applyHomepageUpdates() {
    if (!document.body.classList.contains('home')) return;

    if (!document.querySelector('link[href="home-layout-updates.css"]')) {
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = 'home-layout-updates.css';
      document.head.appendChild(stylesheet);
    }

    const worshipDays = document.querySelectorAll('#worship-times .worship-day');
    if (worshipDays[1] && worshipDays[1].textContent.trim() === 'Monday') worshipDays[1].textContent = 'Tuesday';

    document.querySelectorAll('#times .service-details p').forEach((paragraph) => {
      Array.from(paragraph.childNodes).forEach((node) => {
        if (node.nodeType !== Node.TEXT_NODE) return;
        const match = node.textContent.trim().match(/^\((.+)\)$/s);
        if (!match) return;
        const context = document.createElement('span');
        context.className = 'schedule-context';
        context.textContent = match[1];
        node.replaceWith(context);
      });
    });

    const giveLink = document.querySelector('.footer-links-section a[href$="giving.html"]');
    const giveIcon = giveLink?.querySelector('img.link-icon');
    if (giveIcon) {
      giveIcon.src = 'Icons/give.png';
      giveIcon.onerror = () => {
        giveIcon.onerror = null;
        giveIcon.src = 'Icons/finances.png';
      };
    }

    const designedBy = document.querySelector('.footer-copyright-row p:first-child');
    if (designedBy) {
      designedBy.textContent = 'Designed by ';
      const link = document.createElement('a');
      link.href = 'https://www.alphazonelabs.com';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '© AlphaZoneLabs';
      designedBy.appendChild(link);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyHomepageUpdates();
    void loadBulletin();
  });
})();
