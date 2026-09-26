/* ==========================================================================
   Schedura — shared browser runtime
   --------------------------------------------------------------------------
   Session handling, the API wrapper, and the interface primitives that replaced
   the browser's own dialogs: toasts with undo, confirm/prompt modals, the
   offline banner and the re-authentication overlay.
   ========================================================================== */

(function () {
  'use strict';

  const Schedura = {};

  /* ── Escaping ─────────────────────────────────────────────────────────── */

  const escHtml = Schedura.escHtml = s =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                   .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /** Safely embed a value as a JS string literal inside an inline handler. */
  Schedura.escAttr = value => escHtml(JSON.stringify(String(value)));

  /* ── Favicon ──────────────────────────────────────────────────────────── */

  // Inlined rather than shipped as a file so there is no extra request and no
  // binary in the repo. A blank tab icon is one of the loudest "unfinished"
  // signals a site can give.
  Schedura.installFavicon = function () {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="7" fill="#2C4A70"/>
      <rect x="7" y="9" width="18" height="16" rx="2.5" fill="none" stroke="#F5F2EB" stroke-width="2"/>
      <path d="M7 14h18" stroke="#F5F2EB" stroke-width="2"/>
      <path d="M12 6v5M20 6v5" stroke="#F5F2EB" stroke-width="2" stroke-linecap="round"/>
      <rect x="11" y="17" width="4" height="4" rx="1" fill="#F5F2EB"/>
    </svg>`;
    const href = 'data:image/svg+xml,' + encodeURIComponent(svg.replace(/\s+/g, ' ').trim());
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = 'image/svg+xml';
    link.href = href;
  };

  /* ── Time formatting ──────────────────────────────────────────────────── */

  /** "just now" / "6 min ago" / "yesterday 14:20" / "12 Aug 2026" */
  Schedura.relTime = function (iso) {
    if (!iso) return '';
    const then = new Date(iso);
    if (isNaN(then)) return '';
    const secs = (Date.now() - then.getTime()) / 1000;
    const time = then.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    if (secs < 45)     return 'just now';
    if (secs < 5400)   return `${Math.max(1, Math.round(secs / 60))} min ago`;

    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    if (then >= startOfToday) return `today ${time}`;

    const startOfYesterday = new Date(startOfToday.getTime() - 864e5);
    if (then >= startOfYesterday) return `yesterday ${time}`;
    if (Date.now() - then.getTime() < 6 * 864e5) {
      return `${then.toLocaleDateString('en-GB', { weekday: 'long' })} ${time}`;
    }
    const sameYear = then.getFullYear() === new Date().getFullYear();
    return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  };

  Schedura.duration = function (ms) {
    if (ms == null) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60000);
    return `${m}m ${Math.round((ms % 60000) / 1000)}s`;
  };

  /* ── Host layer (created on demand) ───────────────────────────────────── */

  function hostEl(id, className, parent) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      if (className) el.className = className;
      (parent || document.body).appendChild(el);
    }
    return el;
  }

  /* ── Toasts ───────────────────────────────────────────────────────────── */

  /**
   * toast('Standard removed', { action: 'Undo', onAction: restore })
   *
   * Undo is why the confirm() dialogs could go: a product that can take an
   * action back does not need to ask permission before taking it.
   */
  Schedura.toast = function (message, opts = {}) {
    const stack = hostEl('scheduraToasts', 'toast-stack');
    const el = document.createElement('div');
    el.className = 'toast' + (opts.type ? ` toast-${opts.type}` : '');
    el.setAttribute('role', opts.type === 'error' ? 'alert' : 'status');

    const msg = document.createElement('div');
    msg.className = 'toast-msg';
    msg.textContent = message;
    el.appendChild(msg);

    let timer = null;
    const dismiss = () => {
      if (!el.isConnected) return;
      clearTimeout(timer);
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    };

    if (opts.action && typeof opts.onAction === 'function') {
      const btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = opts.action;
      btn.onclick = () => { dismiss(); opts.onAction(); };
      el.appendChild(btn);
    }

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = '&times;';
    close.onclick = dismiss;
    el.appendChild(close);

    stack.appendChild(el);
    // Undo needs long enough to notice and reach for; plain notices don't.
    timer = setTimeout(dismiss, opts.duration ?? (opts.action ? 9000 : 3600));
    return { dismiss };
  };

  /* ── Modal plumbing ───────────────────────────────────────────────────── */

  const openModals = [];

  function openModal(node, { onEscape } = {}) {
    document.body.appendChild(node);
    node.classList.add('open');
    const entry = { node, onEscape };
    openModals.push(entry);

    const focusable = node.querySelector('[data-autofocus], input, button.btn-primary, button');
    if (focusable) setTimeout(() => focusable.focus(), 60);

    node.addEventListener('mousedown', e => {
      if (e.target === node && onEscape) onEscape();
    });
    return entry;
  }

  function closeModal(entry) {
    const i = openModals.indexOf(entry);
    if (i !== -1) openModals.splice(i, 1);
    entry.node.classList.remove('open');
    setTimeout(() => entry.node.remove(), 180);
  }

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !openModals.length) return;
    const top = openModals[openModals.length - 1];
    if (top.onEscape) { e.preventDefault(); top.onEscape(); }
  });

  /* ── confirm() replacement ────────────────────────────────────────────── */

  /**
   * Reserved for the genuinely irreversible. Anything that can be undone should
   * use toast(..., { action: 'Undo' }) instead of asking first.
   */
  Schedura.confirm = function ({ title, body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
    return new Promise(resolve => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="cfTitle">
          <h2 id="cfTitle">${escHtml(title)}</h2>
          ${body ? `<p>${escHtml(body)}</p>` : ''}
          <div class="modal-actions">
            <button class="btn" data-act="cancel">${escHtml(cancelLabel)}</button>
            <button class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-act="ok" data-autofocus>${escHtml(confirmLabel)}</button>
          </div>
        </div>`;

      const finish = value => { closeModal(entry); resolve(value); };
      const entry = openModal(backdrop, { onEscape: () => finish(false) });
      backdrop.querySelector('[data-act="cancel"]').onclick = () => finish(false);
      backdrop.querySelector('[data-act="ok"]').onclick     = () => finish(true);
    });
  };

  /* ── prompt() replacement ─────────────────────────────────────────────── */

  Schedura.promptText = function ({ title, body = '', label = 'Name', value = '', placeholder = '', confirmLabel = 'Save', maxLength = 80 }) {
    return new Promise(resolve => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="ptTitle">
          <h2 id="ptTitle">${escHtml(title)}</h2>
          ${body ? `<p>${escHtml(body)}</p>` : ''}
          <label for="ptInput">${escHtml(label)}</label>
          <input id="ptInput" type="text" maxlength="${maxLength}" value="${escHtml(value)}" placeholder="${escHtml(placeholder)}" data-autofocus>
          <div class="modal-actions">
            <button class="btn" data-act="cancel">Cancel</button>
            <button class="btn btn-primary" data-act="ok">${escHtml(confirmLabel)}</button>
          </div>
        </div>`;

      const input = backdrop.querySelector('#ptInput');
      const finish = v => { closeModal(entry); resolve(v); };
      const entry = openModal(backdrop, { onEscape: () => finish(null) });

      const submit = () => {
        const v = input.value.trim();
        if (!v) { input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
        finish(v);
      };
      backdrop.querySelector('[data-act="cancel"]').onclick = () => finish(null);
      backdrop.querySelector('[data-act="ok"]').onclick     = submit;
      input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
      input.oninput   = () => input.removeAttribute('aria-invalid');
      setTimeout(() => input.select(), 70);
    });
  };

  /** Generic modal for richer content. Returns { close }. */
  Schedura.modal = function ({ title, html, wide = false, onClose }) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true">
        <h2>${escHtml(title)}</h2>
        <div data-body>${html}</div>
      </div>`;
    const close = () => { closeModal(entry); if (onClose) onClose(); };
    const entry = openModal(backdrop, { onEscape: close });
    return { close, root: backdrop.querySelector('[data-body]') };
  };

  /* ── Connection banner ────────────────────────────────────────────────── */

  Schedura.net = {
    online: navigator.onLine !== false,
    _listeners: [],
    onChange(fn) { this._listeners.push(fn); }
  };

  function paintNet() {
    const banner = hostEl('scheduraNet', 'net-banner');
    banner.setAttribute('role', 'status');
    if (Schedura.net.online) {
      banner.classList.remove('show');
    } else {
      banner.textContent = 'No connection — your changes are being held and will save when you are back online.';
      banner.classList.add('show');
    }
    Schedura.net._listeners.forEach(fn => { try { fn(Schedura.net.online); } catch {} });
  }

  window.addEventListener('online',  () => { Schedura.net.online = true;  paintNet(); });
  window.addEventListener('offline', () => { Schedura.net.online = false; paintNet(); });

  /* ── Session ──────────────────────────────────────────────────────────── */

  // The access token lives here and nowhere else — no storage, so nothing
  // long-lived is exposed to scripts. Continuity comes from the httpOnly
  // refresh cookie, which is what keeps you signed in across reloads.
  const auth = Schedura.auth = {
    token: null,
    email: null,
    name:  null,
    get isSignedIn() { return !!this.token; }
  };

  let refreshInFlight = null;

  /** Exchange the refresh cookie for an access token. Cached while in flight. */
  auth.refresh = function () {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
      .then(r => r.json().catch(() => ({})))
      .then(data => {
        if (data && data.success && data.token) {
          auth.token = data.token;
          auth.email = data.email;
          auth.name  = data.name;
          return true;
        }
        auth.token = null;
        return false;
      })
      .catch(() => false)
      .finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  };

  auth.adopt = function (data) {
    auth.token = data.token;
    auth.email = data.email;
    auth.name  = data.name;
  };

  auth.signOut = async function () {
    try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    auth.token = null;
    location.href = '/login';
  };

  /**
   * Require a session before rendering. Returns true when signed in; otherwise
   * sends the visitor to /login with a ?next= so they land back here.
   */
  auth.require = async function () {
    if (auth.token) return true;
    if (await auth.refresh()) return true;
    const next = location.pathname + location.search;
    location.replace('/login?next=' + encodeURIComponent(next));
    return false;
  };

  /* ── Re-authentication overlay ────────────────────────────────────────── */

  let reauthPromise = null;

  function loadGsi() {
    if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve(true);
    return new Promise(resolve => {
      const existing = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
      if (!existing) {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true; s.defer = true;
        document.head.appendChild(s);
      }
      const started = Date.now();
      (function poll() {
        if (window.google && window.google.accounts && window.google.accounts.id) return resolve(true);
        if (Date.now() - started > 8000) return resolve(false);
        setTimeout(poll, 100);
      })();
    });
  }

  /**
   * Shown when the refresh cookie itself has expired. The page stays exactly as
   * it was underneath, so signing back in resumes the work instead of losing it.
   */
  auth.promptReauth = function () {
    if (reauthPromise) return reauthPromise;

    reauthPromise = new Promise(resolve => {
      const backdrop = hostEl('scheduraReauth', 'reauth-backdrop');
      backdrop.innerHTML = `
        <div class="reauth-card" role="dialog" aria-modal="true" aria-labelledby="raTitle">
          <h2 id="raTitle">Signed out</h2>
          <p>Your session ended. Sign in again to carry on — nothing on this page has been lost.</p>
          <div id="reauthBtn" style="display:flex;justify-content:center;min-height:44px;align-items:center">
            <div class="spinner spinner-sm"></div>
          </div>
          <button class="btn btn-quiet btn-sm" style="margin-top:14px" id="reauthLeave">Go to sign-in page</button>
        </div>`;
      backdrop.classList.add('open');

      document.getElementById('reauthLeave').onclick = () => {
        location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
      };

      const done = ok => {
        backdrop.classList.remove('open');
        backdrop.innerHTML = '';
        reauthPromise = null;
        resolve(ok);
      };

      (async () => {
        const holder = document.getElementById('reauthBtn');
        try {
          const cfg = await fetch('/api/config').then(r => r.json());
          const ready = cfg.googleClientId ? await loadGsi() : false;
          if (!ready) {
            holder.innerHTML = '<p style="font-size:13px;color:var(--muted);margin:0">Use the button below to sign in again.</p>';
            return;
          }
          holder.innerHTML = '';
          google.accounts.id.initialize({
            client_id: cfg.googleClientId,
            callback: async response => {
              try {
                const res = await fetch('/api/auth/google', {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ credential: response.credential })
                });
                const data = await res.json();
                if (res.ok && data.success) {
                  auth.adopt(data);
                  Schedura.toast('Signed back in', { type: 'success' });
                  done(true);
                } else {
                  Schedura.toast(data.error || 'Sign-in failed', { type: 'error' });
                }
              } catch {
                Schedura.toast('Could not reach the server', { type: 'error' });
              }
            }
          });
          google.accounts.id.renderButton(holder, { theme: 'outline', size: 'large', width: 280, text: 'signin_with' });
        } catch {
          holder.innerHTML = '<p style="font-size:13px;color:var(--muted);margin:0">Use the button below to sign in again.</p>';
        }
      })();
    });

    return reauthPromise;
  };

  /* ── API wrapper ──────────────────────────────────────────────────────── */

  /**
   * api('/api/projects') — attaches the access token, silently refreshes an
   * expired one, and only escalates to the overlay when the session is really
   * gone. Callers get the parsed body plus `ok` and `status`.
   */
  Schedura.api = async function (path, options = {}, _retried = false) {
    if (!auth.token && !_retried) await auth.refresh();

    let res;
    try {
      res = await fetch(path, {
        ...options,
        credentials: 'same-origin',
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
          ...(options.headers || {})
        }
      });
    } catch (err) {
      return { ok: false, status: 0, offline: true, error: 'No connection.' };
    }

    if (res.status === 401 && !_retried) {
      if (await auth.refresh()) return Schedura.api(path, options, true);
      if (await auth.promptReauth()) return Schedura.api(path, options, true);
      return { ok: false, status: 401, error: 'Not signed in.' };
    }

    let body = {};
    if (res.status !== 204) {
      body = await res.json().catch(() => ({}));
    }
    return { ok: res.ok, status: res.status, ...body };
  };

  /* ── Top bar ──────────────────────────────────────────────────────────── */

  /** Fills in the user slot of a page's top bar once the session is known. */
  Schedura.paintUser = function () {
    const el = document.getElementById('topbarUser');
    if (el) el.textContent = auth.email || '';
  };

  /* ── Boot ─────────────────────────────────────────────────────────────── */

  Schedura.installFavicon();
  paintNet();

  window.Schedura = Schedura;
})();
