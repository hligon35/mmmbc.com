// Basic script for interactivity

document.addEventListener('DOMContentLoaded', () => {
    const leadershipSubpages = [
        { file: 'associate_ministers.html', label: 'Associate Ministers' },
        { file: 'deacons.html', label: 'Deacons' },
        { file: 'deaconesses.html', label: 'Deaconesses' },
        { file: 'official_team_trustees.html', label: 'Official Team & Trustees' }
    ];

    const buildLeadershipHref = (baseHref, fileName) => {
        const href = String(baseHref || '').trim();
        if (href) {
            if (/(leadership|associate_ministers)\.html/i.test(href)) {
                return href.replace(/(leadership|associate_ministers)\.html.*/i, fileName);
            }
            if (href.endsWith('/')) return `${href}${fileName}`;
        }
        const nested = String(window.location.pathname || '').toLowerCase().includes('/pages/');
        return nested ? fileName : `Pages/${fileName}`;
    };

    const closeLeadershipMenus = () => {
        document.querySelectorAll('.nav-item-group--leadership.is-open').forEach((group) => {
            group.classList.remove('is-open');
            const btn = group.querySelector('.nav-parent-toggle');
            if (btn) btn.setAttribute('aria-expanded', 'false');
        });
    };

    const enhanceLeadershipNav = () => {
        document.querySelectorAll('.nav-links').forEach((nav) => {
            if (nav.querySelector('.nav-item-group--leadership')) return;

            const directAnchors = Array.from(nav.querySelectorAll(':scope > a'));
            const leadershipLink = directAnchors.find((a) => {
                const text = String(a.textContent || '').trim().toLowerCase();
                const href = String(a.getAttribute('href') || '').trim().toLowerCase();
                return text.includes('leadership') || /(leadership|associate_ministers)\.html/.test(href);
            });

            if (!leadershipLink) return;

            const parentLabel = String(leadershipLink.textContent || '').trim() || 'Leadership & Staff';
            const baseHref = leadershipLink.getAttribute('href') || '';

            const group = document.createElement('div');
            group.className = 'nav-item-group nav-item-group--leadership';

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'nav-parent-toggle';
            toggle.setAttribute('aria-haspopup', 'true');
            toggle.setAttribute('aria-expanded', 'false');
            toggle.innerHTML = `${parentLabel}<span class="nav-parent-caret" aria-hidden="true">&#9662;</span>`;

            const submenu = document.createElement('div');
            submenu.className = 'nav-submenu';
            submenu.setAttribute('role', 'menu');
            submenu.setAttribute('aria-label', `${parentLabel} links`);

            leadershipSubpages.forEach((item) => {
                const a = document.createElement('a');
                a.href = buildLeadershipHref(baseHref, item.file);
                a.textContent = item.label;
                a.setAttribute('role', 'menuitem');
                submenu.appendChild(a);
            });

            group.appendChild(toggle);
            group.appendChild(submenu);
            leadershipLink.replaceWith(group);

            toggle.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const isOpen = group.classList.contains('is-open');
                closeLeadershipMenus();
                if (!isOpen) {
                    group.classList.add('is-open');
                    toggle.setAttribute('aria-expanded', 'true');
                }
            });

            submenu.querySelectorAll('a').forEach((a) => {
                a.addEventListener('click', () => {
                    closeLeadershipMenus();
                    if (nav.classList.contains('active')) nav.classList.remove('active');
                    const menuButton = document.getElementById('menuButton');
                    if (menuButton) menuButton.setAttribute('aria-expanded', 'false');
                });
            });
        });
    };

    document.querySelectorAll('.devicon-btn').forEach((el) => el.remove());
    document.querySelectorAll('.nav-links').forEach((nav) => {
        nav.querySelectorAll('a').forEach((a) => {
            const text = String(a.textContent || '').trim().toLowerCase();
            const href = String(a.getAttribute('href') || '').trim().toLowerCase();
            const isAdminHref = href === '../admin/' || href === '/admin/' || href.endsWith('/admin/');
            if (text === 'login' && isAdminHref) a.remove();
        });
    });

    if (!document.getElementById('sharedFooterResponsiveStyles')) {
        const footerStyles = document.createElement('style');
        footerStyles.id = 'sharedFooterResponsiveStyles';
        footerStyles.textContent = `
            @media (max-width: 768px) {
                footer .footer-top-row,
                footer .footer-bottom-row {
                    flex-direction: column !important;
                    align-items: stretch !important;
                }
                footer .footer-top-row {
                    text-align: center;
                }
                footer .footer-logo {
                    align-self: center;
                }
                footer .footer-text-content {
                    align-items: center !important;
                    text-align: center !important;
                    width: 100%;
                }
                footer .footer-links-section {
                    width: 100% !important;
                    box-sizing: border-box;
                }
            }
        `;
        document.head.appendChild(footerStyles);
    }

    // Page-specific cleanup that remains reliable even when older HTML is cached.
    document.querySelectorAll('section[aria-label="Newsletter signup"]').forEach((section) => section.remove());
    document.querySelectorAll('.content-subnav').forEach((list) => {
        list.style.listStyle = 'none';
        list.style.paddingLeft = '0';
        list.querySelectorAll('li').forEach((item) => { item.style.listStyle = 'none'; });
    });
    document.querySelectorAll('.givingTrustCard').forEach((aside) => aside.remove());
    const givingLayout = document.querySelector('.givingLayout');
    if (givingLayout) {
        givingLayout.style.display = 'block';
        givingLayout.style.maxWidth = '860px';
        givingLayout.style.margin = '0 auto';
    }
    const givingSubmit = document.getElementById('givingSubmit');
    if (givingSubmit && !document.querySelector('.givingStripeNote')) {
        const stripeNote = document.createElement('p');
        stripeNote.className = 'givingStripeNote';
        stripeNote.textContent = 'Powered by Stripe';
        stripeNote.style.margin = '12px 0 0';
        stripeNote.style.textAlign = 'center';
        stripeNote.style.fontSize = '0.9rem';
        stripeNote.style.fontWeight = '700';
        stripeNote.style.opacity = '0.72';
        givingSubmit.insertAdjacentElement('afterend', stripeNote);
    }

    const footer = document.querySelector('footer');
    if (footer) {
        const currentYear = new Date().getFullYear();
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
                        <li><a href="${page('associate_ministers.html')}"><img src="${root}Icons/leadership.png" alt="Leadership icon" class="link-icon"><span class="link-text">Leadership</span></a></li>
                        <li><a href="${page('church_history.html')}"><img src="${root}Icons/churchhistory.png" alt="Church History icon" class="link-icon"><span class="link-text">Church History</span></a></li>
                        <li><a href="${page('giving.html')}"><img src="${root}Icons/give.png" alt="Give icon" class="link-icon"><span class="link-text">Give</span></a></li>
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
                <p>&copy; ${currentYear} Mt. Moriah Missionary Baptist Church. All rights reserved.</p>
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
    enhanceLeadershipNav();
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.nav-item-group--leadership')) closeLeadershipMenus();
    });
    if (menuButton && navLinks) {
        const setExpanded = (expanded) => menuButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        if (!menuButton.hasAttribute('aria-controls')) menuButton.setAttribute('aria-controls', 'navLinks');
        setExpanded(navLinks.classList.contains('active'));
        menuButton.addEventListener('click', () => {
            navLinks.classList.toggle('active');
            setExpanded(navLinks.classList.contains('active'));
            if (!navLinks.classList.contains('active')) closeLeadershipMenus();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && navLinks.classList.contains('active')) {
                navLinks.classList.remove('active');
                setExpanded(false);
                closeLeadershipMenus();
                menuButton.focus();
            }
        });
    }

    const contactForm = document.getElementById('contactInfoForm');
    if (contactForm) contactForm.classList.remove('hidden');

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
        const subscribers = Array.isArray(settings.subscribers)
            ? settings.subscribers.map((s) => typeof s === 'string' ? { email: s.trim(), name: '', group: 'general' } : {
                email: String(s?.email || '').trim(), name: String(s?.name || '').trim(), group: String(s?.group || 'general').trim() || 'general'
            }).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email))
            : [];
        let list = document.getElementById('siteSubscriberOptions');
        if (!list) {
            list = document.createElement('datalist');
            list.id = 'siteSubscriberOptions';
            document.body.appendChild(list);
        }
        list.innerHTML = '';
        subscribers.forEach((sub) => {
            const option = document.createElement('option');
            option.value = sub.email;
            option.label = sub.name ? `${sub.name} (${sub.group})` : sub.group;
            list.appendChild(option);
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
            });
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
    };

    (async () => {
        const settings = await tryFetchJson(['site-settings.json', '../site-settings.json', '/site-settings.json']);
        if (settings) applySiteSettings(settings);
    })();
});
