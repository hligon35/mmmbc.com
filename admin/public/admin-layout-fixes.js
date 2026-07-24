(() => {
  function applyGalleryLayoutFixes() {
    const bulkBar = document.getElementById('photoBulkBar');
    const photoHeader = document.querySelector('#tab-photos > .sectionHeader');
    const iconGroup = photoHeader?.querySelector('.iconGroup');

    if (bulkBar && iconGroup && bulkBar.parentElement !== iconGroup && !bulkBar.classList.contains('photoBulkBar--pageContext')) {
      bulkBar.classList.add('photoBulkBar--header');
      iconGroup.appendChild(bulkBar);
    }
  }

  function enforcePhotoPageSize() {
    try {
      photoPageSize = () => 18;
    } catch {
      // The main admin script may not be initialized yet.
    }
  }

  function run() {
    enforcePhotoPageSize();
    applyGalleryLayoutFixes();

    const root = document.getElementById('tab-photos') || document.body;
    const observer = new MutationObserver(() => {
      enforcePhotoPageSize();
      applyGalleryLayoutFixes();
    });
    observer.observe(root, { childList: true, subtree: true });

    try {
      if (typeof applyPhotoFilters === 'function') {
        applyPhotoFilters({ resetPage: true });
      }
    } catch {
      // Gallery data may still be loading; the normal load flow will use 18.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
