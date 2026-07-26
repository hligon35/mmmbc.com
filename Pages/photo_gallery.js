document.addEventListener('DOMContentLoaded', () => {
  const grid = document.getElementById('photoGrid');
  const albumFilter = document.getElementById('albumFilter');
  const sortBy = document.getElementById('sortBy');
  const tagSearch = document.getElementById('tagSearch');
  const prevPage = document.getElementById('prevPage');
  const nextPage = document.getElementById('nextPage');
  const pageInfo = document.getElementById('pageInfo');
  const overlay = document.getElementById('lightboxOverlay');
  const lightboxImage = document.getElementById('lightboxImage');
  const lightboxCaption = document.getElementById('lightboxCaption');
  const closeBtn = document.getElementById('lightboxClose');
  const prevLightbox = document.getElementById('lightboxPrev');
  const nextLightbox = document.getElementById('lightboxNext');

  if (!grid) return;

  const galleryStyle = document.createElement('style');
  galleryStyle.textContent = `
    .photo-grid { align-items: start; }
    .gallery-item {
      aspect-ratio: auto !important;
      min-height: 280px;
      padding: 0;
      background: rgba(255,255,255,.96) !important;
    }
    .gallery-item img {
      width: 100% !important;
      height: 240px !important;
      object-fit: contain !important;
      object-position: center !important;
      background: #111;
      border-radius: 8px 8px 0 0 !important;
    }
    .gallery-label { margin-top: auto; }
    .lightbox-content {
      width: min(94vw, 1400px) !important;
      height: min(92vh, 1000px) !important;
      max-width: 94vw !important;
      max-height: 92vh !important;
      box-sizing: border-box;
      overflow: hidden;
    }
    .lightbox-image-container {
      width: 100% !important;
      height: calc(100% - 64px) !important;
      max-width: none !important;
      max-height: none !important;
      min-height: 0;
      margin: 0 0 10px !important;
    }
    .lightbox-image {
      display: block;
      width: 100% !important;
      height: 100% !important;
      max-width: 100% !important;
      max-height: 100% !important;
      object-fit: contain !important;
      object-position: center !important;
    }
    @media (max-width: 680px) {
      .photo-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
        gap: 10px !important;
      }
      .gallery-item { min-height: 210px; }
      .gallery-item img { height: 165px !important; }
      .gallery-label { padding: 8px 6px !important; font-size: .82rem !important; }
      .lightbox-content { width: 96vw !important; height: 88vh !important; padding: 12px !important; }
    }
  `;
  document.head.appendChild(galleryStyle);

  const pageSize = 20;
  let allItems = [];
  let filteredItems = [];
  let currentPage = 1;
  let lightboxIndex = 0;
  let assetOrigin = window.location.origin;

  const workerOrigin = (() => {
    const meta = document.querySelector('meta[name="mmmbc-worker-origin"]');
    const value = String(meta?.content || '').trim();
    try { return value ? new URL(value).origin : ''; } catch { return ''; }
  })();

  const escapeHtml = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const absoluteAssetUrl = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try { return new URL(raw, assetOrigin).toString(); } catch { return raw; }
  };

  const displayName = (item) => String(item.label || item.originalName || item.album || 'Gallery photo').trim();

  function sortItems(items) {
    const mode = String(sortBy?.value || 'date-desc');
    return [...items].sort((a, b) => {
      if (mode === 'manual') {
        const ap = Number.isFinite(Number(a.position)) ? Number(a.position) : Number.MAX_SAFE_INTEGER;
        const bp = Number.isFinite(Number(b.position)) ? Number(b.position) : Number.MAX_SAFE_INTEGER;
        return ap - bp || displayName(a).localeCompare(displayName(b));
      }
      if (mode === 'date-asc' || mode === 'date-desc') {
        const av = Date.parse(a.createdAt || '') || 0;
        const bv = Date.parse(b.createdAt || '') || 0;
        return mode === 'date-asc' ? av - bv : bv - av;
      }
      const result = displayName(a).localeCompare(displayName(b));
      return mode === 'name-desc' ? -result : result;
    });
  }

  function applyFilters() {
    const album = String(albumFilter?.value || '').trim();
    const query = String(tagSearch?.value || '').trim().toLowerCase();
    filteredItems = sortItems(allItems.filter((item) => {
      if (album && String(item.album || '') !== album) return false;
      if (!query) return true;
      const haystack = [item.album, item.label, item.originalName, ...(Array.isArray(item.tags) ? item.tags : [])]
        .join(' ').toLowerCase();
      return haystack.includes(query);
    }));
    currentPage = 1;
    render();
  }

  function render() {
    const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
    currentPage = Math.min(currentPage, totalPages);
    const start = (currentPage - 1) * pageSize;
    const visible = filteredItems.slice(start, start + pageSize);

    if (!visible.length) {
      grid.innerHTML = '<p class="gallery-empty">No photos are available for this selection.</p>';
    } else {
      grid.innerHTML = visible.map((item, index) => {
        const src = absoluteAssetUrl(item.thumb || item.file);
        const name = displayName(item);
        return `<button class="gallery-item" type="button" data-gallery-index="${start + index}" aria-label="Open ${escapeHtml(name)}">
          <img src="${escapeHtml(src)}" alt="${escapeHtml(name)}" loading="lazy" decoding="async">
          <span class="gallery-label">${escapeHtml(name)}</span>
        </button>`;
      }).join('');
    }

    if (pageInfo) pageInfo.textContent = filteredItems.length ? `Page ${currentPage} of ${totalPages}` : 'Page 0 of 0';
    if (prevPage) prevPage.disabled = currentPage <= 1;
    if (nextPage) nextPage.disabled = currentPage >= totalPages || filteredItems.length === 0;
  }

  function openLightbox(index) {
    const item = filteredItems[index];
    if (!item || !overlay || !lightboxImage) return;
    lightboxIndex = index;
    lightboxImage.src = absoluteAssetUrl(item.file || item.thumb);
    lightboxImage.alt = displayName(item);
    if (lightboxCaption) lightboxCaption.textContent = `${displayName(item)} — Image ${index + 1} of ${filteredItems.length}`;
    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    overlay?.classList.remove('visible');
    document.body.style.overflow = '';
    if (lightboxImage) lightboxImage.src = '';
  }

  function moveLightbox(direction) {
    if (!filteredItems.length) return;
    lightboxIndex = (lightboxIndex + direction + filteredItems.length) % filteredItems.length;
    openLightbox(lightboxIndex);
  }

  async function loadGallery() {
    grid.innerHTML = '<p class="gallery-loading">Loading photos…</p>';
    const endpoints = ['/public/gallery.json'];
    if (workerOrigin && workerOrigin !== window.location.origin) endpoints.push(`${workerOrigin}/public/gallery.json`);

    let lastError = null;
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, { cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Gallery request failed (${response.status})`);
        const data = await response.json();
        if (!Array.isArray(data?.items)) throw new Error('Gallery response did not contain an items array.');
        assetOrigin = new URL(endpoint, window.location.href).origin;
        allItems = data.items.filter((item) => item && (item.file || item.thumb));
        const albums = [...new Set(allItems.map((item) => String(item.album || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        if (albumFilter) {
          albumFilter.innerHTML = '<option value="">All</option>' + albums.map((album) => `<option value="${escapeHtml(album)}">${escapeHtml(album)}</option>`).join('');
        }
        applyFilters();
        return;
      } catch (error) {
        lastError = error;
      }
    }

    console.error('Unable to load gallery', lastError);
    grid.innerHTML = '<p class="gallery-error">The photo gallery could not be loaded. Please refresh the page and try again.</p>';
    if (pageInfo) pageInfo.textContent = 'Page 0 of 0';
    if (prevPage) prevPage.disabled = true;
    if (nextPage) nextPage.disabled = true;
  }

  grid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-gallery-index]');
    if (!button) return;
    openLightbox(Number(button.dataset.galleryIndex));
  });
  albumFilter?.addEventListener('change', applyFilters);
  sortBy?.addEventListener('change', applyFilters);
  tagSearch?.addEventListener('input', applyFilters);
  prevPage?.addEventListener('click', () => { if (currentPage > 1) { currentPage -= 1; render(); } });
  nextPage?.addEventListener('click', () => { if (currentPage * pageSize < filteredItems.length) { currentPage += 1; render(); } });
  closeBtn?.addEventListener('click', closeLightbox);
  prevLightbox?.addEventListener('click', () => moveLightbox(-1));
  nextLightbox?.addEventListener('click', () => moveLightbox(1));
  overlay?.addEventListener('click', (event) => { if (event.target === overlay) closeLightbox(); });
  document.addEventListener('keydown', (event) => {
    if (!overlay?.classList.contains('visible')) return;
    if (event.key === 'Escape') closeLightbox();
    if (event.key === 'ArrowLeft') moveLightbox(-1);
    if (event.key === 'ArrowRight') moveLightbox(1);
  });

  loadGallery();
});
