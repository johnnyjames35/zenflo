const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const landing = read('public/landing.html');
const appHtml = read('public/index.html');
const server = read('server.js');
const manifest = JSON.parse(read('public/manifest.json'));
const worker = read('public/service-worker.js');

test('public homepage exposes complete crawl metadata', () => {
  assert.match(landing, /<meta name="description"/);
  assert.match(landing, /<link rel="canonical" href="https:\/\/zenflo\.co\.uk\/" \/>/);
  assert.match(landing, /<meta name="robots" content="index, follow/);
  assert.match(landing, /application\/ld\+json/);
  assert.match(landing, /"@type":"SoftwareApplication"/);
});

test('app shell is excluded from search results', () => {
  assert.match(appHtml, /<meta name="robots" content="noindex, nofollow" \/>/);
});

test('public host routing is not intercepted by the static index file', () => {
  assert.match(server, /express\.static\(path\.join\(__dirname, 'public'\), \{ index: false \}\)/);
  assert.match(server, /host === 'zenflo\.co\.uk'/);
});

test('crawler files point at the canonical homepage', () => {
  assert.match(read('public/robots.txt'), /Sitemap: https:\/\/zenflo\.co\.uk\/sitemap\.xml/);
  assert.match(read('public/sitemap.xml'), /<loc>https:\/\/zenflo\.co\.uk\/<\/loc>/);
});


test('PWA assets are wired into the private app shell', () => {
  assert.doesNotMatch(landing, /rel="manifest"/);
  assert.match(appHtml, /rel="manifest" href="\/manifest\.json"/);
  assert.match(appHtml, /serviceWorker\.register\("\/service-worker\.js"\)/);
  assert.equal(manifest.id, '/');
  assert.equal(manifest.scope, '/');
  assert.ok(manifest.icons.some(icon => icon.src === '/icons/zenflo-icon.svg'));
});

test('service worker excludes private API traffic from caching', () => {
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(worker, /offline\.html/);
});

test('account deletion is available in app and backend', () => {
  assert.match(appHtml, /onclick="deleteAccount\(\)"/);
  assert.match(server, /app\.delete\('\/api\/account'/);
  assert.match(server, /DELETE FROM users WHERE id=\$1/);
});
