/* 冷蔵庫アプリ サービスワーカー
 *
 * 目的はオフライン起動だけ。データはGAS側にあり、そちらはキャッシュしない。
 * アプリを更新したら CACHE の数字を上げること。
 */
const CACHE = 'fridge-v2';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
];

// 1つでも欠けていたら全部失敗する addAll は使わない。
// アイコンを上げ忘れてもオフライン起動だけは生き残るようにする。
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // GASへのAPI呼び出しには一切触らない
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // 画面はネットワーク優先（更新をすぐ拾う）。落ちていたらキャッシュを出す
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
