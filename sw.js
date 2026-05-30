// Service worker for verify-stibc-test.lynxseal.com — proxies all requests
// to portal.lynxseal.com and injects tenant globals into HTML responses.
//
// Why this exists: previous design iframed the portal, which broke under
// strict shields (Brave) and added postMessage complexity. Now the portal
// runs same-origin via this SW. No iframe, no postMessage bridge, no
// nested-sandbox quirks.
//
// What gets injected: just window.TENANT / window.ORG_NAME / window.WRAPPER_APP
// plus a body class reflecting auth state. The visual chrome (header, nav)
// is now drawn by the portal page itself, reading window.ORG_NAME — keeps
// the entire UI in one place and avoids two competing navbars.

'use strict';

const PORTAL_ORIGIN = 'https://portal.lynxseal.com';

// Per-wrapper config.
const TENANT = 'STIBC';
const APP = 'verify';              // 'certify' → /index.html, 'verify' → /verify-document.html
const ORG_NAME = 'STIBC';           // appended to <title> as " · STIBC"
const DEFAULT_PATH = APP === 'verify' ? '/verify-document.html' : '/index.html';

// Files served from the wrapper origin itself (not proxied). Anything else
// gets proxied to portal.lynxseal.com. /logo.png is what the portal's
// topbar <img> references — each wrapper drops its own logo.png at the
// repo root and the SW lets the request fall through to it.
const LOCAL_PATHS = new Set([
  '/sw.js',
  '/404.html',
  '/CNAME',
  '/favicon.ico',
  '/logo.png',
]);

