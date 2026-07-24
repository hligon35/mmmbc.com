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
