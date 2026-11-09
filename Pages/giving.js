// Payment details and confirmation stay inside Zeffy. No API keys or donor data here.
const embed = document.getElementById('givingEmbed');
const fallback = document.getElementById('givingEmbedFallback');
if (embed && fallback) {
  let observer;
  let timer;
  let failed = false;
  const frame = fallback.querySelector('iframe');
  const fallbackUrl = frame.getAttribute('src');
  // Keep a working iframe for browsers without JavaScript; enhance to the modern embed.
  frame.removeAttribute('src');
  fallback.hidden = true;
  const recover = () => {
    failed = true;
    clearTimeout(timer);
    observer?.disconnect();
    embed.hidden = true;
    fallback.hidden = false;
    frame.src = fallbackUrl;
  };
  observer = new MutationObserver(() => {
    if (failed || !embed.querySelector('iframe')) return;
    clearTimeout(timer);
    observer.disconnect();
    fallback.remove();
  });
  observer.observe(embed, { childList: true, subtree: true });
  const script = document.createElement('script');
  script.src = 'https://www.zeffy.com/embed/v2/zeffy-embed.js';
  script.async = true;
  script.addEventListener('error', recover, { once: true });
  timer = setTimeout(recover, 12000);
  document.head.append(script);
}
