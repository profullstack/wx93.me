// wx93 progressive enhancement. The site works without this file: it adds copy
// buttons and passkeys (which need the browser's WebAuthn API by nature).
(() => {
  for (const el of document.querySelectorAll('.js-only')) el.hidden = false;

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-copy]');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      const was = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = was), 1400);
    } catch {}
  });
  for (const pre of document.querySelectorAll('pre.copyable')) {
    pre.title = 'Click to copy';
    pre.style.cursor = 'copy';
    pre.addEventListener('click', () => navigator.clipboard?.writeText(pre.textContent.trim()));
  }

  const post = (url, body) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), credentials: 'same-origin' }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    });
  const lib = () =>
    window.SimpleWebAuthnBrowser
      ? Promise.resolve(window.SimpleWebAuthnBrowser)
      : new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = '/assets/webauthn.js';
          s.onload = () => resolve(window.SimpleWebAuthnBrowser);
          s.onerror = reject;
          document.head.append(s);
        });

  const login = document.querySelector('[data-passkey-login]');
  if (login && window.PublicKeyCredential) {
    login.addEventListener('click', async () => {
      const err = document.querySelector('[data-passkey-error]');
      try {
        const { startAuthentication } = await lib();
        const { options, challengeId } = await post('/auth/passkey/login/options');
        const response = await startAuthentication({ optionsJSON: options });
        const r = await post('/auth/passkey/login/verify', { response, challengeId });
        location.href = r.next || '/account';
      } catch (e) {
        if (err) {
          err.hidden = false;
          err.textContent = e.message || 'That did not work. Use the email link instead.';
        }
      }
    });
  } else if (login) login.closest('.js-only').hidden = true;

  const reg = document.querySelector('[data-passkey-register]');
  if (reg && window.PublicKeyCredential) {
    reg.addEventListener('click', async () => {
      const status = document.querySelector('[data-passkey-status]');
      try {
        const { startRegistration } = await lib();
        const { options, challengeId } = await post('/auth/passkey/register/options');
        const response = await startRegistration({ optionsJSON: options });
        await post('/auth/passkey/register/verify', { response, challengeId });
        status.textContent = 'Passkey saved. Next time, sign in with one tap.';
      } catch (e) {
        status.textContent = e.message || 'The passkey was not saved.';
      }
    });
  } else if (reg) reg.hidden = true;

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
