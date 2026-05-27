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

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // cross-origin → not our problem
  if (LOCAL_PATHS.has(url.pathname)) return;       // local-only → pass through to GH Pages

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
    const text = await upstream.text();
    const wrapped = text.replace(/<body([^>]*)>/i, '<body$1>' + HEADER_HTML);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(wrapped, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  // Non-HTML: still wrap in a fresh Response so .url doesn't leak portal origin.
  const body = await upstream.arrayBuffer();
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

// Header markup spliced into every HTML response. Includes a small <script>
// that exposes the tenant identity to portal scripts (api.js reads
// window.TENANT for the X-Tenant request header, etc.) — no postMessage
// handshake needed since we're same-origin.
const HEADER_HTML = `
<header style="border-bottom:1px solid #ddd;padding:1rem;display:flex;align-items:center;gap:1rem;flex-shrink:0;background:#fff">
  <a href="https://stibc.org" style="display:inline-block">
    <img alt="STIBC logo" src="/stibc-logo.png" width="288" height="130" style="display:block;max-width:288px;height:auto">
  </a>
  <nav style="display:flex;gap:1rem">
    <a href="https://stibc.org" style="color:#212529;text-decoration:none;font-weight:500">&lt; BACK TO MAIN SITE</a>
  </nav>
</header>
<script>
  window.TENANT = ${JSON.stringify(TENANT)};
  window.WRAPPER_APP = ${JSON.stringify(APP)};
  window.ORG_NAME = ${JSON.stringify(ORG_NAME)};
</script>
`;
