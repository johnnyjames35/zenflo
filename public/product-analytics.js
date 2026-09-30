/* Optional EU analytics: named events only; no customer or form values. */
(() => {
  'use strict';
  if (window.productAnalytics) return;
  const APP = 'zenflo';
  const EXTERNAL_CONSENT = APP === 'kelvori';
  const KEY = APP + '_posthog_consent_v1';
  const TOKEN = 'phc_ovuVHBwSAoYdhdA3p5KUVnMtXaFD8ikySHsNXfJNBshs';
  const EVENTS = new Set(['page_viewed','trial_click','signup_screen_viewed','signup_attempted','signup_failed','account_created','login_completed','checkout_started','setup_completed','assessment_started','assessment_completed']);
  const safe = fn => { try { return fn(); } catch (_) {} };
  let choice = EXTERNAL_CONSENT ? null : safe(() => localStorage.getItem(KEY));
  let sdk = null, loading = false, queue = [], lastPage = null;
  const permitted = () => choice === 'yes' && navigator.doNotTrack !== '1' && !navigator.globalPrivacyControl;
  const excluded = () => /\/(admin[^/]*|reset-password|accept-invite|delete-account)(?:[/.]|$)/.test(location.pathname);
  function cleanUrl(value) {
    try {
      const u = new URL(value, location.origin);
      // Dynamic workspace routes and identifiers never become analytics properties.
      let path = u.pathname.replace(/\/(app|dashboard|team)(?:\/.*)?$/, '/$1');
      path = path.replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, '/redacted');
      return u.origin + path;
    } catch (_) { return ''; }
  }
  function beforeSend(event) {
    if (!permitted() || excluded() || !event || (!EVENTS.has(event.event) && event.event !== '$snapshot')) return null;
    const keys = new Set(['token','distinct_id','$device_id','$session_id','$window_id','$lib','$lib_version','$insert_id','$process_person_profile','$snapshot_data','$snapshot_bytes']);
    const properties = {};
    for (const [key, value] of Object.entries(event.properties || {})) if (keys.has(key)) properties[key] = value;
    properties.app = APP;
    properties.$current_url = cleanUrl(location.href);
    properties.$pathname = new URL(properties.$current_url).pathname;
    properties.$geoip_disable = true;
    event.properties = properties;
    return event;
  }
  function capture(name) {
    if (!permitted() || excluded() || !EVENTS.has(name)) return;
    safe(() => { if (sdk) sdk.capture(name); else if (queue.length < 40) queue.push(name); });
  }
  function page() {
    const path = cleanUrl(location.href);
    if (excluded()) { safe(() => sdk?.stopSessionRecording()); return; }
    if (!permitted() || path === lastPage) return;
    lastPage = path;
    capture('page_viewed');
    if (APP === 'zenflo' && document.getElementById('auth-screen')?.style.display === 'flex' && document.getElementById('reg-form')?.style.display !== 'none') capture('signup_screen_viewed');
    if (/\/(signup|register|auth\/register)(?:\.html)?$/.test(location.pathname)) capture('signup_screen_viewed');
  }
  function start() {
    if (!permitted() || excluded() || sdk || loading) return;
    loading = true;
    const script = document.createElement('script');
    script.src = 'https://eu-assets.i.posthog.com/static/array.js';
    script.async = true;
    script.onerror = () => { loading = false; queue = []; lastPage = null; };
    script.onload = () => safe(() => {
      loading = false;
      if (!permitted() || excluded()) return;
      window.posthog.init(TOKEN, {
        api_host: 'https://eu.i.posthog.com', ui_host: 'https://eu.posthog.com',
        persistence: 'localStorage', persistence_name: APP + '_analytics',
        person_profiles: 'never', cross_subdomain_cookie: false, respect_dnt: true, ip: false,
        autocapture: false, capture_pageview: false, capture_pageleave: false,
        capture_performance: false, capture_dead_clicks: false, capture_heatmaps: false,
        capture_exceptions: false, rageclick: false, disable_surveys: true,
        disable_web_experiments: true, enable_recording_console_log: false,
        save_referrer: false, store_google: false, before_send: beforeSend,
        // Callback's private dashboard contains caller records. No replay there.
        disable_session_recording: APP === 'callback' && /\/(dashboard|setup)(?:\.html)?$/.test(location.pathname),
        session_recording: {
          maskAllInputs: true, maskTextSelector: '*',
          blockSelector: 'input,textarea,select,form,img,svg,canvas,video,audio,iframe,object,embed,script,[contenteditable],.ph-no-capture,[data-ph-private],[href*="?"],[href^="mailto:"],[href^="tel:"],#app-screen,#flash-msg,#auth-msg,#chat-widget,.zf-chat-panel,#zenflo-chat-widget',
          recordCrossOriginIframes: false, recordHeaders: false, recordBody: false,
          captureCanvas: { recordCanvas: false },
          maskCapturedNetworkRequestFn: request => ({ ...request, name: cleanUrl(request.name) })
        },
        loaded(instance) {
          if (!permitted() || excluded()) { instance.opt_out_capturing(); return; }
          sdk = instance;
          instance.opt_in_capturing({ captureEventName: null });
          const pending = queue; queue = [];
          for (const name of pending) capture(name);
        }
      });
    });
    document.head.appendChild(script);
  }
  function consent(value) {
    choice = value === true ? 'yes' : 'no';
    if (!EXTERNAL_CONSENT) safe(() => localStorage.setItem(KEY, choice));
    if (!permitted()) {
      queue = []; lastPage = null;
      safe(() => { sdk?.stopSessionRecording(); sdk?.opt_out_capturing(); });
    } else {
      safe(() => sdk?.opt_in_capturing({ captureEventName: null }));
      start(); page();
    }
  }
  window.productAnalytics = {
    capture, consent, page,
    reset() { queue = []; safe(() => sdk?.reset(true)); },
  };
  function ready() {
    if (!EXTERNAL_CONSENT && !excluded()) {
      const panel = document.createElement('section');
      panel.id = 'product-analytics-consent'; panel.setAttribute('aria-label', 'Optional analytics');
      panel.style.cssText = 'position:fixed;bottom:122px;left:16px;right:16px;max-width:620px;z-index:2147483646;padding:18px;background:#10232b;color:white;border-radius:12px;box-shadow:0 3px 18px #0005;font:14px/1.5 system-ui';
      panel.innerHTML = '<p>Allow optional product analytics and masked session replay to help improve this app? Data is processed by PostHog in the EU. Personal content is excluded. <a style="color:white;text-decoration:underline" href="/privacy-policy.html">Privacy details</a></p><button type="button" data-choice="yes">Allow</button> <button type="button" data-choice="no">No thanks</button>';
      panel.hidden = !!choice;
      panel.addEventListener('click', e => { const button = e.target.closest('[data-choice]'); if (!button) return; consent(button.dataset.choice === 'yes'); panel.hidden = true; });
      const choices = document.createElement('button');
      choices.type = 'button'; choices.textContent = 'Analytics choices';
      choices.style.cssText = 'position:fixed;bottom:74px;left:10px;z-index:2147483646;padding:8px 12px;border-radius:8px;background:#10232b;color:white;font:13px system-ui;cursor:pointer';
      choices.addEventListener('click', () => { panel.hidden = false; });
      document.body.append(panel, choices);
      start(); page();
    }
    window.dispatchEvent(new Event('product-analytics-ready'));
  }
  window.addEventListener('storage', e => { if (!EXTERNAL_CONSENT && e.key === KEY) consent(e.newValue === 'yes'); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true }); else ready();
})();
