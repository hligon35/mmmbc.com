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
            group.querySelectorAll('.nav-parent-toggle, .nav-parent-link').forEach((control) => {
                control.setAttribute('aria-expanded', 'false');
            });
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

            const parentLink = document.createElement('a');
            parentLink.className = 'nav-parent-link';
            const leadershipHref = buildLeadershipHref(baseHref, 'leadership.html');
            parentLink.href = leadershipHref;
            parentLink.setAttribute('href', leadershipHref);
            parentLink.textContent = parentLabel;
            parentLink.setAttribute('aria-haspopup', 'true');
            parentLink.setAttribute('aria-expanded', 'false');

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'nav-parent-toggle';
            toggle.setAttribute('aria-haspopup', 'true');
            toggle.setAttribute('aria-expanded', 'false');
            toggle.setAttribute('aria-label', `Show ${parentLabel} menu`);
            toggle.innerHTML = '<span class="nav-parent-caret" aria-hidden="true">&#9662;</span>';

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

            group.appendChild(parentLink);
            group.appendChild(toggle);
            group.appendChild(submenu);
            leadershipLink.replaceWith(group);

            const openLeadershipMenu = () => {
                group.classList.add('is-open');
                toggle.setAttribute('aria-expanded', 'true');
                parentLink.setAttribute('aria-expanded', 'true');
            };

            toggle.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const isOpen = group.classList.contains('is-open');
                closeLeadershipMenus();
                if (!isOpen) openLeadershipMenu();
            });

            group.addEventListener('mouseenter', openLeadershipMenu);
            group.addEventListener('mouseleave', closeLeadershipMenus);
            group.addEventListener('focusin', openLeadershipMenu);
            group.addEventListener('focusout', (event) => {
                if (!group.contains(event.relatedTarget)) closeLeadershipMenus();
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
                        <li><a href="${page('leadership.html')}"><img src="${root}Icons/leadership.png" alt="Leadership icon" class="link-icon"><span class="link-text">Leadership</span></a></li>
                        <li><a href="${page('church_history.html')}"><img src="${root}Icons/churchhistory.png" alt="Church History icon" class="link-icon"><span class="link-text">Church History</span></a></li>
                        <li><a href="/give"><img src="${root}Icons/give.png" alt="Give icon" class="link-icon"><span class="link-text">Give</span></a></li>
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
                    <form class="footer-subscribe-form" data-subscriber-form data-cloudflare-form>
                        <div class="subscriber-name-fields">
                            <label>First name<input type="text" name="firstName" autocomplete="given-name" maxlength="60" required></label>
                            <label>Last name<input type="text" name="lastName" autocomplete="family-name" maxlength="80" required></label>
                        </div>
                        <label class="subscriber-email-field">Email address<input type="email" name="email" autocomplete="email" placeholder="you@example.com" maxlength="254" required></label>
                        <div class="form-turnstile" data-turnstile-container hidden></div>
                        <button class="btn-contact btn-contact--spaced" type="submit">Join List</button>
                        <p class="muted" data-subscriber-help role="status" aria-live="polite"></p>
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
        if (answer) {
            if (!answer.id) answer.id = `faq-answer-${Math.random().toString(36).slice(2, 9)}`;
            question.setAttribute('aria-controls', answer.id);
        }
        question.setAttribute('aria-expanded', 'false');
        const syncFaqState = () => {
            question.setAttribute('aria-expanded', item.matches(':hover, :focus-within') ? 'true' : 'false');
        };
        item.addEventListener('mouseenter', syncFaqState);
        item.addEventListener('mouseleave', syncFaqState);
        item.addEventListener('focusin', syncFaqState);
        item.addEventListener('focusout', syncFaqState);
    });

    const menuButton = document.getElementById('menuButton');
    const navLinks = document.getElementById('navLinks');
    const setMenuExpanded = (expanded) => {
        if (menuButton) menuButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    };
    const closeMobileMenu = ({ restoreFocus = false } = {}) => {
        if (!navLinks) return;
        navLinks.classList.remove('active');
        setMenuExpanded(false);
        closeLeadershipMenus();
        if (restoreFocus && menuButton) menuButton.focus();
    };

    enhanceLeadershipNav();
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.nav-item-group--leadership')) closeLeadershipMenus();
    });
    if (menuButton && navLinks) {
        if (!menuButton.hasAttribute('aria-controls')) menuButton.setAttribute('aria-controls', 'navLinks');
        setMenuExpanded(navLinks.classList.contains('active'));

        menuButton.addEventListener('click', () => {
            navLinks.classList.toggle('active');
            const isExpanded = navLinks.classList.contains('active');
            setMenuExpanded(isExpanded);
            if (!isExpanded) closeLeadershipMenus();
        });

        navLinks.querySelectorAll('a').forEach((link) => {
            link.addEventListener('click', () => {
                closeMobileMenu();
            });
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && navLinks.classList.contains('active')) {
                closeMobileMenu({ restoreFocus: true });
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

    const postJson = async (url, payload) => {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(String(data?.error || `Request failed (${res.status})`));
        }
        return data;
    };

    const ensureFormUtils = () => {
        if (window.MMmbcForms) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/public-form-utils.js?v=20260927g';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    };
    const protectedForms = document.querySelectorAll('form[data-cloudflare-form]');
    protectedForms.forEach((form) => {
        const submit = form.querySelector('button[type="submit"]');
        if (submit) submit.disabled = true;
    });
    const applySiteSettings = async (settings) => {
        if (!settings || typeof settings !== 'object') return false;
        let forms = window.MMmbcForms || {};
        const verificationUnavailable = settings.formVerificationUnavailable ||
            (settings.verificationRequired !== false && !settings.turnstileSiteKey);
        let widgetReady = false;
        if (!verificationUnavailable) {
            try {
                await ensureFormUtils();
                forms = window.MMmbcForms || {};
                if (settings.turnstileSiteKey && typeof forms.loadTurnstile === 'function') {
                    const results = await Promise.all(Array.from(protectedForms, (form) => forms.loadTurnstile(form, settings.turnstileSiteKey)));
                    widgetReady = results.length === protectedForms.length && results.every(Boolean);
                } else if (settings.verificationRequired === false) {
                    widgetReady = true;
                }
            } catch { /* Show the unavailable state below. */ }
        }
        if (!widgetReady) {
            protectedForms.forEach((form) => {
                const status = form.querySelector('.form-status, [data-subscriber-help]');
                if (status) {
                    status.textContent = 'This form is temporarily unavailable. Please email us at ';
                    const email = String(settings.email || 'mtmoriahmbc1201@gmail.com').trim();
                    const link = document.createElement('a');
                    link.href = `mailto:${email}`;
                    link.textContent = email;
                    status.append(link, '.');
                }
                const submit = form.querySelector('button[type="submit"]');
                if (submit) submit.disabled = true;
            });
        } else {
            protectedForms.forEach((form) => {
                const submit = form.querySelector('button[type="submit"]');
                if (submit) submit.disabled = false;
            });
        }
        document.querySelectorAll('[data-subscriber-form]').forEach((form) => {
            if (!widgetReady) return;
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const emailInput = form.querySelector('input[type="email"]');
                const help = form.querySelector('[data-subscriber-help]');
                const email = String(emailInput?.value || '').trim();
                const firstName = String(form.querySelector('[name="firstName"]')?.value || '').trim();
                const lastName = String(form.querySelector('[name="lastName"]')?.value || '').trim();
                if (!firstName || !lastName) {
                    if (help) help.textContent = 'Please enter your first and last name.';
                    return;
                }
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    if (help) help.textContent = 'Please enter a valid email address.';
                    return;
                }
                const turnstileToken = typeof forms.getTurnstileToken === 'function' ? forms.getTurnstileToken(form) : '';
                if (settings.verificationRequired !== false && !turnstileToken) {
                    if (help) help.textContent = 'Please complete the Cloudflare verification before joining.';
                    return;
                }
                const submit = form.querySelector('button[type="submit"]');
                if (submit) submit.disabled = true;
                if (help) help.textContent = `Adding ${email} to the newsletter list...`;
                try {
                    await postJson('/api/public/newsletter/subscribe', { firstName, lastName, email, turnstileToken });
                    if (help) help.textContent = `${email} has been added to the newsletter list.`;
                    form.reset();
                } catch (error) {
                    if (help) help.textContent = String(error?.message || 'Unable to join the list. Please try again.');
                } finally {
                    if (typeof forms.resetTurnstile === 'function') forms.resetTurnstile(form);
                    if (submit) submit.disabled = false;
                }
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
        return widgetReady;
    };

    const wireContactForm = (settings) => {
        if (!contactForm) return;
        const forms = window.MMmbcForms || {};
        const submitBtn = contactForm.querySelector('button[type="submit"]');
        const status = contactForm.querySelector('#contactFormStatus');
        if (settings.formVerificationUnavailable || (settings.verificationRequired !== false && !settings.turnstileSiteKey)) return;
        if (typeof forms.wireFormatting === 'function') forms.wireFormatting(contactForm);
        contactForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            if (!contactForm.reportValidity()) {
                if (status) status.textContent = 'Please correct the highlighted fields before sending.';
                return;
            }

            const phoneInput = contactForm.querySelector('#contactPhone');
            const postalInput = contactForm.querySelector('#contactPostalCode');
            const email = typeof forms.normalizeEmail === 'function'
                ? forms.normalizeEmail(contactForm.querySelector('#contactEmail')?.value)
                : String(contactForm.querySelector('#contactEmail')?.value || '').trim().toLowerCase();
            const phone = typeof forms.normalizePhone === 'function'
                ? forms.normalizePhone(phoneInput?.value)
                : String(phoneInput?.value || '').trim();
            const postalCode = typeof forms.normalizePostalCode === 'function'
                ? forms.normalizePostalCode(postalInput?.value)
                : String(postalInput?.value || '').trim();
            const state = typeof forms.normalizeState === 'function'
                ? forms.normalizeState(contactForm.querySelector('#contactState')?.value)
                : String(contactForm.querySelector('#contactState')?.value || '').trim().toUpperCase();

            if (phoneInput && String(phoneInput.value || '').trim() && !phone) {
                phoneInput.setCustomValidity('Enter a valid 10-digit phone number.');
            } else if (phoneInput) {
                phoneInput.setCustomValidity('');
            }
            if (postalInput && String(postalInput.value || '').trim() && !postalCode) {
                postalInput.setCustomValidity('Enter a 5-digit ZIP code or ZIP+4.');
            } else if (postalInput) {
                postalInput.setCustomValidity('');
            }
            if (typeof forms.isValidEmail === 'function' && !forms.isValidEmail(email)) {
                contactForm.querySelector('#contactEmail')?.setCustomValidity('Enter a valid email address.');
            } else {
                contactForm.querySelector('#contactEmail')?.setCustomValidity('');
            }
            if (!contactForm.reportValidity()) {
                if (status) status.textContent = 'Please correct the highlighted fields before sending.';
                return;
            }

            if (phoneInput && phone) phoneInput.value = phone;
            if (postalInput && postalCode) postalInput.value = postalCode;
            const firstName = String(contactForm.querySelector('#contactFirstName')?.value || '').trim();
            const lastName = String(contactForm.querySelector('#contactLastName')?.value || '').trim();
            const payload = {
                firstName,
                lastName,
                name: `${firstName} ${lastName}`.trim(),
                phone,
                addressLine1: String(contactForm.querySelector('#contactAddressLine1')?.value || '').trim(),
                addressLine2: String(contactForm.querySelector('#contactAddressLine2')?.value || '').trim(),
                city: String(contactForm.querySelector('#contactCity')?.value || '').trim(),
                state,
                postalCode,
                email,
                message: String(contactForm.querySelector('#contactMessage')?.value || '').trim(),
                turnstileToken: typeof forms.getTurnstileToken === 'function' ? forms.getTurnstileToken(contactForm) : ''
            };

            if (contactForm.querySelector('[data-turnstile-container]')?.hidden === false && !payload.turnstileToken) {
                if (status) status.textContent = 'Please complete the Cloudflare verification before sending.';
                return;
            }

            const submitLabel = submitBtn ? submitBtn.textContent : '';
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Sending...';
            }
            if (status) status.textContent = 'Sending your message securely...';

            try {
                await postJson('/api/public/contact-message', payload);
                if (status) status.textContent = 'Thank you. Your message has been sent.';
                contactForm.reset();
                if (typeof forms.resetTurnstile === 'function') forms.resetTurnstile(contactForm);
            } catch (error) {
                if (typeof forms.resetTurnstile === 'function') forms.resetTurnstile(contactForm);
                if (status) status.textContent = String(error?.message || 'Unable to send your message. Please try again.');
            } finally {
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = submitLabel || 'Send Message';
                }
            }
        });
    };

    (async () => {
        const settings = await tryFetchJson(['/api/public/site-settings', 'site-settings.json', '../site-settings.json', '/site-settings.json']);
        if (settings) {
            if (await applySiteSettings(settings)) wireContactForm(settings);
        } else {
            protectedForms.forEach((form) => {
                const status = form.querySelector('.form-status, [data-subscriber-help]');
                if (status) status.textContent = 'Forms are temporarily unavailable. Please try again later.';
            });
        }
    })();
});
