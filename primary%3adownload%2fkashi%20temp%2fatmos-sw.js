// ATMOS MARKET — Service Worker
// Handles push notifications + offline caching

const CACHE = 'atmos-v1';
const VAPID_PUBLIC = 'BAiPyrblH1Gcdf3evvZfMMBAA__dhFKtKJpvAdxTz-5_fSC61MUXc5e_KnmqV4C-kE_wzGGbzI3zFJI-s7SMn0Q';

// ─── INSTALL / ACTIVATE ──────────────────────────────────
self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// ─── PUSH HANDLER ─────────────────────────────────────────
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'ATMOS', body: e.data?.text() || 'New notification' }; }

  const { title = 'ATMOS MARKET', body = '', type = 'default', url = '/' } = data;

  // Icon and badge vary by notification type
  const icons = {
    markets_open:  '📊',
    skew_alert:    '⚠️',
    lock_in:       '🔒',
    volume_spike:  '📈',
    default:       '⬡',
  };

  const options = {
    body,
    icon:   '/atmos-icon-192.png',
    badge:  '/atmos-badge-72.png',
    tag:    type,                     // collapses duplicate types
    renotify: type === 'skew_alert',  // re-notify on each skew update
    requireInteraction: type === 'markets_open' || type === 'skew_alert',
    vibrate: type === 'skew_alert' ? [200, 100, 200, 100, 400] : [200, 100, 200],
    data: { url, type },
    actions: type === 'markets_open'
      ? [{ action: 'open', title: 'Open Markets' }, { action: 'dismiss', title: 'Dismiss' }]
      : type === 'skew_alert'
      ? [{ action: 'open', title: 'View Position' }, { action: 'dismiss', title: 'Ignore' }]
      : [],
    silent: false,
    timestamp: Date.now(),
  };

  e.waitUntil(self.registration.showNotification(`${icons[type] || '⬡'} ${title}`, options));
});

// ─── NOTIFICATION CLICK ───────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();

  if (e.action === 'dismiss') return;

  const targetUrl = e.notification.data?.url || '/';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Focus existing tab if open
      for (const client of windowClients) {
        if (client.url.includes('atmos') && 'focus' in client) {
          client.focus();
          client.postMessage({ type: 'NOTIF_CLICK', notifType: e.notification.data?.type });
          return;
        }
      }
      // Otherwise open new tab
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ─── BACKGROUND SYNC (position monitoring) ────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'check-positions') {
    e.waitUntil(checkPositionsInBackground());
  }
});

async function checkPositionsInBackground() {
  // Called by background sync — checks Kalshi positions for skew
  // In production this would hit your backend which monitors positions
  try {
    const res = await fetch('/api/check-skew');
    if (res.ok) {
      const alerts = await res.json();
      for (const alert of alerts) {
        await self.registration.showNotification(`⚠️ SKEW ALERT`, {
          body: alert.message,
          tag: 'skew_alert',
          requireInteraction: true,
          vibrate: [200, 100, 200, 100, 400],
          data: { url: '/?tab=kalshi', type: 'skew_alert' },
        });
      }
    }
  } catch {}
}

// ─── MESSAGE HANDLER (from main app) ──────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data?.type === 'TEST_PUSH') {
    self.registration.showNotification('⬡ ATMOS TEST', {
      body: 'Push notifications are working on your device.',
      tag: 'test',
      vibrate: [200, 100, 200],
    });
  }
});
