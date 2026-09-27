// Schedule application JavaScript
document.addEventListener('DOMContentLoaded', async () => {
    // MODAL ELEMENTS
    const scheduleAppModal = document.getElementById('schedule-app-modal');
    const closeModalButton = document.querySelector('.close-modal-button');

    // MODAL CONTROL ELEMENTS
    const loadScheduleButtonModal = document.getElementById('load-schedule-button-modal');
    const scheduleFileInputModal = document.getElementById('schedule-file-input-modal');
    const eventNameInputModal = document.getElementById('event-name-input-modal');
    const eventDateInputModal = document.getElementById('event-date-input-modal');
    const eventTimeInputModal = document.getElementById('event-time-input-modal');
    const addEventButtonModal = document.getElementById('add-event-button-modal');
    const scheduleAppPreviewDisplay = document.getElementById('schedule-app-preview-display');
    const updateLivePageButton = document.getElementById('update-live-page-button');

    // LIVE PAGE DISPLAY ELEMENT
    const liveScheduleDisplay = document.getElementById('schedule-display');
    const currentMonthSpan = document.getElementById('current-month');

    let managedEvents = []; // Events in the modal manager
    let liveEvents = [];    // Events on the live page

    function normalizeTimeValue(value) {
        const t = String(value || '').trim();
        if (!t) return '';
        const m = t.match(/^([0-2]\d):([0-5]\d)/);
        return m ? `${m[1]}:${m[2]}` : '';
    }

    function isUpcomingOrToday(ev, now) {
        // If no time is provided, treat it as an all-day event that lasts until end-of-day.
        const endTime = ev.time ? ev.time : '23:59';
        const dt = new Date(`${ev.date}T${endTime}`);
        if (Number.isNaN(dt.getTime())) return false;
        return dt.getTime() >= now.getTime();
    }

    function normalizeAndSortEvents(events) {
        const now = new Date();
        return (events || [])
            .filter((ev) => ev && ev.title && ev.date)
            .map((ev) => ({
                title: String(ev.title).trim(),
                date: String(ev.date).trim(),
                time: normalizeTimeValue(ev.time),
            }))
            .filter((ev) => isUpcomingOrToday(ev, now))
            .sort((a, b) => new Date(`${a.date}T${a.time || '00:00'}`) - new Date(`${b.date}T${b.time || '00:00'}`));
    }

    // MODAL VISIBILITY
    if (closeModalButton) {
        closeModalButton.addEventListener('click', () => scheduleAppModal.style.display = 'none');
    }
    window.addEventListener('click', (event) => {
        if (event.target === scheduleAppModal) scheduleAppModal.style.display = 'none';
    });

    // RENDER FUNCTIONS
    function renderEvents(displayElement, eventsArray, isManaged) {
        displayElement.innerHTML = '';
        if (eventsArray.length === 0) {
            displayElement.innerHTML = `<p>No events ${isManaged ? 'in manager. Add or load events.' : 'scheduled.'}</p>`;
            return;
        }
        eventsArray.forEach((event, index) => {
            const eventItem = createEventDOMItem(event, index, isManaged);
            displayElement.appendChild(eventItem);
        });
    }

    function createEventDOMItem(event, index, isManaged) {
        const eventItem = document.createElement('div');
        eventItem.classList.add('event-item');
        if (event.date) eventItem.dataset.eventDate = event.date;

        const title = document.createElement('strong');
        title.textContent = event.title;

        const dateTime = document.createElement('p');
        const formattedDate = event.date ? new Date(event.date + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : 'Date TBD';
        dateTime.textContent = `Date: ${formattedDate}, Time: ${event.time || 'N/A'}`;

        eventItem.appendChild(title);
        eventItem.appendChild(dateTime);

        if (isManaged) {
            const deleteButton = document.createElement('button');
            deleteButton.classList.add('btn-delete-event');
            deleteButton.textContent = 'Delete';
            deleteButton.dataset.index = index;
            deleteButton.addEventListener('click', () => deleteManagedEvent(index));
            eventItem.appendChild(deleteButton);
        }
        return eventItem;
    }

    // EVENT MANAGEMENT (Modal)
    function addManagedEvent(name, date, time) {
        if (!name || !date) {
            alert("Event name and date are required.");
            return;
        }
        managedEvents.push({ title: name, date, time });
        managedEvents.sort((a, b) => new Date(`${a.date}T${a.time || '00:00'}`) - new Date(`${b.date}T${b.time || '00:00'}`));
        renderEvents(scheduleAppPreviewDisplay, managedEvents, true);
        [eventNameInputModal, eventDateInputModal, eventTimeInputModal].forEach(input => input.value = '');
    }

    function deleteManagedEvent(index) {
        managedEvents.splice(index, 1);
        renderEvents(scheduleAppPreviewDisplay, managedEvents, true);
    }

    // MODAL EVENT HANDLERS
    if (addEventButtonModal) {
        addEventButtonModal.addEventListener('click', () => {
            addManagedEvent(eventNameInputModal.value.trim(), eventDateInputModal.value, eventTimeInputModal.value);
        });
    }

    if (loadScheduleButtonModal) {
        loadScheduleButtonModal.addEventListener('click', () => scheduleFileInputModal.click());
    }

    if (scheduleFileInputModal) {
        scheduleFileInputModal.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    try {
                        const loadedEvents = JSON.parse(e.target.result);
                        if (Array.isArray(loadedEvents)) {
                            managedEvents = loadedEvents.filter(ev => ev.title && ev.date)
                                .sort((a, b) => new Date(`${a.date}T${a.time || '00:00'}`) - new Date(`${b.date}T${b.time || '00:00'}`));
                            renderEvents(scheduleAppPreviewDisplay, managedEvents, true);
                            alert('Schedule loaded into manager successfully!');
                        } else {
                            alert('Invalid file format. Expected an array of events.');
                        }
                    } catch (error) {
                        alert('Error parsing schedule file: ' + error.message);
                    }
                };
                reader.readAsText(file);
                scheduleFileInputModal.value = ''; // Reset file input
            }
        });
    }

    // UPDATE LIVE PAGE BUTTON
    if (updateLivePageButton) {
        updateLivePageButton.addEventListener('click', () => {
            liveEvents = JSON.parse(JSON.stringify(managedEvents)); // Deep copy
            renderEvents(liveScheduleDisplay, liveEvents, false);
            scheduleAppModal.style.display = 'none';
            alert('Live page schedule updated!');
            updateMonthHeaderBasedOnScroll(); // Update header after rendering new live events
        });
    }

    // MONTH HEADER DISPLAY
    function displayCurrentMonthHeader(monthNameStr) {
        if (currentMonthSpan) {
            currentMonthSpan.textContent = monthNameStr || new Date().toLocaleString('default', { month: 'long' });
        }
    }

    function updateMonthHeaderBasedOnScroll() {
        if (!liveScheduleDisplay || liveEvents.length === 0) {
            displayCurrentMonthHeader(); // Display current month if no events or display area
            return;
        }

        const eventElements = liveScheduleDisplay.children;
        let topVisibleMonth = null;

        for (let i = 0; i < eventElements.length; i++) {
            const eventItem = eventElements[i];
            if (eventItem.classList.contains('event-item') && eventItem.dataset.eventDate) {
                const itemRect = eventItem.getBoundingClientRect();
                const containerRect = liveScheduleDisplay.getBoundingClientRect();

                // Check if the item is at least partially visible within the scroll container
                if (itemRect.top < containerRect.bottom && itemRect.bottom > containerRect.top) {
                    // Consider the first such visible event's month as the current
                    const eventDate = new Date(eventItem.dataset.eventDate + 'T00:00:00');
                    topVisibleMonth = eventDate.toLocaleString('default', { month: 'long' });
                    break;
                }
            }
        }
        displayCurrentMonthHeader(topVisibleMonth); // Pass null if no event was found, defaults to current month
    }

    // SCROLL EVENT LISTENER for live schedule display
    if (liveScheduleDisplay) {
        liveScheduleDisplay.addEventListener('scroll', updateMonthHeaderBasedOnScroll);
    }

    // INITIAL RENDERS
    async function loadDefaultSchedule() {
        const endpoints = ['/api/public/events', 'schedule.json'];
        for (const endpoint of endpoints) {
            try {
                const response = await fetch(endpoint, { cache: 'no-store' });
                if (!response.ok) continue;

                const loaded = await response.json();
                const events = Array.isArray(loaded)
                    ? loaded
                    : (Array.isArray(loaded?.events) ? loaded.events : []);
                if (!events.length) continue;

                liveEvents = normalizeAndSortEvents(events);
                managedEvents = JSON.parse(JSON.stringify(liveEvents));
                return;
            } catch (e) {
                // Try next endpoint.
            }
        }
    }

    await loadDefaultSchedule();

    renderEvents(liveScheduleDisplay, liveEvents, false);
    renderEvents(scheduleAppPreviewDisplay, managedEvents, true);
    updateMonthHeaderBasedOnScroll(); // Set initial month header based on current live events (if any)
});
