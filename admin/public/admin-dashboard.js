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

    // null/undefined means unavailable or restricted; only a real number is shown as a count.
    const count = (value) => (Number.isFinite(value) && value !== null ? String(value) : '\u2014');
    const meta = (value, suffix) => (Number.isFinite(value) && value !== null ? `${value} ${suffix}` : 'Unavailable');
    const cards = [
      { label: 'Upcoming Events (14 days)', value: count(summary?.upcomingEvents14d), meta: meta(summary?.todayEvents, 'today') },
      { label: 'Active Announcements', value: count(summary?.activeAnnouncements), meta: meta(summary?.totalAnnouncements, 'total') },
      { label: 'Newsletter Subscribers', value: count(summary?.subscribers), meta: meta(summary?.scheduledNewsletters, 'scheduled') },
      { label: 'Photos in Gallery', value: count(summary?.galleryItems), meta: meta(summary?.galleryAlbums, 'albums') }
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

  function renderNewsletter(newsletter) {
    const root = $('dashboardNewsletterStats');
    if (!root) return;

    if (!newsletter) {
      renderEmpty('dashboardNewsletterStats', 'Newsletter data is unavailable or not permitted for your role.');
      return;
    }

    const stats = [
      { label: 'Drafts', value: Number(newsletter.drafts) || 0 },
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
        level: statusLevel(subsystemStatus?.announcements?.ok !== false)
      },
      {
        title: 'Newsletter Scheduler',
        detail: websiteStatus?.schedulerRunning == null ? 'Status not available' : (websiteStatus.schedulerRunning ? 'Running' : 'Overdue sends detected'),
        level: websiteStatus?.schedulerRunning === false ? 'warning' : 'ok'
      },
      {
        title: 'Gallery Data',
        detail: subsystemStatus?.gallery?.ok === false ? String(subsystemStatus.gallery.error || 'Unavailable') : (subsystemStatus?.gallery?.restricted ? 'Not available for your role' : 'Available'),
        level: statusLevel(subsystemStatus?.gallery?.ok !== false)
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

  const REFRESH_MIN_INTERVAL_MS = 30000;
  let inFlight = null;
  let lastLoadedAt = 0;

  // Concurrent callers share one request; automatic refreshes skip recent data.
  function refreshDashboard({ force = false } = {}) {
    if (!$('dashboardOverviewRoot')) return Promise.resolve();
    if ($('dashboardCard')?.hidden) return Promise.resolve();
    if (inFlight) return inFlight;
    if (!force && Date.now() - lastLoadedAt < REFRESH_MIN_INTERVAL_MS) return Promise.resolve();
    inFlight = loadDashboard().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function loadDashboard() {
    setBusy(true);
    setStatus('Loading dashboard overview...');
    try {
      const data = await getOverview();
      updateGeneratedAt(data.generatedAt);
      renderSummaryCards(data.summary || {});
      renderNeedsAttention(data.needsAttention || []);
      renderUpcomingEvents(data.upcomingEvents || []);
      renderNewsletter(data.newsletter || null);
      renderWebsiteStatus(data.websiteStatus || {}, data.status || {});
      renderRecentActivity(data.recentActivity || []);
      lastLoadedAt = Date.now();
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
    const refreshBtn = $('dashboardRefreshBtn');
    if (refreshBtn && !refreshBtn.dataset.wired) {
      refreshBtn.dataset.wired = '1';
      refreshBtn.addEventListener('click', () => {
        refreshDashboard({ force: true });
      });
    }

    window.addEventListener('admin:home-activated', () => {
      refreshDashboard();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    wire();
  });

  window.AdminDashboard = {
    refresh: refreshDashboard
  };
})();
