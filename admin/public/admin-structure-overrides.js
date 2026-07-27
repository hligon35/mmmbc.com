(() => {
  const HOME_LINK = '<a href="#home" class="pageContext__homeLink" data-section-target="tab-home">Home</a>';

  function fixBreadcrumbs() {
    document.querySelectorAll('.pageContext').forEach((context) => {
      const crumb = context.querySelector('.pageContext__crumb');
      const title = context.querySelector('.pageContext__title');
      if (!crumb || !title) return;

      const label = String(title.textContent || '').trim();
      crumb.innerHTML = label === 'Church Website Manager'
        ? HOME_LINK
        : `${HOME_LINK} &rsaquo; ${label}`;
    });
  }

  function repairPhotoWorkspace() {
    const tab = document.getElementById('tab-photos');
    const panel = document.getElementById('panel-photos-manage');
    const uploadForm = document.getElementById('photoUploadForm');
    const bulkBar = document.getElementById('photoBulkBar');
    if (!tab || !panel || !uploadForm) return;

    // Keep selection actions next to the gallery they control. Older build
    // overrides moved this element into the page heading and broke the layout.
    if (bulkBar && bulkBar.parentElement !== panel) {
      bulkBar.classList.remove('photoBulkBar--pageContext', 'photoBulkBar--header', 'photoBulkBar--nav');
      panel.insertBefore(bulkBar, uploadForm);
    }

    if (!document.getElementById('adminPhotoWorkspaceRepairStyles')) {
      const style = document.createElement('style');
      style.id = 'adminPhotoWorkspaceRepairStyles';
      style.textContent = `
        #tab-photos { min-width: 0; }
        #tab-photos .pageContext--photos {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: center;
          gap: 20px;
        }
        #tab-photos .pageContext__actions--photos {
          display: grid;
          gap: 10px;
          min-width: min(100%, 300px);
        }
        #tab-photos .pageContext__primaryActions {
          display: flex;
          align-items: stretch;
          justify-content: flex-end;
          gap: 10px;
          flex-wrap: wrap;
        }
        #tab-photos .pageContext__primaryActions .iconBtn {
          width: 46px;
          min-width: 46px;
          min-height: 46px;
          display: grid;
          place-items: center;
        }
        #tab-photos .pageContext__primaryActions .btn { min-height: 46px; }
        #tab-photos > .sectionHeader { display: none !important; }

        #panel-photos-manage { min-width: 0; }
        #panel-photos-manage > .muted:first-child { margin: 0 0 18px; }

        #tab-photos #photoBulkBar {
          position: static !important;
          inset: auto !important;
          width: 100% !important;
          margin: 0 0 16px !important;
          padding: 12px !important;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 10px;
          border: 1px solid var(--border);
          border-radius: 12px;
          background: rgba(196, 97, 35, .08);
          box-shadow: none !important;
          backdrop-filter: none !important;
        }
        #tab-photos #photoBulkBar[hidden] { display: none !important; }
        #tab-photos #photoBulkCount { margin-left: auto; }

        #tab-photos #photoUploadForm {
          display: grid !important;
          grid-template-columns: repeat(4, minmax(150px, 1fr)) auto;
          align-items: end;
          gap: 14px;
          width: 100%;
          margin: 0 0 20px;
          overflow: visible;
        }
        #tab-photos #photoUploadForm > .label {
          min-width: 0;
          display: grid;
          grid-template-columns: 1fr;
          align-content: end;
          gap: 7px;
        }
        #tab-photos #photoUploadForm .input {
          width: 100%;
          min-width: 0;
          min-height: 52px;
        }
        #tab-photos #photoUploadForm input[type="file"] {
          height: auto;
          padding: 9px;
        }
        #tab-photos #photoUploadForm > .btn[type="submit"] {
          min-height: 52px;
          min-width: 124px;
          white-space: nowrap;
        }
        #tab-photos #photoUploadHint { grid-column: 1 / -1; }

        #tab-photos #photoToolbar {
          display: grid !important;
          grid-template-columns: repeat(4, minmax(150px, 1fr));
          align-items: end;
          gap: 14px;
          width: 100%;
          margin: 0 0 18px;
          overflow: visible;
        }
        #tab-photos #photoToolbar > .label {
          min-width: 0;
          display: grid;
          grid-template-columns: 1fr;
          gap: 7px;
          align-items: end;
        }
        #tab-photos #photoToolbar .input,
        #tab-photos #photoToolbar .select {
          width: 100%;
          min-width: 0;
          min-height: 52px;
        }

        #tab-photos #photoPager:not([hidden]),
        #tab-photos #photoPagerBottom:not([hidden]) {
          display: grid !important;
          grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
          align-items: center;
          gap: 10px;
          width: 100% !important;
          margin: 18px 0 !important;
        }
        #tab-photos #photoPager button:first-child,
        #tab-photos #photoPagerBottom button:first-child { justify-self: start; }
        #tab-photos #photoPager span,
        #tab-photos #photoPagerBottom span { justify-self: center; white-space: nowrap; }
        #tab-photos #photoPager button:last-child,
        #tab-photos #photoPagerBottom button:last-child { justify-self: end; }

        #tab-photos #photoGrid.grid {
          display: grid !important;
          grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)) !important;
          align-items: stretch;
          gap: 14px !important;
          width: 100%;
          min-width: 0;
        }
        #tab-photos #photoGrid .thumb {
          min-width: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        #tab-photos #photoGrid .thumb__img {
          display: block;
          width: 100%;
          height: 190px;
          object-fit: contain !important;
          object-position: center;
          background: #111;
        }
        #tab-photos #photoGrid .row__actions {
          display: flex !important;
          flex-wrap: wrap;
          justify-content: center;
          align-items: center;
          gap: 8px;
          width: 100%;
          margin-top: auto;
        }
        #tab-photos #photoGrid .row__actions .btn {
          width: auto !important;
          min-width: 68px;
          flex: 0 1 auto;
        }

        #tab-photos #advancedPhotoTools {
          margin-top: 22px;
          overflow: hidden;
        }
        #tab-photos #advancedPhotoTools > summary { padding: 4px 0; }

        @media (max-width: 1180px) {
          #tab-photos #photoUploadForm,
          #tab-photos #photoToolbar {
            grid-template-columns: repeat(2, minmax(220px, 1fr));
          }
          #tab-photos #photoUploadForm > .btn[type="submit"] { width: 100%; }
        }

        @media (max-width: 760px) {
          #tab-photos .pageContext--photos { grid-template-columns: 1fr; }
          #tab-photos .pageContext__actions--photos { min-width: 0; }
          #tab-photos .pageContext__primaryActions { justify-content: flex-start; }
          #tab-photos #photoUploadForm,
          #tab-photos #photoToolbar { grid-template-columns: 1fr; }
          #tab-photos #photoBulkBar { align-items: stretch; }
          #tab-photos #photoBulkBar .btn { flex: 1 1 180px; }
          #tab-photos #photoBulkCount { width: 100%; margin-left: 0; text-align: center; }
          #tab-photos #photoGrid.grid {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
            gap: 10px !important;
          }
          #tab-photos #photoGrid .thumb__img { height: 150px; }
        }

        @media (max-width: 420px) {
          #tab-photos #photoGrid.grid { grid-template-columns: 1fr !important; }
          #tab-photos #photoGrid .thumb__img { height: 210px; }
          #tab-photos #photoPager .btn,
          #tab-photos #photoPagerBottom .btn { padding: 9px 10px; font-size: .9rem; }
        }
      `;
      document.head.appendChild(style);
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

    document.querySelectorAll('[data-section-target="tab-events"]').forEach((el) => {
      el.setAttribute('data-section-target', 'tab-content');
    });

    const pageContext = contentTab.querySelector('.pageContext');
    const title = pageContext?.querySelector('.pageContext__title');
    const description = pageContext?.querySelector('.pageContext__description');
    if (title) title.textContent = 'Announcements & Events';
    if (description) description.textContent = 'Publish church updates, bulletins, service times, meetings, and programs.';

    const split = document.createElement('div');
    split.className = 'contentEventsSplit';

    const announcementPane = document.createElement('section');
    announcementPane.className = 'contentEventsSplit__pane contentEventsSplit__pane--announcements';
    announcementPane.setAttribute('aria-label', 'Announcements and bulletins');

    const eventPane = document.createElement('section');
    eventPane.className = 'contentEventsSplit__pane contentEventsSplit__pane--events';
    eventPane.setAttribute('aria-label', 'Events');

    Array.from(contentTab.children).forEach((child) => {
      if (child === pageContext || child === split) return;
      announcementPane.appendChild(child);
    });

    const eventHeading = document.createElement('div');
    eventHeading.className = 'sectionHeader sectionHeader--compact contentEventsSplit__eventHeader';
    eventHeading.innerHTML = '<div><h2 class="sectionHeader__title">Events</h2><p class="muted">Add, edit, and delete service times, meetings, and church programs.</p></div>';
    eventPane.appendChild(eventHeading);

    Array.from(eventsTab.children).forEach((child) => {
      if (child.classList?.contains('pageContext')) return;
      eventPane.appendChild(child);
    });

    split.appendChild(announcementPane);
    split.appendChild(eventPane);
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
    label.append('Current subscribers');
    label.appendChild(select);
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

    const duplicateHeaderTitle = document.querySelector('#tab-finances .financeHeaderTitleRow .sectionHeader__title');
    if (duplicateHeaderTitle) duplicateHeaderTitle.remove();
  }

  function apply() {
    fixBreadcrumbs();
    repairPhotoWorkspace();
    combineAnnouncementsAndEvents();
    moveSubscriberDropdown();
    moveFinanceActions();
    fixBreadcrumbs();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  } else {
    apply();
  }
})();
