const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const landing = read('public/landing.html');
const appHtml = read('public/index.html');
const server = read('server.js');

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
