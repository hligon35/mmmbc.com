(() => {
  const HOME_LINK = '<a href="#home" class="pageContext__homeLink" data-section-target="tab-home">Home</a>';
  const FIN_DELETE_VALUE = '__DELETE__';

  function fixBreadcrumbs() {
    document.querySelectorAll('.pageContext').forEach((context) => {
      const crumb = context.querySelector('.pageContext__crumb');
      const title = context.querySelector('.pageContext__title');
      if (!crumb || !title) return;
      const label = String(title.textContent || '').trim();
      crumb.innerHTML = label === 'Church Website Manager' ? HOME_LINK : `${HOME_LINK} &rsaquo; ${label}`;
    });
  }

  function restoreInviteButton() {
    const button = document.getElementById('inviteAdminBtn');
    const inviteSlot = document.getElementById('adminHeaderInvite');
    if (!button || !inviteSlot) return;
    if (button.parentElement !== inviteSlot) inviteSlot.appendChild(button);
  }

  function selectableValues(select) {
    if (!(select instanceof HTMLSelectElement)) return [];
    return Array.from(select.options)
      .map((option) => String(option.value || '').trim())
      .filter((value) => value && value !== '__CREATE__' && value !== FIN_DELETE_VALUE);
  }

  function addFinanceCategoryDelete() {
    const select = document.getElementById('financeCategory');
    const fundSelect = document.getElementById('financeFund');
    if (!(select instanceof HTMLSelectElement) || select.dataset.deleteCategoryBound === '1') return;
    select.dataset.deleteCategoryBound = '1';

    const ensureDeleteOption = () => {
      if (Array.from(select.options).some((option) => option.value === FIN_DELETE_VALUE)) return;
      const createOption = Array.from(select.options).find((option) => option.value === '__CREATE__');
      const option = document.createElement('option');
      option.value = FIN_DELETE_VALUE;
      option.textContent = 'Delete a category…';
      if (createOption) createOption.insertAdjacentElement('afterend', option);
      else select.appendChild(option);
    };

    new MutationObserver(ensureDeleteOption).observe(select, { childList: true });
    ensureDeleteOption();

    select.addEventListener('change', async () => {
      if (select.value !== FIN_DELETE_VALUE) return;
      select.value = '';
      const categories = selectableValues(select);
      if (!categories.length) {
        if (typeof window.setFinanceHint === 'function') window.setFinanceHint('There are no categories to delete.');
        return;
      }

      const typed = window.prompt(`Type the category name to delete:\n\n${categories.join('\n')}`);
      const target = String(typed || '').trim();
      if (!target) return;
      const match = categories.find((value) => value.toLowerCase() === target.toLowerCase());
      if (!match) {
        if (typeof window.setFinanceHint === 'function') window.setFinanceHint('Category not found.');
        return;
      }

      const warning = `Delete “${match}” from the category list?\n\nExisting ledger entries will keep their saved category text, but this category will no longer appear as a selectable option.`;
      if (!window.confirm(warning)) return;

      try {
        await window.api('/api/finances/meta', {
          method: 'PUT',
          body: JSON.stringify({
            categories: categories.filter((value) => value.toLowerCase() !== match.toLowerCase()),
            funds: selectableValues(fundSelect)
          })
        });
        window.location.reload();
      } catch (error) {
        if (typeof window.setFinanceHint === 'function') window.setFinanceHint(String(error?.message || error || 'Unable to delete category.'));
      }
    });
  }

  function useOriginalGalleryImages() {
    const grid = document.getElementById('photoGrid');
    if (!grid) return;
    const repair = () => {
      grid.querySelectorAll('.thumb').forEach((card) => {
        const image = card.querySelector('.thumb__img');
        const view = Array.from(card.querySelectorAll('a[href]')).find((link) => String(link.textContent || '').trim().toLowerCase() === 'view');
        const original = String(view?.href || '').trim();
        if (!image || !original || image.dataset.originalSource === original) return;
        image.dataset.originalSource = original;
        image.src = original;
      });
    };
    repair();
    if (grid.dataset.originalImageObserverBound !== '1') {
      grid.dataset.originalImageObserverBound = '1';
      new MutationObserver(repair).observe(grid, { childList: true, subtree: true });
    }
  }

  function repairPhotoWorkspace() {
    const tab = document.getElementById('tab-photos');
    const pageContext = document.getElementById('pageContext-photos');
    const sectionHeader = tab?.querySelector(':scope > .sectionHeader');
    const panel = document.getElementById('panel-photos-manage');
    const uploadForm = document.getElementById('photoUploadForm');
    const bulkBar = document.getElementById('photoBulkBar');
    const helpButton = document.getElementById('photoHelpBtn');
    const refreshButton = document.getElementById('exportBtn');
    const syncProgress = document.getElementById('syncProgressWrap');
    const title = pageContext?.querySelector('.pageContext__title');
    if (!tab || !pageContext || !sectionHeader || !panel || !uploadForm || !title) return;

    restoreInviteButton();

    const submitRow = uploadForm.querySelector('.photoUploadSubmitRow');
    const submitButton = submitRow?.querySelector('button[type="submit"]') || uploadForm.querySelector('button[type="submit"]');
    const accepted = submitRow?.querySelector('.photoUploadAccepted') || uploadForm.querySelector('.photoUploadAccepted');

    let titleRow = pageContext.querySelector('.photoPageContextTitleRow');
    if (!titleRow) {
      titleRow = document.createElement('div');
      titleRow.className = 'photoPageContextTitleRow';
      title.parentNode.insertBefore(titleRow, title);
      titleRow.appendChild(title);
    }
    if (submitButton) {
      submitButton.classList.add('photoPageContextAddBtn');
      titleRow.appendChild(submitButton);
    }

    let contextActions = pageContext.querySelector('.photoPageContextActions');
    if (!contextActions) {
      contextActions = document.createElement('div');
      contextActions.className = 'photoPageContextActions noPrint';
      pageContext.appendChild(contextActions);
    }

    let acceptedContainer = submitRow?.querySelector('.photoUploadAcceptedContainer') || contextActions.querySelector('.photoUploadAcceptedContainer');
    if (accepted && !acceptedContainer) {
      acceptedContainer = document.createElement('div');
      acceptedContainer.className = 'photoUploadAcceptedContainer';
      acceptedContainer.appendChild(accepted);
    }
    if (acceptedContainer) contextActions.appendChild(acceptedContainer);

    if (helpButton) {
      helpButton.classList.add('photoHelpIconBtn');
      helpButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"></circle><path d="M9.7 9a2.5 2.5 0 0 1 4.85.85c0 1.85-2.55 2.05-2.55 3.65"></path><path d="M12 17h.01"></path></svg>';
      contextActions.appendChild(helpButton);
    }
    if (refreshButton) contextActions.appendChild(refreshButton);
    if (syncProgress) contextActions.appendChild(syncProgress);

    sectionHeader.classList.add('photoWorkspaceHeader');
    sectionHeader.querySelector('.sectionHeader__left')?.remove();
    sectionHeader.querySelector('.iconGroup')?.remove();

    let bulkActions = sectionHeader.querySelector('.photoWorkspaceHeader__actions');
    if (!bulkActions) {
      bulkActions = document.createElement('div');
      bulkActions.className = 'photoWorkspaceHeader__actions';
      sectionHeader.appendChild(bulkActions);
    }
    if (bulkBar && bulkBar.parentElement !== bulkActions) {
      bulkBar.classList.remove('photoBulkBar--pageContext', 'photoBulkBar--header', 'photoBulkBar--nav');
      bulkActions.appendChild(bulkBar);
    }

    const syncBulkHeader = () => { sectionHeader.hidden = !bulkBar || bulkBar.hidden; };
    syncBulkHeader();
    if (bulkBar && bulkBar.dataset.headerObserverBound !== '1') {
      bulkBar.dataset.headerObserverBound = '1';
      new MutationObserver(syncBulkHeader).observe(bulkBar, { attributes: true, attributeFilter: ['hidden'] });
    }

    if (submitRow) {
      submitRow.classList.add('photoUploadActions');
      if (!submitRow.children.length) submitRow.remove();
      else uploadForm.appendChild(submitRow);
    }

    panel.setAttribute('aria-label', 'Manage photos');
    useOriginalGalleryImages();
  }

  function combineAnnouncementsAndEvents() {
    const contentTab = document.getElementById('tab-content');
    const eventsTab = document.getElementById('tab-events');
    if (!contentTab || !eventsTab || contentTab.querySelector('.contentEventsSplit')) return;
    const navContent = document.getElementById('tabBtn-content');
    const navEvents = document.getElementById('tabBtn-events');
    if (navContent) navContent.textContent = 'Announcements & Events';
    if (navEvents) navEvents.remove();
    document.querySelectorAll('[data-section-target="tab-events"]').forEach((el) => el.setAttribute('data-section-target', 'tab-content'));

    const pageContext = contentTab.querySelector('.pageContext');
    const title = pageContext?.querySelector('.pageContext__title');
    const description = pageContext?.querySelector('.pageContext__description');
    if (title) title.textContent = 'Announcements & Events';
    if (description) description.textContent = 'Publish church updates, bulletins, service times, meetings, and programs.';

    const split = document.createElement('div');
    split.className = 'contentEventsSplit';
    const announcementPane = document.createElement('section');
    announcementPane.className = 'contentEventsSplit__pane contentEventsSplit__pane--announcements';
    const eventPane = document.createElement('section');
    eventPane.className = 'contentEventsSplit__pane contentEventsSplit__pane--events';
    Array.from(contentTab.children).forEach((child) => {
      if (child !== pageContext && child !== split) announcementPane.appendChild(child);
    });
    Array.from(eventsTab.children).forEach((child) => {
      if (!child.classList?.contains('pageContext')) eventPane.appendChild(child);
    });
    const eventDescription = eventPane.querySelector('p.muted');
    if (eventDescription) {
      eventDescription.textContent = 'Add, edit, and delete service times, meetings, and church programs.';
    }
    split.append(announcementPane, eventPane);
    contentTab.appendChild(split);
    eventsTab.remove();
  }

  function injectStyles() {
    if (document.getElementById('adminLayoutRefinementStyles')) return;
    const style = document.createElement('style');
    style.id = 'adminLayoutRefinementStyles';
    style.textContent = `
      .pageContext { width: calc(100% - (2 * clamp(12px, 2vw, 30px))); margin-left: clamp(12px, 2vw, 30px) !important; margin-right: clamp(12px, 2vw, 30px) !important; }
      #tab-support > form { width: calc(100% - (2 * clamp(12px, 2vw, 30px))); margin: 0 clamp(12px, 2vw, 30px); padding: 18px; border: 1px solid var(--border); border-radius: 16px; background: var(--panel); }

      #tab-photos #pageContext-photos { display: grid !important; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 18px; }
      #tab-photos #pageContext-photos > .pageContext__crumb,
      #tab-photos #pageContext-photos > .photoPageContextTitleRow,
      #tab-photos #pageContext-photos > .pageContext__description { grid-column: 1; }
      #tab-photos .photoPageContextTitleRow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      #tab-photos .photoPageContextTitleRow .pageContext__title { margin: 0; }
      #tab-photos .photoPageContextAddBtn { min-height: 42px; white-space: nowrap; }
      #tab-photos .photoPageContextActions { grid-column: 2; grid-row: 1 / span 3; display: flex; align-items: center; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
      #tab-photos .photoPageContextActions .syncProgress { flex-basis: 100%; }
      #tab-photos .photoHelpIconBtn { display: inline-grid !important; place-items: center; width: 46px; min-width: 46px; height: 46px; padding: 0 !important; }
      #tab-photos .photoHelpIconBtn svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      #tab-photos > .photoWorkspaceHeader { align-items: center; justify-content: flex-end; min-height: 0; margin: 0 clamp(12px, 2vw, 30px) 14px; padding: 0; border: 0; }
      #tab-photos > .photoWorkspaceHeader[hidden] { display: none !important; }
      #tab-photos .photoWorkspaceHeader__actions { display: flex; justify-content: flex-end; width: 100%; }
      #tab-photos #photoBulkBar { position: static !important; inset: auto !important; width: auto !important; margin: 0 !important; padding: 0 !important; border: 0 !important; background: transparent !important; box-shadow: none !important; display: flex; align-items: center; gap: 8px; }
      #tab-photos #photoBulkBar[hidden] { display: none !important; }
      #tab-photos #photoBulkCount { white-space: nowrap; }
      #tab-photos #photoUploadForm { display: grid !important; grid-template-columns: repeat(4, minmax(150px, 1fr)); align-items: end; gap: 14px; width: 100%; margin-bottom: 20px; }
      #tab-photos #photoUploadForm > .label, #tab-photos #photoToolbar > .label { min-width: 0; display: grid; gap: 7px; }
      #tab-photos #photoToolbar > .photoSettingToggle { display: inline-grid !important; grid-template-columns: auto minmax(0, 1fr); align-items: center !important; gap: 10px; width: fit-content; }
      #tab-photos #photoToolbar > .photoSettingToggle #photoShowImageNames { margin: 0; }
      #tab-photos #photoToolbar > .photoSettingToggle .photoSettingToggle__label { line-height: 1.3; }
      #tab-photos #photoUploadForm .input, #tab-photos #photoToolbar .input, #tab-photos #photoToolbar .select { width: 100%; min-width: 0; min-height: 52px; }
      #tab-photos .photoUploadActions { grid-column: 1 / -1; display: flex !important; align-items: center; justify-content: flex-end; gap: 12px; width: 100%; }
      #tab-photos .photoUploadAcceptedContainer { display: flex; align-items: center; min-height: 46px; max-width: min(520px, 42vw); padding: 8px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); }
      #tab-photos .photoUploadAccepted { margin: 0; }
      #tab-photos #photoUploadHint { grid-column: 1 / -1; }
      #tab-photos #photoToolbar { display: grid !important; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 14px; width: 100%; overflow: visible; }
      #tab-photos #photoPager:not([hidden]), #tab-photos #photoPagerBottom:not([hidden]) { display: flex !important; align-items: center; justify-content: center; gap: 12px; width: 100%; margin: 18px auto !important; }
      #tab-photos #photoPageInfo, #tab-photos #photoPageInfoBottom { min-width: 180px; text-align: center; }
      #tab-photos #photoGrid.grid { display: grid !important; grid-template-columns: repeat(6, minmax(0, 1fr)) !important; gap: 12px !important; }
      #tab-photos #photoGrid .thumb { min-width: 0; overflow: hidden !important; display: flex; flex-direction: column; }
      #tab-photos #photoGrid .thumb__img { display: block !important; width: 100% !important; height: 160px !important; max-width: 100% !important; object-fit: contain !important; object-position: center center !important; background: #111; }
      #tab-photos #photoGrid .row__actions { display: flex !important; flex-wrap: wrap; justify-content: center; gap: 6px; margin-top: auto; }
      #tab-photos #photoGrid .thumb__select { background: transparent !important; border: 0 !important; box-shadow: none !important; padding: 0 !important; width: auto !important; height: auto !important; }
      #tab-photos #photoGrid .thumb__check { margin: 0 !important; box-shadow: none !important; }

      @media (max-width: 1380px) { #tab-photos #photoGrid.grid { grid-template-columns: repeat(4, minmax(0, 1fr)) !important; } }
      @media (max-width: 1080px) {
        #tab-photos #photoUploadForm, #tab-photos #photoToolbar { grid-template-columns: repeat(2, minmax(220px, 1fr)); }
        #tab-photos #photoGrid.grid { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
      }
      @media (max-width: 760px) {
        #tab-photos #pageContext-photos { grid-template-columns: 1fr; row-gap: 12px; }
        #tab-photos .photoPageContextActions { grid-column: 1; grid-row: auto; justify-content: flex-start; }
        #tab-photos .photoUploadAcceptedContainer { max-width: 100%; }
        #tab-photos #photoUploadForm, #tab-photos #photoToolbar { grid-template-columns: 1fr; }
        #tab-photos #photoToolbar > .photoSettingToggle { width: 100%; }
        #tab-photos #photoGrid.grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
      }
      @media (max-width: 420px) { #tab-photos #photoGrid.grid { grid-template-columns: 1fr !important; } }
    `;
    document.head.appendChild(style);
  }

  function apply() {
    injectStyles();
    fixBreadcrumbs();
    restoreInviteButton();
    addFinanceCategoryDelete();
    repairPhotoWorkspace();
    combineAnnouncementsAndEvents();
    fixBreadcrumbs();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
  else apply();
})();
