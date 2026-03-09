/* LettaBot Portal — shared utilities */

/** @type {string} */
let _apiKey = sessionStorage.getItem('lbkey') || '';

/** Get the current API key */
function getApiKey() { return _apiKey; }

/** Set and persist the API key */
function setApiKey(key) {
  _apiKey = key;
  if (key) sessionStorage.setItem('lbkey', key);
  else sessionStorage.removeItem('lbkey');
}

/**
 * Fetch from the lettabot API with auth headers.
 * Redirects to auth screen on 401.
 * @param {string} path
 * @param {RequestInit} [opts]
 * @param {() => void} [onUnauthorized] - callback when 401 is received
 * @returns {Promise<Response>}
 */
async function apiFetch(path, opts = {}, onUnauthorized) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'X-Api-Key': _apiKey,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  if (res.status === 401) {
    setApiKey('');
    if (onUnauthorized) onUnauthorized();
    throw new Error('Unauthorized');
  }
  return res;
}

/**
 * Show a toast notification.
 * @param {string} msg
 * @param {boolean} [isError]
 */
function showToast(msg, isError) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show ' + (isError ? 'err' : 'ok');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = 'toast'; }, 2500);
}

/**
 * Format an ISO timestamp as a relative time string.
 * @param {string} iso
 * @returns {string}
 */
function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

/**
 * Escape HTML special characters.
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/**
 * Create an element with optional attributes, classes, and children.
 * @param {string} tag
 * @param {Object} [attrs]
 * @param {...(Node|string)} children
 * @returns {HTMLElement}
 */
function el(tag, attrs, ...children) {
  const elem = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') elem.className = v;
      else if (k === 'textContent') elem.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') {
        elem.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v != null && v !== false) {
        elem.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  for (const child of children) {
    if (child == null) continue;
    elem.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return elem;
}
