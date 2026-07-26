// Basic script for interactivity

document.addEventListener('DOMContentLoaded', () => {
    // Remove dev/admin and login shortcuts from the public nav.
    document.querySelectorAll('.devicon-btn').forEach((el) => el.remove());
    document.querySelectorAll('.nav-links').forEach((nav) => {
        nav.querySelectorAll('a').forEach((a) => {
            const text = String(a.textContent || '').trim().toLowerCase();
            const href = String(a.getAttribute('href') || '').trim().toLowerCase();
            const isAdminHref = href === '../admin/' || href === '/admin/' || href.endsWith('/admin/');
            if (text === 'login' && isAdminHref) a.remove();
        });
    });

    // Keep one canonical footer across every public page.
    const footer = document.querySelector('footer');
    if (footer) {
        const isNestedPage = String(window.location.pathname || '').toLowerCase().includes('/pages/');
        const root = isNestedPage ? '../' : '';
        const page = (name) => `${root}Pages/${name}`;
        footer.innerHTML = `
            <div class="footer-top-row">
                <img src="${root}ConImg/MtMoriahLogo-1.png" alt="Mt. Moriah Logo" class="footer-logo">
                <div class="footer-text-content">
                    <p>Our doors are always open to you. If you are without a church home, we hope you will unite with the Mt. Moriah family. Wherever you go, may you always feel the presence of God and may the blessings of faithful worship bring peace and joy to your heart.</p>
                </div>
            </div>
            <div class="footer-bottom-row">
                <div class="footer-links-section" id="quick-links">
                    <h4>Quick Links</h4>
                    <ul>
                        <li><a href="${root}index.html"><img src="${root}Icons/home.png" alt="Home icon" class="link-icon"><span class="link-text">Home</span></a></li>
                        <li><a href="${page('ministries.html')}"><img src="${root}Icons/ministries.png" alt="Ministries icon" class="link-icon"><span class="link-text">Ministries</span></a></li>
                        <li><a href="${page('leadership.html')}"><img src="${root}Icons/leadership.png" alt="Leadership icon" class="link-icon"><span class="link-text">Leadership</span></a></li>
                        <li><a href="${page('church_history.html')}"><img src="${root}Icons/churchhistory.png" alt="Church History icon" class="link-icon"><span class="link-text">Church History</span></a></li>
                        <li><a href="${page('giving.html')}"><img src="${root}Icons/finances.png" alt="Give icon" class="link-icon"><span class="link-text">Give</span></a></li>
                        <li><a href="${page('facility_rental.html')}"><img src="${root}Icons/facilityrental.png" alt="Facility Rental icon" class="link-icon"><span class="link-text">Facility Rental</span></a></li>
                        <li><a href="${page('contact.html')}"><img src="${root}Icons/contactus.png" alt="Contact Us icon" class="link-icon"><span class="link-text">Contact Us</span></a></li>
                    </ul>
                </div>
                <div class="footer-links-section" id="connect-us">
                    <h4>Connect With Us</h4>
                    <ul>
                        <li><a href="https://www.google.com/maps/search/?api=1&query=1201+South+8th+Street+Paducah+KY" target="_blank" rel="noopener noreferrer"><img src="${root}Icons/address.png" alt="Address icon" class="link-icon"><span class="link-text">1201 South 8th Street, Paducah, KY</span></a></li>
                        <li><a href="tel:2704433714"><img src="${root}Icons/phone.png" alt="Phone icon" class="link-icon"><span class="link-text">(270) 443-3714</span></a></li>
                        <li><a href="mailto:mtmoriahmbc1201@gmail.com"><img src="${root}Icons/mailus.png" alt="Email Us icon" class="link-icon"><span class="link-text">Email Us</span></a></li>
                        <li><a href="https://www.facebook.com/MtMoriahPaducah"><img src="${root}Icons/facebook.png" alt="Facebook icon" class="link-icon"><span class="link-text">Like us on Facebook</span></a></li>
                        <li><a href="https://youtube.com/channel/UCkAaHiYmUKIdKePifg1D2pg"><img src="${root}Icons/youtube.png" alt="YouTube icon" class="link-icon"><span class="link-text">Subscribe on YouTube</span></a></li>
                    </ul>
                </div>
                <div class="footer-links-section" id="newsletter-signup">
                    <h4>Newsletter</h4>
                    <form class="footer-subscribe-form" data-subscriber-form>
                        <label for="footerSubscriberEmail">Subscriber email</label>
                        <input class="input" id="footerSubscriberEmail" type="email" list="siteSubscriberOptions" placeholder="you@example.com" required>
                        <button class="btn-contact btn-contact--spaced" type="submit">Join List</button>
                        <p class="muted" data-subscriber-help>We will open your email app with a pre-filled request.</p>
                    </form>
                </div>
            </div>
            <div class="footer-copyright-row">
                <p>Designed by <a href="https://www.alphazonelabs.com" target="_blank" rel="noopener noreferrer">&copy; AlphaZoneLabs</a></p>
                <p>&copy; 2025 Mt. Moriah Missionary Baptist Church. All rights reserved.</p>
            </div>`;
    }

    const faqItems = document.querySelectorAll('.faq-item');
    faqItems.forEach((item) => {
        const question = item.querySelector('.faq-question');
        const answer = item.querySelector('.faq-answer');
        if (!question) return;
        if (!question.hasAttribute('tabindex')) question.setAttribute('tabindex', '0');
        question.setAttribute('role', 'button');
        if (answer) {
            if (!answer.id) answer.id = `faq-answer-${Math.random().toString(36).slice(2, 9)}`;
            question.setAttribute('aria-controls', answer.id);
        }
        question.setAttribute('aria-expanded', item.classList.contains('active') ? 'true' : 'false');
        question.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                question.click();
            }
        });
        question.addEventListener('click', () => {
            const isActive = item.classList.contains('active');
            faqItems.forEach((otherItem) => {
                otherItem.classList.remove('active');
                const otherQuestion = otherItem.querySelector('.faq-question');
                if (otherQuestion) otherQuestion.setAttribute('aria-expanded', 'false');
            });
            if (!isActive) {
                item.classList.add('active');
                question.setAttribute('aria-expanded', 'true');
            }
        });
    });

    const menuButton = document.getElementById('menuButton');
    const navLinks = document.getElementById('navLinks');
    if (menuButton && navLinks) {
        const setExpanded = (expanded) => menuButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        if (!menuButton.hasAttribute('aria-controls')) menuButton.setAttribute('aria-controls', 'navLinks');
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

    const contactForm = document.getElementById('contactInfoForm');
    if (contactForm) contactForm.classList.remove('hidden');

    const defaultProfilePageMeta = {
        ministries: { pageTitle: 'Ministries', introText: 'Learn more about the ministries and leaders who serve the Mt. Moriah Missionary Baptist Church family.' },
        leadership: { pageTitle: 'Leadership & Staff', staffHeading: 'Staff', deaconsHeading: 'Deacons', deaconessesHeading: 'Deaconesses', officialTeamHeading: 'Official Team & Trustees' },
        nav: { ministriesLabel: 'Ministries', leadershipLabel: 'Leadership & Staff' }
    };

    const normalizeProfilePageMeta = (raw) => {
        const src = raw && typeof raw === 'object' ? raw : {};
        const ministries = src.ministries && typeof src.ministries === 'object' ? src.ministries : {};
        const leadership = src.leadership && typeof src.leadership === 'object' ? src.leadership : {};
        const nav = src.nav && typeof src.nav === 'object' ? src.nav : {};
        return {
            ministries: { pageTitle: String(ministries.pageTitle || defaultProfilePageMeta.ministries.pageTitle).trim(), introText: String(ministries.introText || defaultProfilePageMeta.ministries.introText).trim() },
            leadership: { pageTitle: String(leadership.pageTitle || defaultProfilePageMeta.leadership.pageTitle).trim(), staffHeading: String(leadership.staffHeading || defaultProfilePageMeta.leadership.staffHeading).trim(), deaconsHeading: String(leadership.deaconsHeading || defaultProfilePageMeta.leadership.deaconsHeading).trim(), deaconessesHeading: String(leadership.deaconessesHeading || defaultProfilePageMeta.leadership.deaconessesHeading).trim(), officialTeamHeading: String(leadership.officialTeamHeading || defaultProfilePageMeta.leadership.officialTeamHeading).trim() },
            nav: { ministriesLabel: String(nav.ministriesLabel || defaultProfilePageMeta.nav.ministriesLabel).trim(), leadershipLabel: String(nav.leadershipLabel || defaultProfilePageMeta.nav.leadershipLabel).trim() }
        };
    };

    const applyProfilePageMeta = (meta) => {
        const pageMeta = normalizeProfilePageMeta(meta);
        const navMinistries = document.querySelector('.nav-links a[href="ministries.html"]');
        if (navMinistries && pageMeta.nav.ministriesLabel) navMinistries.textContent = pageMeta.nav.ministriesLabel;
        const navLeadership = document.querySelector('.nav-links a[href="leadership.html"]');
        if (navLeadership && pageMeta.nav.leadershipLabel) navLeadership.textContent = pageMeta.nav.leadershipLabel;
        const path = String(window.location.pathname || '').toLowerCase();
        if (path.includes('/pages/ministries')) {
            const title = document.querySelector('section.content-section h1');
            const intro = document.querySelector('section.content-section > p');
            if (title && pageMeta.ministries.pageTitle) title.textContent = pageMeta.ministries.pageTitle;
            if (intro && pageMeta.ministries.introText) intro.textContent = pageMeta.ministries.introText;
        }
        if (path.includes('/pages/leadership')) {
            const title = document.querySelector('section.content-section h1');
            if (title && pageMeta.leadership.pageTitle) title.textContent = pageMeta.leadership.pageTitle;
            [{ id: 'staff', value: pageMeta.leadership.staffHeading }, { id: 'deacons', value: pageMeta.leadership.deaconsHeading }, { id: 'deaconesses', value: pageMeta.leadership.deaconessesHeading }, { id: 'official-team', value: pageMeta.leadership.officialTeamHeading }].forEach((row) => {
                const heading = document.getElementById(row.id);
                const pill = document.querySelector(`.content-subnav a[href="#${row.id}"]`);
                if (heading && row.value) heading.textContent = row.value;
                if (pill && row.value) pill.textContent = row.value;
            });
        }
    };

    const normalizePhoneDigits = (value) => String(value || '').replace(/\D/g, '');
    const buildMapsUrl = (address) => {
        const q = encodeURIComponent(String(address || '').trim());
        return q ? `https://www.google.com/maps/search/?api=1&query=${q}` : '';
    };
    const tryFetchJson = async (urls) => {
        for (const url of urls) {
            try {
                const res = await fetch(url, { cache: 'no-store' });
                if (res.ok) return await res.json();
            } catch {}
        }
        return null;
    };

    const applySiteSettings = (settings) => {
        if (!settings || typeof settings !== 'object') return;
        const subscribers = Array.isArray(settings.subscribers) ? settings.subscribers.map((s) => typeof s === 'string' ? { email: s.trim(), name: '', group: 'general' } : { email: String(s?.email || '').trim(), name: String(s?.name || '').trim(), group: String(s?.group || 'general').trim() || 'general' }).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) : [];
        let list = document.getElementById('siteSubscriberOptions');
        if (!list) {
            list = document.createElement('datalist');
            list.id = 'siteSubscriberOptions';
            document.body.appendChild(list);
        }
        list.innerHTML = '';
        subscribers.forEach((sub) => {
            const opt = document.createElement('option');
            opt.value = sub.email;
            opt.label = sub.name ? `${sub.name} (${sub.group})` : sub.group;
            list.appendChild(opt);
        });
        document.querySelectorAll('[data-subscriber-form]').forEach((form) => {
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
                window.location.href = `mailto:${to}?subject=${encodeURIComponent('Newsletter Subscription Request')}&body=${encodeURIComponent(`Please add ${email} to the church newsletter list.`)}`;
                if (help) help.textContent = `Preparing email subscription request for ${email}.`;
            }, { passive: false });
        });
        const connect = document.getElementById('connect-us');
        if (connect) connect.querySelectorAll('a').forEach((a) => {
            const href = String(a.getAttribute('href') || '');
            const span = a.querySelector('.link-text');
            if (href.startsWith('tel:') && settings.phone) {
                const digits = normalizePhoneDigits(settings.phone);
                if (digits) a.setAttribute('href', `tel:${digits}`);
                if (span) span.textContent = String(settings.phone);
            }
            if (href.startsWith('mailto:') && settings.email) a.setAttribute('href', `mailto:${String(settings.email).trim()}`);
            if (href.includes('facebook.com') && settings.facebook) a.setAttribute('href', String(settings.facebook).trim());
            if (href.includes('youtube.com') && settings.youtube) a.setAttribute('href', String(settings.youtube).trim());
            if ((href.includes('google.com/maps') || href.includes('maps/search')) && settings.address) {
                const url = buildMapsUrl(settings.address);
                if (url) a.setAttribute('href', url);
                if (span) span.textContent = String(settings.address);
            }
        });
        if (settings.phone) {
            const digits = normalizePhoneDigits(settings.phone);
            if (digits) document.querySelectorAll('a[href^="tel:"]').forEach((a) => {
                const href = String(a.getAttribute('href') || '');
                if (href.includes('2704433714')) {
                    a.setAttribute('href', `tel:${digits}`);
                    if (a.textContent && a.textContent.includes('270')) a.textContent = String(settings.phone);
                }
            });
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
            document.querySelectorAll('form[action^="mailto:"]').forEach((form) => {
                const action = String(form.getAttribute('action') || '');
                if (action.includes('mtmoriahmbc1201@gmail.com')) form.setAttribute('action', `mailto:${email}`);
            });
        }
    };

    (async () => {
        const settings = await tryFetchJson(['site-settings.json', '../site-settings.json', '/site-settings.json']);
        if (settings) applySiteSettings(settings);
        const profilesData = await tryFetchJson(['profiles.json', '../profiles.json', '/profiles.json']);
        applyProfilePageMeta(profilesData?.pageMeta);
        const profiles = Array.isArray(profilesData?.profiles) ? profilesData.profiles : [];
        if (!profiles.length) return;
        const path = String(window.location.pathname || '').toLowerCase();
        const pageName = path.includes('/pages/ministries') ? 'ministries' : path.includes('/pages/leadership') ? 'leadership' : '';
        if (!pageName) return;
        const cards = Array.from(document.querySelectorAll('.leadership-profile'));
        const pageProfiles = profiles.filter((p) => String(p.page || '').toLowerCase() === pageName);
        cards.forEach((card, idx) => {
            const profile = pageProfiles[idx];
            if (!profile) return;
            const img = card.querySelector('img.profile-image');
            const details = card.querySelector('.profile-details');
            if (img && profile.image) img.setAttribute('src', String(profile.image));
            if (img && (profile.alt || profile.name)) img.setAttribute('alt', String(profile.alt || profile.name));
            if (!details) return;
            details.innerHTML = '';
            const name = document.createElement('h2');
            name.textContent = String(profile.name || '');
            details.appendChild(name);
            if (profile.title) {
                const titleWrap = document.createElement('p');
                const strong = document.createElement('strong');
                strong.textContent = String(profile.title);
                titleWrap.appendChild(strong);
                details.appendChild(titleWrap);
            }
            if (profile.bio) {
                const bio = document.createElement('p');
                bio.textContent = String(profile.bio);
                details.appendChild(bio);
            }
        });
    })();
});
