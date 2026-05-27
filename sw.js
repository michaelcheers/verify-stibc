// Service worker for certify-stibc-test.lynxseal.com — proxies all requests
// to portal.lynxseal.com and splices the STIBC header into HTML responses.
//
// Why this exists: previous design iframed the portal, which broke under
// strict shields (Brave) and added postMessage complexity. Now the portal
// runs same-origin via this SW. No iframe, no postMessage bridge, no
// nested-sandbox quirks.

'use strict';

const PORTAL_ORIGIN = 'https://portal.lynxseal.com';

// Per-wrapper config.
const TENANT = 'STIBC';
const APP = 'verify';              // 'certify' → /index.html, 'verify' → /verify-document.html
const ORG_NAME = 'STIBC';           // appended to <title> as " · STIBC"
const DEFAULT_PATH = APP === 'verify' ? '/verify-document.html' : '/index.html';

// Files served from the wrapper origin itself (not proxied). Anything else
// gets proxied to portal.lynxseal.com.
const LOCAL_PATHS = new Set([
  '/sw.js',
  '/404.html',
  '/CNAME',
  '/favicon.ico',
  '/stibc-logo.png',
]);

self.addEventListener('install', (e) => { e.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

// Virtual path: the SW synthesizes this JS file. Sets tenant globals
// (window.TENANT, etc.), toggles a body class based on auth state so the
// nav's login/signout entries can show/hide via CSS, and adds the
// "this-page" highlight to the current nav link.
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
  for (var a of document.querySelectorAll('.lynxseal-nav a[href], .lynxseal-nav form[action]')) {
    var href = a.getAttribute('href') || a.getAttribute('action') || '';
    var path = location.pathname;
    if (href === path || (href === '/' && (path === '/' || path === '/index.html'))) {
      (a.tagName === 'FORM' ? a.parentElement : a).classList.add('this-page');
    }
  }
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
  //   /              → DEFAULT_PATH (e.g. /index.html)
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
    // visual header in <body>.
    text = text.replace(/<body([^>]*)>/i, '<body$1>' + HEADER_HTML);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(text, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  // Non-HTML: still wrap in a fresh Response so .url doesn't leak portal origin.
  const body = await upstream.arrayBuffer();
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

// Visual header markup spliced after <body>. Mirrors the legacy
// _Layout.cshtml STIBC navbar (Bootstrap 4 + custom CSS). Login/signout
// items get toggled by the body's lynxseal-auth / lynxseal-anon class
// (set in TENANT_GLOBALS_JS based on localStorage auth token).
const HEADER_HTML = `
<style>
  .lynxseal-nav .navbar > .container { flex-direction: column; }
  .lynxseal-nav .navbar-nav { font-family: Catamaran, Arial, Helvetica, sans-serif !important; }
  .lynxseal-nav .nav-item { margin-left: 2rem; margin-right: 2rem; }
  .lynxseal-nav .nav-link,
  .lynxseal-nav a.text-dark,
  .lynxseal-nav a.this-page,
  .lynxseal-nav li.this-page > button[type=submit] {
    position: relative;
    padding: 0rem !important;
    margin: .5rem .5rem;
  }
  .lynxseal-nav .nav-link:hover,
  .lynxseal-nav a.text-dark:hover,
  .lynxseal-nav .this-page,
  .lynxseal-nav a.this-page,
  .lynxseal-nav li.this-page button[type=submit] { color: #005695 !important; }
  .lynxseal-nav a.text-dark:hover::after,
  .lynxseal-nav .nav-link:hover::after,
  .lynxseal-nav a.this-page::after,
  .lynxseal-nav li.this-page button[type=submit]::after {
    position: absolute; left: 0; bottom: -0.7rem; width: 100%; height: 1px;
    border-bottom: 3.4px solid #005695; content: "";
  }
  .lynxseal-nav .nav-link,
  .lynxseal-nav a.text-dark {
    font-size: 16px !important; color: #333338 !important; font-weight: 600 !important;
  }
  body.lynxseal-auth .lynxseal-anon-only { display: none; }
  body.lynxseal-anon .lynxseal-auth-only { display: none; }
</style>
<header class="lynxseal-nav">
  <nav class="navbar navbar-expand-sm navbar-toggleable-sm navbar-light bg-white border-bottom box-shadow mb-3">
    <div class="container">
      <a class="navbar-brand" href="https://stibc.org" style="margin-bottom:1rem;margin-top:2.5rem;margin-left:1rem">
        <img alt="STIBC logo" src="/stibc-logo.png" width="288" height="130">
      </a>
      <div class="navbar-collapse collapse d-sm-inline-flex justify-content-between">
        <ul class="navbar-nav">
          <li class="nav-item"><a class="nav-link text-dark" href="https://stibc.org">&lt; BACK TO MAIN SITE</a></li>
          <li class="nav-item"><a class="nav-link text-dark" href="/">VERIFY A DOCUMENT</a></li>
        </ul>
      </div>
    </div>
  </nav>
</header>
`;
