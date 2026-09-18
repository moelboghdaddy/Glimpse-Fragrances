/**
 * Glimpse Analytics Tracker (tracker.js)
 * Automatically tracks:
 * - PAGE_VIEW on initial script execution
 * - DWELL_TIME using navigator.sendBeacon on page visibility change or unload
 * 
 * Provides API for custom events:
 * - window.GlimpseTracker.trackAddToCart(item)
 * - window.GlimpseTracker.trackPurchaseSuccess(order)
 * - window.GlimpseTracker.trackEvent(eventType, metadata)
 */
(function () {
  'use strict';

  const ENDPOINT = '/api/analytics/event';
  const SESSION_STORAGE_KEY = 'glimpse_analytics_session_id';

  // 1. Session ID Management (persists across page navigations in the current tab/session)
  function getOrCreateSessionId() {
    let sid = null;
    try {
      sid = sessionStorage.getItem(SESSION_STORAGE_KEY);
    } catch (e) {}

    if (!sid) {
      const rand = Math.random().toString(36).substring(2, 10);
      const time = Date.now().toString(36);
      sid = `s_${time}_${rand}`;
      try {
        sessionStorage.setItem(SESSION_STORAGE_KEY, sid);
      } catch (e) {}
    }
    return sid;
  }

  const sessionId = getOrCreateSessionId();
  const currentPage = window.location.pathname + window.location.search;

  // 2. Transport Utility (Prefers navigator.sendBeacon, falls back to keepalive fetch)
  function sendAnalytics(payload) {
    const bodyStr = JSON.stringify(payload);

    if (navigator.sendBeacon) {
      try {
        const blob = new Blob([bodyStr], { type: 'application/json' });
        const queued = navigator.sendBeacon(ENDPOINT, blob);
        if (queued) return true;
      } catch (err) {
        // Fall through to fetch
      }
    }

    if (window.fetch) {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyStr,
        keepalive: true
      }).catch(function () {});
      return true;
    }

    // Fallback: synchronous XMLHttpRequest as last resort during unload
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', ENDPOINT, false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(bodyStr);
      return true;
    } catch (e) {
      return false;
    }
  }

  // 3. Generic Event Tracking
  function trackEvent(eventType, metadata, extraFields) {
    const payload = Object.assign({
      eventType: eventType,
      sessionId: sessionId,
      page: currentPage,
      referrer: document.referrer || '',
      dwellTime: 0,
      metadata: metadata || {},
      timestamp: new Date().toISOString()
    }, extraFields || {});

    return sendAnalytics(payload);
  }

  // 4. Automatic PAGE_VIEW Tracking
  let pageViewLogged = false;
  function trackPageView() {
    if (pageViewLogged) return;
    pageViewLogged = true;

    trackEvent('PAGE_VIEW', {
      title: document.title,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      language: navigator.language || ''
    });
  }

  // 5. Automatic DWELL_TIME Tracking
  let sessionStartTime = Date.now();
  let accumulatedDwellSeconds = 0;
  let isCurrentlyVisible = !document.hidden;
  let dwellSent = false;

  function recordVisibleSegment() {
    if (isCurrentlyVisible) {
      const now = Date.now();
      const elapsed = Math.round((now - sessionStartTime) / 1000);
      if (elapsed > 0) {
        accumulatedDwellSeconds += elapsed;
      }
      sessionStartTime = now;
    }
  }

  function flushDwellTime() {
    recordVisibleSegment();
    if (accumulatedDwellSeconds < 1) return;

    trackEvent('DWELL_TIME', {
      totalSeconds: accumulatedDwellSeconds
    }, {
      dwellTime: accumulatedDwellSeconds
    });

    dwellSent = true;
    // Reset accumulated seconds after flush to prevent duplicate aggregation
    accumulatedDwellSeconds = 0;
  }

  // Handle visibility changes (tab switching or minimization)
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      isCurrentlyVisible = false;
      flushDwellTime();
    } else {
      isCurrentlyVisible = true;
      sessionStartTime = Date.now();
    }
  });

  // Handle page exit (closing tab, navigating away)
  window.addEventListener('pagehide', flushDwellTime);
  window.addEventListener('beforeunload', flushDwellTime);

  // 6. Specific E-Commerce Event Trackers
  function trackAddToCart(item) {
    return trackEvent('ADD_TO_CART', {
      id: item.id || '',
      name: item.name || '',
      price: item.price || 0,
      qty: item.qty || 1,
      image: item.image || ''
    });
  }

  function trackPurchaseSuccess(order) {
    return trackEvent('PURCHASE_SUCCESS', {
      orderNumber: order.orderNumber || '',
      subtotal: order.subtotal || 0,
      total: order.total || 0,
      currency: 'EGP',
      paymentMethod: order.paymentMethod || '',
      itemCount: Array.isArray(order.items) ? order.items.length : 0,
      items: order.items || [],
      customerName: order.customerName || '',
      phone: order.phone || ''
    });
  }

  // Expose Global Object
  window.GlimpseTracker = {
    sessionId: sessionId,
    trackEvent: trackEvent,
    trackPageView: trackPageView,
    trackAddToCart: trackAddToCart,
    trackPurchaseSuccess: trackPurchaseSuccess,
    flushDwellTime: flushDwellTime
  };

  // Trigger initial pageview
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', trackPageView);
  } else {
    trackPageView();
  }
})();