self.addEventListener('install', (e) => { e.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

// Virtual path: the SW synthesizes this JS file. Sets tenant globals
// (window.TENANT, etc.) and toggles a body class based on auth state so
// the portal's topbar can show/hide its sign-in/sign-out entries via CSS.
const TENANT_GLOBALS_PATH = '/__tenant-globals.js';

const TENANT_GLOBALS_JS = `
window.TENANT=${JSON.stringify(TENANT)};
window.WRAPPER_APP=${JSON.stringify(APP)};
window.ORG_NAME=${JSON.stringify(ORG_NAME)};
document.addEventListener('DOMContentLoaded', function () {
  try {
    document.body.classList.add(
      localStorage.getItem('lynxseal:authToken') ? 'lynxseal-auth' : 'lynxseal-anon'
    );
  } catch (e) { document.body.classList.add('lynxseal-anon'); }
});
`;

// ---- Pinned, integrity-checked web fonts --------------------------------
// The portal pages declare @font-face with src pointing at the same-origin
// virtual path /__font/<key>. This SW fetches the real woff2 from jsdelivr
// with an SRI hash; the browser rejects mismatched bytes, so a tampered or
// poisoned font never reaches the rasterizer. Fonts ARE a live attack
// surface — a malicious font can remap glyphs so a verification code or URL
// renders as different characters than the real text — so this is integrity,
// not cosmetics. Doing it in the SW means no extra page-side JS and the page
// CSP stays locked to font-src 'self' (only the SW ever talks to the CDN).
// Any failure returns non-200 → the browser falls back to the system fonts
// in the CSS stacks (fail-closed).
const FONTS_CSS_PATH = '/__fonts.css';
const FONT_PATH_PREFIX = '/__font/';
const FONT_FILES = {
  'geist.woff2':             { url: 'https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5.2.8/files/geist-latin-wght-normal.woff2',             integrity: 'sha256-DLvmKGoA81bpiYB4PMlQqbaTdR4Ert+5fZUm/23CsxY=' },
  'geist-mono.woff2':        { url: 'https://cdn.jsdelivr.net/npm/@fontsource-variable/geist-mono@5.2.6/files/geist-mono-latin-wght-normal.woff2',  integrity: 'sha256-6fsIjurM7TB4YNgs7tsK6a0uv6B6fApyecjJYd2dX9M=' },
  'newsreader.woff2':        { url: 'https://cdn.jsdelivr.net/npm/@fontsource-variable/newsreader@5.2.6/files/newsreader-latin-wght-normal.woff2',  integrity: 'sha256-YpgTIdmjzHphpzeScpBDcD/WES2obo7ISLtX8IhXh1c=' },
  'newsreader-italic.woff2': { url: 'https://cdn.jsdelivr.net/npm/@fontsource-variable/newsreader@5.2.6/files/newsreader-latin-wght-italic.woff2', integrity: 'sha256-SLyIYbmyypMAdHytT9ajtKwwKNNk3wC9G3IJe6p15Qk=' },
};
const FONTS_CSS = `
@font-face{font-family:'Geist';font-style:normal;font-weight:300 700;font-display:swap;src:url('${FONT_PATH_PREFIX}geist.woff2') format('woff2')}
@font-face{font-family:'Geist Mono';font-style:normal;font-weight:400 500;font-display:swap;src:url('${FONT_PATH_PREFIX}geist-mono.woff2') format('woff2')}
@font-face{font-family:'Newsreader';font-style:normal;font-weight:300 600;font-display:swap;src:url('${FONT_PATH_PREFIX}newsreader.woff2') format('woff2')}
@font-face{font-family:'Newsreader';font-style:italic;font-weight:400;font-display:swap;src:url('${FONT_PATH_PREFIX}newsreader-italic.woff2') format('woff2')}
`;

async function serveFont(key) {
  const f = FONT_FILES[key];
  if (!f) return new Response('unknown font', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  try {
    // The integrity option makes the browser reject the response if its bytes
    // don't match the pinned hash — that's the SRI enforcement.
    const upstream = await fetch(f.url, { integrity: f.integrity, mode: 'cors', credentials: 'omit' });
    if (!upstream.ok) return new Response('font upstream ' + upstream.status, { status: 502, headers: { 'Content-Type': 'text/plain' } });
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  } catch (e) {
    return new Response('font integrity/fetch failure', { status: 502, headers: { 'Content-Type': 'text/plain' } });
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // cross-origin → not our problem
  if (LOCAL_PATHS.has(url.pathname)) return;       // local-only → pass through to GH Pages

  if (url.pathname === TENANT_GLOBALS_PATH) {
    event.respondWith(new Response(TENANT_GLOBALS_JS, {
      status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
    }));
    return;
  }

  if (url.pathname === FONTS_CSS_PATH) {
    event.respondWith(new Response(FONTS_CSS, {
      status: 200, headers: { 'Content-Type': 'text/css; charset=utf-8' },
    }));
    return;
  }

  if (url.pathname.startsWith(FONT_PATH_PREFIX)) {
    event.respondWith(serveFont(url.pathname.slice(FONT_PATH_PREFIX.length)));
    return;
  }

  event.respondWith(handleRequest(event.request, url));
});

async function handleRequest(request, url) {
  // Map wrapper-origin paths to portal-origin paths:
  //   /              → DEFAULT_PATH (e.g. /verify-document.html)
  //   /reset-password → /reset-password.html (append .html if extensionless)
  //   /img/foo.png    → /img/foo.png        (already has extension)
  let portalPath = url.pathname;
  if (portalPath === '/' || portalPath === '') portalPath = DEFAULT_PATH;
  else if (!/\.[a-z0-9]+$/i.test(portalPath)) portalPath += '.html';

  const target = PORTAL_ORIGIN + portalPath + url.search + url.hash;

  // Plain fetch — no forwarded headers (would turn this into a preflighted
  // request that static hosts like GH Pages don't answer with CORS headers).
  // Portal is a public static site; nothing it serves needs custom request
  // headers from the client.
  let upstream;
  try {
    upstream = await fetch(target, { method: request.method, credentials: 'omit' });
  } catch (e) {
    return new Response('SW proxy error: ' + (e && e.message), { status: 502, headers: { 'Content-Type': 'text/plain' } });
  }

  // Always rebuild as a fresh Response. If we returned `upstream` directly,
  // its .url would be the portal-origin URL the SW fetched (e.g.
  // https://portal.lynxseal.com/css/site.css), and the browser would
  // enforce CSP against THAT instead of the request URL the page asked
  // for. Wrapping in a new Response clears .url so CSP sees a same-origin
  // resource (which 'self' matches).
  const contentType = upstream.headers.get('Content-Type') || '';
  const headers = new Headers(upstream.headers);

  if (contentType.includes('text/html')) {
    let text = await upstream.text();
    // tenant globals script in <head>, BEFORE any portal script — they read
    // window.TENANT/ORG_NAME during initial execution.
    text = text.replace(/<head([^>]*)>/i, '<head$1><script src="' + TENANT_GLOBALS_PATH + '"></script>');
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(text, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  // Non-HTML: still wrap in a fresh Response so .url doesn't leak portal origin.
  const body = await upstream.arrayBuffer();
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}
