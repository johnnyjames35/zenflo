'use strict';
// Server-only GA reporting. No credentials or raw report rows reach the browser.
const { createSign } = require('node:crypto');
const cache = new Map();
const pending = new Map();
let tokenCache;
const TTL = 5 * 60 * 1000;
const base64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function credentials() {
  try {
    const c = JSON.parse(process.env.GA_SERVICE_ACCOUNT_JSON || '{}');
    if (!c.client_email || !c.private_key) throw new Error();
    return c;
  } catch { throw new Error('Traffic reporting is not connected yet.'); }
}

async function accessToken(fetcher, now) {
  if (tokenCache && tokenCache.expires > now + 60000) return tokenCache.value;
  const c = credentials();
  const issued = Math.floor(now / 1000);
  const unsigned = base64({ alg: 'RS256', typ: 'JWT' }) + '.' + base64({
    iss: c.client_email, scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: issued, exp: issued + 3600,
  });
  const signature = createSign('RSA-SHA256').update(unsigned).sign(c.private_key, 'base64url');
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + signature }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Traffic reporting could not connect to Google Analytics.');
  const result = await response.json();
  if (!result.access_token) throw new Error('Traffic reporting could not connect to Google Analytics.');
  tokenCache = { value: result.access_token, expires: now + Math.min(Number(result.expires_in) || 3600, 3600) * 1000 };
  return tokenCache.value;
}

function reportRequests(hosts, now = Date.now()) {
  const endDate = new Date(now).toISOString().slice(0, 10);
  const excluded = '^/(admin|api|app|demo|team|discover|reset-password|accept-invite|delete-account)(/|$).*';
  return [1, 7, 30].map(days => ({
    dateRanges: [{ startDate: new Date(now - (days - 1) * 86400000).toISOString().slice(0, 10), endDate }],
    metrics: [{ name: 'totalUsers' }, { name: 'screenPageViews' }],
    dimensionFilter: { andGroup: { expressions: [
      { filter: { fieldName: 'hostName', inListFilter: { values: hosts, caseSensitive: false } } },
      { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'page_view' } } },
      { notExpression: { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'FULL_REGEXP', value: excluded } } } },
    ] } },
    limit: '1',
  }));
}

async function getTrafficSummary({ hosts, property = '532416392' }, deps = {}) {
  const now = deps.now ?? Date.now();
  const fetcher = deps.fetch || fetch;
  const key = property + ':' + hosts.join(',') + ':' + new Date(now).toISOString().slice(0, 10);
  if (cache.get(key)?.expires > now) return cache.get(key).value;
  if (pending.has(key)) return pending.get(key);
  const request = (async () => {
    try {
      const token = deps.token || await accessToken(fetcher, now);
      const requests = reportRequests(hosts, now);
      const response = await fetcher(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:batchRunReports`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }), signal: AbortSignal.timeout(15000),
      });
      if (response.status === 403) throw new Error('Google Analytics reporting access is not connected yet.');
      if (!response.ok) throw new Error('Traffic reporting is temporarily unavailable.');
      const result = await response.json();
      if (result.reports?.length !== 3) throw new Error('Traffic reporting is temporarily unavailable.');
      const periods = result.reports.map((report, i) => {
        if (report.metricHeaders?.map(h => h.name).join(',') !== 'totalUsers,screenPageViews') throw new Error('Traffic reporting is temporarily unavailable.');
        if (report.metadata?.timeZone && report.metadata.timeZone !== 'Etc/GMT' && report.metadata.timeZone !== 'UTC') {
          throw new Error('Traffic reporting timezone needs configuration.');
        }
        const values = report.rows?.[0]?.metricValues;
        if (values && (values.length !== 2 || values.some(v => !/^\d+$/.test(v.value)))) throw new Error('Traffic reporting is temporarily unavailable.');
        return { days: [1, 7, 30][i], ...requests[i].dateRanges[0], visitors: Number(values?.[0]?.value || 0), pageViews: Number(values?.[1]?.value || 0) };
      });
      const value = { available: true, source: 'Google Analytics', timezone: 'UTC', updatedAt: new Date(now).toISOString(), hosts, periods };
      cache.set(key, { expires: now + TTL, value });
      return value;
    } catch (error) {
      // Never echo Google's raw error or credentials into admin responses/logs.
      const message = /not connected yet|timezone needs configuration/.test(error.message) ? error.message : 'Traffic reporting is temporarily unavailable.';
      return { available: false, message };
    }
  })();
  pending.set(key, request);
  try { return await request; } finally { pending.delete(key); }
}

module.exports = { getTrafficSummary, reportRequests };

