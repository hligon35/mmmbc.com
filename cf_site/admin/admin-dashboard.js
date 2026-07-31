(function () {
  function $(id) {
    return document.getElementById(id);
  }

  function formatDateTime(value) {
    const raw = String(value || '').trim();
    if (!raw) return 'Unknown';
    const t = Date.parse(raw);
    if (Number.isNaN(t)) return raw;
    try {
      return new Date(t).toLocaleString();
    } catch {
      return new Date(t).toISOString();
    }
  }

  function formatDay(value) {
    const raw = String(value || '').trim();
    if (!raw) return 'No date';
    const t = Date.parse(raw);
    if (Number.isNaN(t)) return raw;
    try {
      return new Date(t).toLocaleDateString();
    } catch {
      return new Date(t).toISOString().slice(0, 10);
    }
  }

  function formatMoneyCents(cents) {
    const value = Number(cents || 0) / 100;
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);
    } catch {
      return `$${value.toFixed(2)}`;
    }
  }

  function setStatus(text) {
    const el = $('dashboardOverviewStatus');
    if (el) el.textContent = String(text || '');
  }

  function renderEmpty(containerId, message, { isError = false } = {}) {
    const root = $(containerId);
    if (!root) return;
    const cls = isError ? 'dashboardEmpty dashboardError' : 'dashboardEmpty';
    root.innerHTML = `<div class="${cls}">${String(message || 'No data available.')}</div>`;
  }

  function renderSummaryCards(summary) {
    const root = $('dashboardSummaryGrid');
    if (!root) return;

    const cards = [
      {
        label: 'Upcoming Events (14 days)',
        value: Number(summary?.upcomingEvents14d || 0),
        meta: `${Number(summary?.todayEvents || 0)} today`
      },
      {
        label: 'Active Announcements',
        value: Number(summary?.activeAnnouncements || 0),
        meta: `${Number(summary?.totalAnnouncements || 0)} total`
      },
      {
        label: 'Newsletter Subscribers',
        value: Number(summary?.subscribers || 0),
        meta: `${Number(summary?.scheduledNewsletters || 0)} scheduled`
      },
      {
        label: 'Photos in Gallery',
        value: Number(summary?.galleryItems || 0),
        meta: `${Number(summary?.galleryAlbums || 0)} albums`
      }
    ];

    root.innerHTML = cards.map((card) => `
      <article class="dashboardSummaryCard">
        <p class="dashboardSummaryCard__label">${card.label}</p>
        <p class="dashboardSummaryCard__value">${card.value}</p>
        <p class="dashboardSummaryCard__meta">${card.meta}</p>
      </article>
    `).join('');
  }

  function renderNeedsAttention(items) {
    const root = $('dashboardNeedsAttentionList');
    if (!root) return;
    if (!Array.isArray(items) || !items.length) {
      renderEmpty('dashboardNeedsAttentionList', 'No urgent items right now.');
      return;
    }

    root.innerHTML = items.slice(0, 8).map((item) => {
      const actionAttrs = item?.action?.sectionTarget
        ? `data-section-target="${String(item.action.sectionTarget)}"${item.action.subTabTarget ? ` data-subtab-target="${String(item.action.subTabTarget)}"` : ''}`
        : '';
      const actionBtn = actionAttrs
        ? `<button class="dashboardLinkBtn" type="button" ${actionAttrs}>${String(item?.action?.label || 'Open')}</button>`
        : '';

      return `
        <article class="dashboardItem">
          <p class="dashboardItem__title">${String(item?.title || 'Attention item')}</p>
          <p class="dashboardItem__meta">${String(item?.detail || '')}</p>
          ${actionBtn}
        </article>
      `;
    }).join('');
  }

  function navigateToSection(sectionTarget, subTabTarget) {
    const section = String(sectionTarget || '').trim();
    if (!section) return;

    const navButton = document.querySelector(`#adminSideNav .tab--nav[aria-controls="${section}"]`);
    if (navButton instanceof HTMLButtonElement) navButton.click();

    const sub = String(subTabTarget || '').trim();
    if (!sub) return;
    const subButton = document.querySelector(`.tab--sub[aria-controls="${sub}"]`);
    if (subButton instanceof HTMLButtonElement) subButton.click();
  }

  function renderUpcomingEvents(items) {
    const root = $('dashboardUpcomingEventsList');
    if (!root) return;
    if (!Array.isArray(items) || !items.length) {
      renderEmpty('dashboardUpcomingEventsList', 'No upcoming events scheduled.');
      return;
    }

    root.innerHTML = items.slice(0, 8).map((eventItem) => {
      const date = formatDay(eventItem?.date);
      const time = String(eventItem?.time || '').trim();
      const meta = time ? `${date} at ${time}` : date;
      return `
        <article class="dashboardItem">
          <p class="dashboardItem__title">${String(eventItem?.title || 'Event')}</p>
          <p class="dashboardItem__meta">${meta}</p>
        </article>
      `;
    }).join('');
  }

  function renderGiving(giving, canView) {
    const card = $('dashboardGivingCard');
    const root = $('dashboardGivingStats');
    if (!root || !card) return;

    if (!canView || !giving) {
      card.hidden = true;
      return;
    }

    card.hidden = false;

    const stats = [
      { label: 'Last 30 Days (Received)', value: formatMoneyCents(giving.last30dIncomeCents) },
      { label: 'Last 30 Days (Spent)', value: formatMoneyCents(giving.last30dExpenseCents) },
      { label: 'Pending Review Entries', value: Number(giving.pendingReviewCount || 0) },
      { label: 'Current Month Entries', value: Number(giving.currentMonthEntries || 0) }
    ];

    root.innerHTML = stats.map((row) => `
      <article class="dashboardStat">
        <p class="dashboardStat__label">${row.label}</p>
        <p class="dashboardStat__value">${row.value}</p>
      </article>
    `).join('');
  }

  function renderNewsletter(newsletter) {
    const root = $('dashboardNewsletterStats');
    if (!root) return;

    if (!newsletter) {
      renderEmpty('dashboardNewsletterStats', 'Newsletter data is unavailable.');
      return;
    }

    const stats = [
      { label: 'Drafts', value: Number(newsletter.drafts || 0) },
      { label: 'Scheduled', value: Number(newsletter.scheduled || 0) },
      { label: 'Sent/History', value: Number(newsletter.history || 0) },
      { label: 'Next Scheduled Send', value: newsletter.nextScheduledAt ? formatDateTime(newsletter.nextScheduledAt) : 'Not scheduled' }
    ];

    root.innerHTML = stats.map((row) => `
      <article class="dashboardStat">
        <p class="dashboardStat__label">${row.label}</p>
        <p class="dashboardStat__value">${row.value}</p>
      </article>
    `).join('');
  }

  function statusLevel(ok) {
    return ok ? 'ok' : 'warning';
  }

  function renderWebsiteStatus(websiteStatus, subsystemStatus) {
    const root = $('dashboardWebsiteStatusList');
    if (!root) return;

    const checks = [
      {
        title: 'Storage Mode',
        detail: String(websiteStatus?.storageMode || 'unknown').replace(/_/g, ' '),
        level: websiteStatus?.degraded ? 'warning' : 'ok'
      },
      {
        title: 'Announcements Storage',
        detail: String(websiteStatus?.announcementsStorage || 'unknown'),
        level: statusLevel(Boolean(subsystemStatus?.announcements?.ok))
      },
      {
        title: 'Newsletter Scheduler',
        detail: websiteStatus?.schedulerRunning ? 'Running' : 'Not running',
        level: websiteStatus?.schedulerRunning ? 'ok' : 'warning'
      },
      {
        title: 'Gallery Data',
        detail: statusLevel(Boolean(subsystemStatus?.gallery?.ok)) === 'ok' ? 'Available' : String(subsystemStatus?.gallery?.error || 'Unavailable'),
        level: statusLevel(Boolean(subsystemStatus?.gallery?.ok))
      }
    ];

    root.innerHTML = checks.map((check) => `
      <article class="dashboardItem">
        <p class="dashboardItem__title">${check.title}</p>
        <p class="dashboardItem__meta">${check.detail}</p>
        <span class="dashboardItem__status" data-level="${check.level}">${check.level === 'ok' ? 'Healthy' : 'Needs review'}</span>
      </article>
    `).join('');
  }

  function renderRecentActivity(items) {
    const root = $('dashboardRecentActivityList');
    if (!root) return;

    if (!Array.isArray(items) || !items.length) {
      renderEmpty('dashboardRecentActivityList', 'No recent activity available yet.');
      return;
    }

    root.innerHTML = items.slice(0, 10).map((item) => {
      return `
        <article class="dashboardItem">
          <p class="dashboardItem__title">${String(item?.title || 'Activity')}</p>
          <p class="dashboardItem__meta">${String(item?.detail || '')}</p>
        </article>
      `;
    }).join('');
  }

  function updateGeneratedAt(value) {
    const el = $('dashboardGeneratedAt');
    if (!el) return;
    el.textContent = `Last updated: ${formatDateTime(value)}`;
  }

  async function getOverview() {
    const response = await fetch('/api/dashboard/overview', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const message = String(payload?.error || `Dashboard request failed (${response.status}).`);
      throw new Error(message);
    }

    return payload || {};
  }

  function setBusy(isBusy) {
    const root = $('dashboardOverviewRoot');
    if (!root) return;
    root.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  }

  async function refreshDashboard() {
    if (!$('dashboardOverviewRoot')) return;

    setBusy(true);
    setStatus('Loading dashboard overview...');
    try {
      const data = await getOverview();
      updateGeneratedAt(data.generatedAt);
      renderSummaryCards(data.summary || {});
      renderNeedsAttention(data.needsAttention || []);
      renderUpcomingEvents(data.upcomingEvents || []);
      renderGiving(data.giving || null, Boolean(data?.permissions?.canViewFinance));
      renderNewsletter(data.newsletter || null);
      renderWebsiteStatus(data.websiteStatus || {}, data.status || {});
      renderRecentActivity(data.recentActivity || []);
      setStatus('Dashboard updated.');
    } catch (error) {
      renderEmpty('dashboardSummaryGrid', 'Unable to load dashboard metrics.', { isError: true });
      renderEmpty('dashboardNeedsAttentionList', 'Unable to load attention items.', { isError: true });
      renderEmpty('dashboardUpcomingEventsList', 'Unable to load upcoming events.', { isError: true });
      renderEmpty('dashboardNewsletterStats', 'Unable to load newsletter overview.', { isError: true });
      renderEmpty('dashboardWebsiteStatusList', 'Unable to load website status.', { isError: true });
      renderEmpty('dashboardRecentActivityList', 'Unable to load recent activity.', { isError: true });
      setStatus(String(error?.message || 'Dashboard load failed.'));
    } finally {
      setBusy(false);
    }
  }

  function wire() {
    const root = $('dashboardOverviewRoot');
    if (root && !root.dataset.actionWired) {
      root.dataset.actionWired = '1';
      root.addEventListener('click', (event) => {
        const target = event.target instanceof Element
          ? event.target.closest('[data-section-target]')
          : null;
        if (!(target instanceof HTMLElement)) return;
        const section = String(target.getAttribute('data-section-target') || '').trim();
        const subTab = String(target.getAttribute('data-subtab-target') || '').trim();
        if (!section) return;
        event.preventDefault();
        navigateToSection(section, subTab);
      });
    }

    const refreshBtn = $('dashboardRefreshBtn');
    if (refreshBtn && !refreshBtn.dataset.wired) {
      refreshBtn.dataset.wired = '1';
      refreshBtn.addEventListener('click', () => {
        refreshDashboard();
      });
    }

    window.addEventListener('admin:home-activated', () => {
      refreshDashboard();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    wire();
    refreshDashboard();
  });

  window.AdminDashboard = {
    refresh: refreshDashboard
  };
})();
