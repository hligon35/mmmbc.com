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

  const topPager = document.createElement('div');
  topPager.className = 'pagination pagination--top';
  topPager.setAttribute('aria-label', 'Gallery pagination, top');
  topPager.innerHTML = `
    <button id="prevPageTop" type="button" disabled>Previous</button>
    <span id="pageInfoTop" aria-live="polite">Page 0 of 0</span>
    <button id="nextPageTop" type="button" disabled>Next</button>
  `;
  grid.parentNode.insertBefore(topPager, grid);

  const prevPageTop = document.getElementById('prevPageTop');
  const nextPageTop = document.getElementById('nextPageTop');
  const pageInfoTop = document.getElementById('pageInfoTop');

  const galleryStyle = document.createElement('style');
  galleryStyle.textContent = `
    .photo-grid { align-items: start; }
    .gallery-item {
      position: relative;
      aspect-ratio: 3 / 4 !important;
      min-height: 0 !important;
      height: auto !important;
      padding: 0;
      overflow: hidden !important;
      background: #101010 !important;
    }
    .gallery-item img {
      display: block !important;
      width: 100% !important;
      height: 100% !important;
      max-width: 100% !important;
      max-height: none !important;
      object-fit: contain !important;
      object-position: center !important;
      transform: none !important;
      scale: 1 !important;
      clip-path: none !important;
      background: #111;
      border-radius: 8px !important;
    }
    .gallery-label {
      margin-top: 0;
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 2;
    }
    .pagination {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      flex-wrap: wrap;
      width: 100%;
      gap: 12px;
      box-sizing: border-box;
      text-align: center;
    }
    .pagination--top { margin: 10px auto 22px !important; }
    .pagination #prevPage,
    .pagination #pageInfo,
    .pagination #nextPage,
    .pagination #prevPageTop,
    .pagination #pageInfoTop,
    .pagination #nextPageTop {
      justify-self: auto !important;
      margin: 0 !important;
    }
    .pagination #pageInfo,
    .pagination #pageInfoTop {
      min-width: 150px;
      white-space: nowrap;
      text-align: center;
    }
    .lightbox-content {
      width: min(96vw, 1600px) !important;
      height: auto !important;
      max-width: 96vw !important;
      max-height: 94vh !important;
      box-sizing: border-box;
      overflow: auto !important;
    }
    .lightbox-image-container {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 100% !important;
      height: auto !important;
      max-width: 100% !important;
      max-height: calc(94vh - 100px) !important;
      min-height: 0;
      overflow: auto !important;
      margin: 0 0 10px !important;
    }
    .lightbox-image {
      display: block !important;
      width: auto !important;
      height: auto !important;
      max-width: 100% !important;
      max-height: calc(94vh - 120px) !important;
      object-fit: contain !important;
      object-position: center !important;
      transform: none !important;
      scale: 1 !important;
      clip-path: none !important;
    }
    @media (max-width: 680px) {
      .photo-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 10px !important; }
      .gallery-item { min-height: 0 !important; }
      .gallery-item img { height: 100% !important; max-height: none !important; }
      .gallery-label { padding: 8px 6px !important; font-size: .82rem !important; }
      .pagination { gap: 6px; }
      .pagination button { margin: 0 !important; padding: 8px 10px !important; font-size: .88rem !important; }
      .pagination #pageInfo,
      .pagination #pageInfoTop { min-width: 120px; padding-left: 4px !important; padding-right: 4px !important; font-size: .88rem !important; }
      .lightbox-content { width: 96vw !important; max-height: 92vh !important; padding: 12px !important; }
      .lightbox-image { max-height: calc(92vh - 110px) !important; }
    }
  `;
  document.head.appendChild(galleryStyle);

  const pageSize = 20;
  let allItems = [];
  let filteredItems = [];
  let currentPage = 1;
  let lightboxIndex = 0;
  let assetOrigin = window.location.origin;
  let showImageNames = true;

  const workerOrigin = (() => {
    const value = String(document.querySelector('meta[name="mmmbc-worker-origin"]')?.content || '').trim();
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

  const displayName = (item) => {
    if (!showImageNames) return '';
    const label = String(item?.label || '').trim();
    if (label) return label;
    return String(item?.originalName || item?.album || 'Gallery photo').trim();
  };

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

  function updatePagers(totalPages) {
    const label = filteredItems.length ? `Page ${currentPage} of ${totalPages}` : 'Page 0 of 0';
    [pageInfo, pageInfoTop].forEach((node) => { if (node) node.textContent = label; });
    [prevPage, prevPageTop].forEach((button) => { if (button) button.disabled = currentPage <= 1; });
    [nextPage, nextPageTop].forEach((button) => {
      if (button) button.disabled = currentPage >= totalPages || filteredItems.length === 0;
    });
  }

  function applyFilters() {
    const album = String(albumFilter?.value || '').trim();
    const query = String(tagSearch?.value || '').trim().toLowerCase();
    filteredItems = sortItems(allItems.filter((item) => {
      if (album && String(item.album || '') !== album) return false;
      if (!query) return true;
      return [item.album, item.label, item.originalName, ...(Array.isArray(item.tags) ? item.tags : [])]
        .join(' ').toLowerCase().includes(query);
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
        const src = absoluteAssetUrl(item.file || item.thumb);
        const name = displayName(item);
        const safeName = name || 'Gallery photo';
        const labelMarkup = name ? `<span class="gallery-label">${escapeHtml(name)}</span>` : '';
        return `<button class="gallery-item" type="button" data-gallery-index="${start + index}" aria-label="Open ${escapeHtml(safeName)}">
          <img src="${escapeHtml(src)}" alt="${escapeHtml(safeName)}" loading="lazy" decoding="async">
          ${labelMarkup}
        </button>`;
      }).join('');
    }
    updatePagers(totalPages);
  }

  function changePage(direction) {
    const next = currentPage + direction;
    const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
    if (next < 1 || next > totalPages) return;
    currentPage = next;
    render();
    topPager.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openLightbox(index) {
    const item = filteredItems[index];
    if (!item || !overlay || !lightboxImage) return;
    lightboxIndex = index;
    const name = displayName(item) || 'Gallery photo';
    lightboxImage.removeAttribute('width');
    lightboxImage.removeAttribute('height');
    lightboxImage.style.width = 'auto';
    lightboxImage.style.height = 'auto';
    lightboxImage.src = absoluteAssetUrl(item.file || item.thumb);
    lightboxImage.alt = name;
    if (lightboxCaption) {
      lightboxCaption.textContent = displayName(item)
        ? `${name} — Image ${index + 1} of ${filteredItems.length}`
        : `Image ${index + 1} of ${filteredItems.length}`;
    }
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
    const endpoints = ['/api/public/gallery', '/public/gallery.json'];
    if (workerOrigin && workerOrigin !== window.location.origin) endpoints.push(`${workerOrigin}/public/gallery.json`);
    let lastError = null;

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, { cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Gallery request failed (${response.status})`);
        const data = await response.json();
        if (!Array.isArray(data?.items)) throw new Error('Gallery response did not contain an items array.');
        showImageNames = data?.settings?.showImageNames !== false;
        assetOrigin = new URL(endpoint, window.location.href).origin;
        allItems = data.items.filter((item) => item && (item.file || item.thumb));
        const albums = [...new Set(allItems.map((item) => String(item.album || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        if (albumFilter) albumFilter.innerHTML = '<option value="">All</option>' + albums.map((album) => `<option value="${escapeHtml(album)}">${escapeHtml(album)}</option>`).join('');
        applyFilters();
        return;
      } catch (error) {
        lastError = error;
      }
    }

    console.error('Unable to load gallery', lastError);
    grid.innerHTML = '<p class="gallery-error">The photo gallery could not be loaded. Please refresh the page and try again.</p>';
    filteredItems = [];
    updatePagers(1);
  }

  grid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-gallery-index]');
    if (button) openLightbox(Number(button.dataset.galleryIndex));
  });
  albumFilter?.addEventListener('change', applyFilters);
  sortBy?.addEventListener('change', applyFilters);
  tagSearch?.addEventListener('input', applyFilters);
  prevPage?.addEventListener('click', () => changePage(-1));
  prevPageTop?.addEventListener('click', () => changePage(-1));
  nextPage?.addEventListener('click', () => changePage(1));
  nextPageTop?.addEventListener('click', () => changePage(1));
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
