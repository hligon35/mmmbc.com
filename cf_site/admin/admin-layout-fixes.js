(() => {
  function applyGalleryLayoutFixes() {
    const bulkBar = document.getElementById('photoBulkBar');
    const photoHeader = document.querySelector('#tab-photos > .sectionHeader');
    const iconGroup = photoHeader?.querySelector('.iconGroup');

    if (bulkBar && iconGroup && bulkBar.parentElement !== iconGroup) {
      bulkBar.classList.add('photoBulkBar--header');
      iconGroup.appendChild(bulkBar);
    }
  }

  function run() {
    applyGalleryLayoutFixes();
    const root = document.getElementById('tab-photos') || document.body;
    const observer = new MutationObserver(applyGalleryLayoutFixes);
    observer.observe(root, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
