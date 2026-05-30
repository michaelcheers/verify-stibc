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
