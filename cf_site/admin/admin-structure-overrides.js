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
    const actions = document.querySelector('#adminHeader .headerActions');
    if (!button || !actions) return;
    if (button.parentElement !== actions) actions.appendChild(button);
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

      const nextCategories = categories.filter((value) => value.toLowerCase() !== match.toLowerCase());
      const funds = selectableValues(fundSelect);
      if (typeof window.setFinanceHint === 'function') window.setFinanceHint('Deleting category…');

      try {
        await window.api('/api/finances/meta', {
          method: 'PUT',
          body: JSON.stringify({ categories: nextCategories, funds })
        });
        window.location.reload();
      } catch (error) {
        if (typeof window.setFinanceHint === 'function') window.setFinanceHint(String(error?.message || error || 'Unable to delete category.'));
      }
    });
  }

  function repairPhotoWorkspace() {
    const tab = document.getElementById('tab-photos');
    const pageContext = document.getElementById('pageContext-photos');
    const sectionHeader = tab?.querySelector(':scope > .sectionHeader');
    const bulkBar = document.getElementById('photoBulkBar');
    const contextActions = pageContext?.querySelector('.pageContext__actions--photos');
    if (!tab || !sectionHeader) return;

    sectionHeader.hidden = false;
    sectionHeader.classList.add('photoWorkspaceHeader');

    let actions = sectionHeader.querySelector('.photoWorkspaceHeader__actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'photoWorkspaceHeader__actions';
      sectionHeader.appendChild(actions);
    }

    if (contextActions) {
      const primary = contextActions.querySelector('.pageContext__primaryActions');
      if (primary) actions.appendChild(primary);
      contextActions.remove();
    }

    if (bulkBar && bulkBar.parentElement !== actions) {
      bulkBar.classList.remove('photoBulkBar--pageContext', 'photoBulkBar--header', 'photoBulkBar--nav');
      actions.appendChild(bulkBar);
    }
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
    const eventHeading = document.createElement('div');
    eventHeading.className = 'sectionHeader sectionHeader--compact contentEventsSplit__eventHeader';
    eventHeading.innerHTML = '<div><h2 class="sectionHeader__title">Events</h2><p class="muted">Add, edit, and delete service times, meetings, and church programs.</p></div>';
    eventPane.appendChild(eventHeading);
    Array.from(eventsTab.children).forEach((child) => {
      if (!child.classList?.contains('pageContext')) eventPane.appendChild(child);
    });
    split.append(announcementPane, eventPane);
    contentTab.appendChild(split);
    eventsTab.remove();
  }

  function moveSubscriberDropdown() {
    const context = document.getElementById('pageContext-newsletter');
    const select = document.getElementById('subscriberList');
    if (!context || !select || context.querySelector('.newsletterSubscriberContext')) return;
    select.removeAttribute('size');
    select.setAttribute('aria-label', 'Current subscribers');
    const holder = document.createElement('div');
    holder.className = 'newsletterSubscriberContext';
    const label = document.createElement('label');
    label.className = 'label newsletterSubscriberContext__label';
    label.append('Current subscribers', select);
    holder.appendChild(label);
    context.appendChild(holder);
    const oldLabel = document.querySelector('#subscriberPanel .formRow > .label');
    if (oldLabel && !oldLabel.querySelector('select')) oldLabel.remove();
  }

  function moveFinanceActions() {
    const context = document.getElementById('pageContext-finances');
    const title = context?.querySelector('.pageContext__title');
    const dashboard = document.getElementById('financeDashboardBtn');
    const actions = document.querySelector('.financeActionButtons');
    if (!context || !title || context.querySelector('.financePageContextTitleRow')) return;
    const row = document.createElement('div');
    row.className = 'financePageContextTitleRow';
    title.parentNode.insertBefore(row, title);
    row.appendChild(title);
    const controls = document.createElement('div');
    controls.className = 'financePageContextActions noPrint';
    if (dashboard) controls.appendChild(dashboard);
    if (actions) controls.appendChild(actions);
    row.appendChild(controls);
    document.querySelector('#tab-finances .financeHeaderTitleRow .sectionHeader__title')?.remove();
  }

  function injectStyles() {
    if (document.getElementById('adminLayoutRefinementStyles')) return;
    const style = document.createElement('style');
    style.id = 'adminLayoutRefinementStyles';
    style.textContent = `
      .pageContext {
        width: calc(100% - (2 * clamp(12px, 2vw, 30px)));
        margin-left: clamp(12px, 2vw, 30px) !important;
        margin-right: clamp(12px, 2vw, 30px) !important;
      }

      #tab-support > form {
        width: calc(100% - (2 * clamp(12px, 2vw, 30px)));
        margin: 0 clamp(12px, 2vw, 30px);
        padding: 18px;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: var(--panel);
      }

      .headerInviteBtn { display: grid; place-items: center; }

      .editorSplit__preview,
      #siteEditorPreviewPane,
      .previewPane {
        align-self: start !important;
        height: max-content !important;
        min-height: 0 !important;
        max-height: none !important;
      }
      #siteEditorPreviewPane { padding-bottom: 16px !important; }
      .sitePagePreviewFrame { height: clamp(360px, 54vh, 620px) !important; }
      #siteEditorLivePreview { min-height: 0 !important; }

      #tab-photos .pageContext--photos { display: block !important; }
      #tab-photos > .photoWorkspaceHeader {
        display: flex !important;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
        margin: 0 clamp(12px, 2vw, 30px) 18px;
      }
      #tab-photos .photoWorkspaceHeader__actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
        flex-wrap: wrap;
        margin-left: auto;
      }
      #tab-photos .pageContext__primaryActions {
        display: flex;
        align-items: stretch;
        gap: 10px;
      }
      #tab-photos .pageContext__primaryActions .iconBtn {
        width: 46px;
        min-width: 46px;
        min-height: 46px;
        display: grid;
        place-items: center;
      }
      #tab-photos #photoBulkBar {
        position: static !important;
        inset: auto !important;
        width: auto !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #tab-photos #photoBulkBar[hidden] { display: none !important; }
      #tab-photos #photoBulkCount { white-space: nowrap; }

      #tab-photos #photoGrid .thumb__select {
        background: transparent !important;
        border: 0 !important;
        box-shadow: none !important;
        padding: 0 !important;
        width: auto !important;
        height: auto !important;
      }
      #tab-photos #photoGrid .thumb__check {
        margin: 0 !important;
        box-shadow: none !important;
      }

      #tab-photos #photoUploadForm {
        display: grid !important;
        grid-template-columns: repeat(4, minmax(150px, 1fr)) auto;
        align-items: end;
        gap: 14px;
        width: 100%;
        margin-bottom: 20px;
      }
      #tab-photos #photoUploadForm > .label,
      #tab-photos #photoToolbar > .label { min-width: 0; display: grid; gap: 7px; }
      #tab-photos #photoUploadForm .input,
      #tab-photos #photoToolbar .input,
      #tab-photos #photoToolbar .select { width: 100%; min-width: 0; min-height: 52px; }
      #tab-photos #photoUploadForm > .btn[type="submit"] { min-height: 52px; }
      #tab-photos #photoUploadHint { grid-column: 1 / -1; }
      #tab-photos #photoToolbar {
        display: grid !important;
        grid-template-columns: repeat(4, minmax(150px, 1fr));
        gap: 14px;
        width: 100%;
        overflow: visible;
      }
      #tab-photos #photoGrid.grid {
        display: grid !important;
        grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)) !important;
        gap: 14px !important;
      }
      #tab-photos #photoGrid .thumb { min-width: 0; overflow: hidden; display: flex; flex-direction: column; }
      #tab-photos #photoGrid .thumb__img { width: 100%; height: 190px; object-fit: contain !important; background: #111; }
      #tab-photos #photoGrid .row__actions { display: flex !important; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: auto; }

      @media (max-width: 1180px) {
        #tab-photos #photoUploadForm,
        #tab-photos #photoToolbar { grid-template-columns: repeat(2, minmax(220px, 1fr)); }
      }
      @media (max-width: 760px) {
        #tab-photos > .photoWorkspaceHeader { align-items: stretch; }
        #tab-photos .photoWorkspaceHeader__actions { width: 100%; justify-content: flex-start; margin-left: 0; }
        #tab-photos #photoBulkBar { width: 100% !important; flex-wrap: wrap; }
        #tab-photos #photoUploadForm,
        #tab-photos #photoToolbar { grid-template-columns: 1fr; }
        #tab-photos #photoGrid.grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
      }
      @media (max-width: 420px) {
        #tab-photos #photoGrid.grid { grid-template-columns: 1fr !important; }
      }
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
    moveSubscriberDropdown();
    moveFinanceActions();
    fixBreadcrumbs();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
  else apply();
})();
