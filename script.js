// Basic script for interactivity

document.addEventListener('DOMContentLoaded', () => {
    // Remove dev/admin and login shortcuts from the public nav (local request).
    document.querySelectorAll('.devicon-btn').forEach((el) => el.remove());
    document.querySelectorAll('.nav-links').forEach((nav) => {
        nav.querySelectorAll('a').forEach((a) => {
            const text = String(a.textContent || '').trim().toLowerCase();
            const href = String(a.getAttribute('href') || '').trim().toLowerCase();
            const isAdminHref = href === '../admin/' || href === '/admin/' || href.endsWith('/admin/');
            if (text === 'login' && isAdminHref) a.remove();
        });
    });

    // FAQ Accordion
    const faqItems = document.querySelectorAll('.faq-item');

    faqItems.forEach(item => {
        const question = item.querySelector('.faq-question');
        const answer = item.querySelector('.faq-answer');

        if (question) {
            // Make headings keyboard-focusable and announce expanded state
            if (!question.hasAttribute('tabindex')) question.setAttribute('tabindex', '0');
            question.setAttribute('role', 'button');

            if (answer) {
                if (!answer.id) {
                    answer.id = `faq-answer-${Math.random().toString(36).slice(2, 9)}`;
                }
                question.setAttribute('aria-controls', answer.id);
            }

            question.setAttribute('aria-expanded', item.classList.contains('active') ? 'true' : 'false');

            question.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    question.click();
                }
            });
        }

        question.addEventListener('click', () => {
            const isActive = item.classList.contains('active');
            // Close all items first
            faqItems.forEach(otherItem => {
                otherItem.classList.remove('active');
                const otherQuestion = otherItem.querySelector('.faq-question');
                if (otherQuestion) otherQuestion.setAttribute('aria-expanded', 'false');
            });
            // If the clicked item wasn't active, open it
            if (!isActive) {
                item.classList.add('active');
                if (question) question.setAttribute('aria-expanded', 'true');
            }
        });
    });

    // Navigation Menu Toggle
    const menuButton = document.getElementById('menuButton');
    const navLinks = document.getElementById('navLinks');

    if (menuButton && navLinks) {
        const setExpanded = (expanded) => {
            menuButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        };

        // Ensure sensible defaults even if markup is missing attributes
        if (!menuButton.hasAttribute('aria-controls')) {
            menuButton.setAttribute('aria-controls', 'navLinks');
        }
        setExpanded(navLinks.classList.contains('active'));

        menuButton.addEventListener('click', () => {
            navLinks.classList.toggle('active');
            setExpanded(navLinks.classList.contains('active'));
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && navLinks.classList.contains('active')) {
                navLinks.classList.remove('active');
                setExpanded(false);
                menuButton.focus();
            }
        });
    }

    // Contact page: ensure the contact form is visible when present
    const contactForm = document.getElementById('contactInfoForm');
    if (contactForm) {
        contactForm.classList.remove('hidden');
    }

    const defaultProfilePageMeta = {
        ministries: {
            pageTitle: 'Ministries',
            introText: 'Learn more about the ministries and leaders who serve the Mt. Moriah Missionary Baptist Church family.'
        },
        leadership: {
            pageTitle: 'Leadership & Staff',
            staffHeading: 'Staff',
            deaconsHeading: 'Deacons',
            deaconessesHeading: 'Deaconesses',
            officialTeamHeading: 'Official Team & Trustees'
        },
        nav: {
            ministriesLabel: 'Ministries',
            leadershipLabel: 'Leadership & Staff'
        }
    };

    const normalizeProfilePageMeta = (raw) => {
        const src = raw && typeof raw === 'object' ? raw : {};
        const ministries = src.ministries && typeof src.ministries === 'object' ? src.ministries : {};
        const leadership = src.leadership && typeof src.leadership === 'object' ? src.leadership : {};
        const nav = src.nav && typeof src.nav === 'object' ? src.nav : {};
        return {
            ministries: {
                pageTitle: String(ministries.pageTitle || defaultProfilePageMeta.ministries.pageTitle).trim(),
                introText: String(ministries.introText || defaultProfilePageMeta.ministries.introText).trim()
            },
            leadership: {
                pageTitle: String(leadership.pageTitle || defaultProfilePageMeta.leadership.pageTitle).trim(),
                staffHeading: String(leadership.staffHeading || defaultProfilePageMeta.leadership.staffHeading).trim(),
                deaconsHeading: String(leadership.deaconsHeading || defaultProfilePageMeta.leadership.deaconsHeading).trim(),
                deaconessesHeading: String(leadership.deaconessesHeading || defaultProfilePageMeta.leadership.deaconessesHeading).trim(),
                officialTeamHeading: String(leadership.officialTeamHeading || defaultProfilePageMeta.leadership.officialTeamHeading).trim()
            },
            nav: {
                ministriesLabel: String(nav.ministriesLabel || defaultProfilePageMeta.nav.ministriesLabel).trim(),
                leadershipLabel: String(nav.leadershipLabel || defaultProfilePageMeta.nav.leadershipLabel).trim()
            }
        };
    };

    const applyProfilePageMeta = (meta) => {
        const pageMeta = normalizeProfilePageMeta(meta);

        const navMinistries = document.querySelector('.nav-links a[href="ministries.html"]');
        if (navMinistries && pageMeta.nav.ministriesLabel) navMinistries.textContent = pageMeta.nav.ministriesLabel;
        const navLeadership = document.querySelector('.nav-links a[href="leadership.html"]');
        if (navLeadership && pageMeta.nav.leadershipLabel) navLeadership.textContent = pageMeta.nav.leadershipLabel;

        const path = String(window.location.pathname || '').toLowerCase();
        const isMinistries = path.includes('/pages/ministries');
        const isLeadership = path.includes('/pages/leadership');

        if (isMinistries) {
            const title = document.querySelector('section.content-section h1');
            if (title && pageMeta.ministries.pageTitle) title.textContent = pageMeta.ministries.pageTitle;

            const intro = document.querySelector('section.content-section > p');
            if (intro && pageMeta.ministries.introText) intro.textContent = pageMeta.ministries.introText;
        }

        if (isLeadership) {
            const title = document.querySelector('section.content-section h1');
            if (title && pageMeta.leadership.pageTitle) title.textContent = pageMeta.leadership.pageTitle;

            const headingMap = [
                { id: 'staff', value: pageMeta.leadership.staffHeading },
                { id: 'deacons', value: pageMeta.leadership.deaconsHeading },
                { id: 'deaconesses', value: pageMeta.leadership.deaconessesHeading },
                { id: 'official-team', value: pageMeta.leadership.officialTeamHeading }
            ];

            for (const row of headingMap) {
                const heading = document.getElementById(row.id);
                if (heading && row.value) heading.textContent = row.value;
                const pill = document.querySelector(`.content-subnav a[href="#${row.id}"]`);
                if (pill && row.value) pill.textContent = row.value;
            }
        }
    };

    // Site settings: update social/contact links from exported site-settings.json
    const normalizePhoneDigits = (value) => String(value || '').replace(/\D/g, '');
    const buildMapsUrl = (address) => {
        const q = encodeURIComponent(String(address || '').trim());
        return q ? `https://www.google.com/maps/search/?api=1&query=${q}` : '';
    };

    const tryFetchJson = async (urls) => {
        for (const url of urls) {
            try {
                const res = await fetch(url, { cache: 'no-store' });
                if (!res.ok) continue;
                return await res.json();
            } catch {
                // try next
            }
        }
        return null;
    };

    const applySiteSettings = (settings) => {
        if (!settings || typeof settings !== 'object') return;

        const subscribers = Array.isArray(settings.subscribers)
            ? settings.subscribers
                .map((s) => {
                    if (typeof s === 'string') return { email: s.trim(), name: '', group: 'general' };
                    return {
                        email: String(s?.email || '').trim(),
                        name: String(s?.name || '').trim(),
                        group: String(s?.group || 'general').trim() || 'general'
                    };
                })
                .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email))
            : [];

        let list = document.getElementById('siteSubscriberOptions');
        if (!list) {
            list = document.createElement('datalist');
            list.id = 'siteSubscriberOptions';
            document.body.appendChild(list);
        }
        list.innerHTML = '';
        for (const sub of subscribers) {
            const opt = document.createElement('option');
            opt.value = sub.email;
            opt.label = sub.name ? `${sub.name} (${sub.group})` : sub.group;
            list.appendChild(opt);
        }

        const forms = Array.from(document.querySelectorAll('[data-subscriber-form]'));
        for (const form of forms) {
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                const emailInput = form.querySelector('input[type="email"]');
                const help = form.querySelector('[data-subscriber-help]');
                const email = String(emailInput?.value || '').trim();
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    if (help) help.textContent = 'Please enter a valid email address.';
                    return;
                }

                const to = String(settings.email || 'mtmoriahmbc1201@gmail.com').trim();
                const subject = encodeURIComponent('Newsletter Subscription Request');
                const body = encodeURIComponent(`Please add ${email} to the church newsletter list.`);
                window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
                if (help) help.textContent = `Preparing email subscription request for ${email}.`;
            }, { passive: false });
        }

        // Footer "Connect With Us" section
        const connect = document.getElementById('connect-us');
        if (connect) {
            const anchors = Array.from(connect.querySelectorAll('a'));
            for (const a of anchors) {
                const href = String(a.getAttribute('href') || '');
                const span = a.querySelector('.link-text');

                if (href.startsWith('tel:') && settings.phone) {
                    const digits = normalizePhoneDigits(settings.phone);
                    if (digits) a.setAttribute('href', `tel:${digits}`);
                    if (span) span.textContent = String(settings.phone);
                }

                if (href.startsWith('mailto:') && settings.email) {
                    a.setAttribute('href', `mailto:${String(settings.email).trim()}`);
                    // Keep "Email Us" label unless it's showing an actual address.
                    if (span && span.textContent.includes('@')) span.textContent = String(settings.email).trim();
                }

                if (href.includes('facebook.com') && settings.facebook) {
                    a.setAttribute('href', String(settings.facebook).trim());
                }

                if (href.includes('youtube.com') && settings.youtube) {
                    a.setAttribute('href', String(settings.youtube).trim());
                }

                if ((href.includes('google.com/maps') || href.includes('maps/search')) && settings.address) {
                    const url = buildMapsUrl(settings.address);
                    if (url) a.setAttribute('href', url);
                    if (span) span.textContent = String(settings.address);
                }
            }
        }

        // Contact page cards + forms (only touch generic tel/mailto)
        if (settings.phone) {
            const digits = normalizePhoneDigits(settings.phone);
            if (digits) {
                document.querySelectorAll('a[href^="tel:"]').forEach((a) => {
                    // Avoid overwriting other non-footer numbers; only update the church office default.
                    const href = String(a.getAttribute('href') || '');
                    if (href.includes('2704433714')) {
                        a.setAttribute('href', `tel:${digits}`);
                        if (a.textContent && a.textContent.includes('270')) a.textContent = String(settings.phone);
                    }
                });
            }
        }

        if (settings.email) {
            const email = String(settings.email).trim();
            document.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
                const href = String(a.getAttribute('href') || '');
                if (href.includes('mtmoriahmbc1201@gmail.com')) {
                    a.setAttribute('href', `mailto:${email}`);
                    if (a.textContent && a.textContent.includes('@')) a.textContent = email;
                }
            });

            document.querySelectorAll('form[action^="mailto:"]').forEach((f) => {
                const action = String(f.getAttribute('action') || '');
                if (action.includes('mtmoriahmbc1201@gmail.com')) {
                    f.setAttribute('action', `mailto:${email}`);
                }
            });
        }
    };

    (async () => {
        const settings = await tryFetchJson(['site-settings.json', '../site-settings.json', '/site-settings.json']);
        if (settings) applySiteSettings(settings);

        const profilesData = await tryFetchJson(['profiles.json', '../profiles.json', '/profiles.json']);
        applyProfilePageMeta(profilesData?.pageMeta);
        const profiles = Array.isArray(profilesData?.profiles) ? profilesData.profiles : [];
        if (profiles.length) {
            const path = String(window.location.pathname || '').toLowerCase();
            const page = path.includes('/pages/ministries') ? 'ministries'
                : path.includes('/pages/leadership') ? 'leadership'
                    : '';
            if (page) {
                const cards = Array.from(document.querySelectorAll('.leadership-profile'));
                const pageProfiles = profiles.filter((p) => String(p.page || '').toLowerCase() === page);
                cards.forEach((card, idx) => {
                    const p = pageProfiles[idx];
                    if (!p) return;
                    const img = card.querySelector('img.profile-image');
                    const details = card.querySelector('.profile-details');
                    if (img && p.image) img.setAttribute('src', String(p.image));
                    if (img && (p.alt || p.name)) img.setAttribute('alt', String(p.alt || p.name));
                    if (details) {
                        details.innerHTML = '';
                        const nameEl = document.createElement('h2');
                        nameEl.textContent = String(p.name || '');
                        details.appendChild(nameEl);

                        if (p.title) {
                            const titleWrap = document.createElement('p');
                            const strong = document.createElement('strong');
                            strong.textContent = String(p.title);
                            titleWrap.appendChild(strong);
                            details.appendChild(titleWrap);
                        }

                        if (p.bio) {
                            const bioEl = document.createElement('p');
                            bioEl.textContent = String(p.bio);
                            details.appendChild(bioEl);
                        }
                    }
                });
            }
        }
    })();
});
