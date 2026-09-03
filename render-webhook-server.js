// OFK3 Delivery App - Server (render-webhook-server.js)
// ZIP roundtrip test: encrypt-zip(zip20) -> decrypt-zip(unzipper) — both ZipCrypto, compatible
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const app = express();

app.use(express.json({ limit: '10mb' }));

// PDF一時保存用
var pdfStore = {};

// メンター通知済みドライバー管理（日次リセット）
var mentorNotified = { date: '', drivers: [] };

// body-parserでrawも受け取れるようにする
var multer;
try { multer = require('multer'); } catch(e) { multer = null; }
var pdfUpload = multer ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }) : null;

// /tenko-syncのみオリジンを限定する許可リスト。他の既存エンドポイントには影響しない。
const TENKO_SYNC_ALLOWED_ORIGINS = (function() {
  var origins = ['https://ofk3-line-proxy-1.onrender.com'];
  if (process.env.NODE_ENV !== 'production') {
    origins.push('http://localhost:3000', 'http://127.0.0.1:3000');
  }
  return origins;
})();

// CORS対応（/tenko-syncのみオリジン制限、他は既存どおり全許可のまま）
app.use((req, res, next) => {
  if (req.path === '/tenko-sync') {
    var origin = req.headers.origin;
    if (origin && TENKO_SYNC_ALLOWED_ORIGINS.indexOf(origin) >= 0) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Tenko-Sync-Token');
  } else {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') {
    return res.status(200).json({ status: 'ok' });
  }
  next();
});

const PORT = process.env.PORT || 3000;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const ADMIN_LINE_ID = process.env.ADMIN_LINE_ID;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const GAS_URL = process.env.GAS_URL || '';
console.log('GOOGLE_MAPS_API_KEY configured:', !!GOOGLE_MAPS_API_KEY);

// /tenko-sync認証トークン（Render環境変数）。未設定時はfail-closed（503）。
// 値そのものはログにも出さない。設定有無のみ起動時に表示する。
const TENKO_SYNC_TOKEN = process.env.TENKO_SYNC_TOKEN || '';
console.log('TENKO_SYNC_TOKEN configured:', !!TENKO_SYNC_TOKEN);

// /tenko-syncの認証チェック。true=認証OK、false=既にレスポンス済み（呼び出し側はreturnするだけでよい）
function checkTenkoSyncAuth(req, res) {
  if (!TENKO_SYNC_TOKEN) {
    res.status(503).json({ status: 'error', message: 'sync not configured' });
    return false;
  }
  var authHeader = req.headers['authorization'] || '';
  var bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
  var providedToken = (bearerMatch ? bearerMatch[1] : '') || req.headers['x-tenko-sync-token'] || '';
  if (!providedToken || providedToken !== TENKO_SYNC_TOKEN) {
    res.status(401).json({ status: 'error', message: 'unauthorized' });
    return false;
  }
  return true;
}

// 住所→座標キャッシュ（プロセス内、Renderでは再起動で消える）
const geocodeCache = {};

// 点呼同期ストア（プロセス内メモリが正。ファイルは単純な再起動からの復旧用ベストエフォートのバックアップで、
// Renderのディスクは再デプロイ時にリセットされるため永続保証はない。詳細はコード内コメント参照）
var tenkoSyncStore = null;
// driverDeltaの順序付けはクライアント時計(PCとタブレットの時計ズレの影響を受ける)ではなく、
// サーバー側で単調増加させるこのカウンタ(serverSeq)を各deltaに付与して行う。
var tenkoDeltaSeqCounter = 0;
// サーバー「世代」ID。再デプロイ等でtenkoDeltaSeqCounterが1に巻き戻ると、
// 端末側が保持する「前世代の大きなseq値」と比較して新しい更新を誤って古いと判定してしまう。
// これを避けるため、世代が変わるたびに新しいIDを発行し、端末側はID変化を検知したら
// 適用済みseqの追跡をリセットする（driverDB自体は削除しない）。
// ディスクバックアップから正常復元できた単純な再起動では同じIDを維持する。
var tenkoServerInstanceId = null;
var TENKO_SYNC_STORE_PATH = path.join(os.tmpdir(), 'tenko-sync-store.json');
(function loadTenkoSyncStoreFromDisk() {
  try {
    if (fs.existsSync(TENKO_SYNC_STORE_PATH)) {
      var loaded = JSON.parse(fs.readFileSync(TENKO_SYNC_STORE_PATH, 'utf8'));
      if (loaded && typeof loaded === 'object') {
        tenkoSyncStore = loaded;
        tenkoDeltaSeqCounter = loaded._deltaSeqCounter || 0;
        tenkoServerInstanceId = loaded._serverInstanceId || null;
        console.log('tenko-sync: restored from disk backup (' + TENKO_SYNC_STORE_PATH + ')');
      }
    }
  } catch (e) {
    console.warn('tenko-sync: disk backup restore failed (ignoring):', e.message);
  }
})();
if (!tenkoServerInstanceId) {
  tenkoServerInstanceId = crypto.randomBytes(12).toString('hex');
  console.log('tenko-sync: no valid prior generation found - starting new server instance generation');
}
function ensureTenkoSyncStore() {
  if (!tenkoSyncStore) {
    tenkoSyncStore = { schedule: [], date: getTodayJst(), notifyDisabled: {}, driverDeltas: [] };
  }
  tenkoSyncStore.serverInstanceId = tenkoServerInstanceId;
  return tenkoSyncStore;
}
function persistTenkoSyncStoreToDisk() {
  try {
    tenkoSyncStore._deltaSeqCounter = tenkoDeltaSeqCounter;
    tenkoSyncStore._serverInstanceId = tenkoServerInstanceId;
    fs.writeFileSync(TENKO_SYNC_STORE_PATH, JSON.stringify(tenkoSyncStore), 'utf8');
  } catch (e) {
    console.warn('tenko-sync: disk backup write failed (ignoring):', e.message);
  }
}

// 静的ファイル配信（index.html, logo.pngなど）
app.use(express.static(path.join(__dirname)));

// 簡易ログ（Render Dashboard → Logs で確認）
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ===== LINE通知 一時停止スイッチ（緊急対応） =====
// タブレット→PCの点呼同期が完全に安定するまで、LINEへの実送信のみを止めるための安全スイッチ。
// 点呼処理・QR認証・点呼データ保存・tenko-sync・driverDB・シフト等の他機能には一切影響しない。
//
// 停止/再開は、Renderの環境変数 LINE_NOTIFICATIONS_ENABLED を 'true' にするだけ（コード変更不要）。
// 未設定、または 'true' 以外の値の場合は「送信しない」がデフォルト＝安全側。
const LINE_NOTIFICATIONS_ENABLED = process.env.LINE_NOTIFICATIONS_ENABLED === 'true';
console.log('LINE_NOTIFICATIONS_ENABLED:', LINE_NOTIFICATIONS_ENABLED);

// LINE Messaging APIへの実送信は、必ずこの関数を経由させる（送信処理の唯一の入口）。
// フラグOFFの間はLINE APIを一切呼び出さず、個人情報やトークンを含まない簡易ログだけを残す。
async function sendLinePushMessage(to, messages) {
  if (!LINE_NOTIFICATIONS_ENABLED) {
    console.log('[LINE通知停止中] 送信をスキップしました');
    return { skipped: true };
  }
  return axios.post('https://api.line.me/v2/bot/message/push', {
    to: to,
    messages: messages
  }, {
    headers: {
      'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN,
      'Content-Type': 'application/json'
    }
  });
}

// JST日付ヘルパー（UTC+9補正）
function getTodayJst() {
  var now = new Date();
  var jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  var y = jst.getUTCFullYear();
  var m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  var d = String(jst.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// デプロイ確認用（Render が注入する RENDER_GIT_* + 診断JSの有無）
app.get('/deploy-info', (req, res) => {
  var assignSupportPath = path.join(__dirname, 'assign-support.js');
  var hasDebugFn = false;
  var assignSupportBytes = 0;
  try {
    var src = fs.readFileSync(assignSupportPath, 'utf8');
    assignSupportBytes = Buffer.byteLength(src, 'utf8');
    hasDebugFn = src.indexOf('debugTransportIdLink') >= 0;
  } catch (e) {
    /* ignore */
  }
  res.json({
    status: 'ok',
    gitCommit: process.env.RENDER_GIT_COMMIT || null,
    gitBranch: process.env.RENDER_GIT_BRANCH || null,
    gitRepo: process.env.RENDER_GIT_REPO_SLUG || null,
    nodeEnv: process.env.NODE_ENV || null,
    assignSupportBytes: assignSupportBytes,
    hasDebugTransportIdLink: hasDebugFn,
    expectedDiagCommitPrefix: '062a79b',
    serverTime: new Date().toISOString(),
  });
});

// Render無料プランのスリープ防止用
app.get('/ping', (req, res) => {
  log('ping received');
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// LINE Webhook受信
app.post('/webhook', async (req, res) => {
  try {
    log('=== Webhook received ===');
    log('Headers:', JSON.stringify(req.headers));
    log('Body:', JSON.stringify(req.body));

    const events = req.body.events || [];
    for (const event of events) {
      log('Event type:', event.type);
      log('Event source:', JSON.stringify(event.source));

      if (event.source && event.source.userId) {
        log('=== USER ID FOUND:', event.source.userId, '===');

        if (event.type === 'follow' && CHANNEL_ACCESS_TOKEN) {
          await sendWelcomeMessage(event.source.userId);
        }
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    log('Webhook error:', err.message || String(err));
    res.status(200).json({ status: 'ok' });
  }
});

// LINEプロフィール取得
app.get('/proxy', async (req, res) => {
  try {
    if (req.query.action !== 'getProfile') {
      return res.status(404).json({ status: 'error', message: 'Unknown action' });
    }

    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ status: 'error', message: 'userId required' });
    }

    if (!CHANNEL_ACCESS_TOKEN) {
      return res.status(500).json({ status: 'error', message: 'CHANNEL_ACCESS_TOKEN not configured' });
    }

    const response = await axios.get(
      'https://api.line.me/v2/bot/profile/' + encodeURIComponent(userId),
      {
        headers: {
          Authorization: 'Bearer ' + CHANNEL_ACCESS_TOKEN
        }
      }
    );

    res.json({
      status: 'ok',
      userId: userId,
      displayName: response.data.displayName,
      pictureUrl: response.data.pictureUrl || '',
      statusMessage: response.data.statusMessage || ''
    });
  } catch (err) {
    log('Profile error:', err.response && err.response.data ? err.response.data : err.message);
    res.status(500).json({
      status: 'error',
      message: err.response && err.response.data ? err.response.data : err.message
    });
  }
});

// 住所→緯度経度取得
app.get('/geocode', async (req, res) => {
  try {
    const address = req.query.address;
    if (!address) {
      return res.status(400).json({
        status: 'error',
        message: 'address required'
      });
    }

    // キャッシュヒット
    if (geocodeCache[address]) {
      return res.json({
        status: 'ok',
        lat: geocodeCache[address].lat,
        lng: geocodeCache[address].lng,
        cached: true
      });
    }

    const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(address) + '&key=' + GOOGLE_MAPS_API_KEY;
    const response = await axios.get(url);

    console.log('Google Geocode Response:');
    console.log(JSON.stringify(response.data, null, 2));

    if (response.data.status !== 'OK' || !response.data.results || response.data.results.length === 0) {
      return res.json({
        status: 'notfound',
        googleStatus: response.data.status,
        error: response.data.error_message || ''
      });
    }

    var loc = response.data.results[0].geometry.location;

    // キャッシュ保存
    geocodeCache[address] = {
      lat: loc.lat,
      lng: loc.lng
    };

    res.json({
      status: 'ok',
      lat: geocodeCache[address].lat,
      lng: geocodeCache[address].lng
    });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({
      status: 'error',
      message: e.message
    });
  }
});

// ルートデータ一時保存（LINE URL短縮用）
var routeDataStore = {};
app.post('/route-data', function(req, res) {
  var id = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
  routeDataStore[id] = { data: req.body, created: Date.now() };
  // 6時間後に自動削除
  setTimeout(function() { delete routeDataStore[id]; }, 21600000);
  res.json({ status: 'ok', id: id });
});

app.get('/route-data/:id', function(req, res) {
  var entry = routeDataStore[req.params.id];
  if (!entry) {
    return res.status(404).json({ status: 'error', message: 'not found or expired' });
  }
  res.json({ status: 'ok', data: entry.data });
});

// 住所マスターGASプロキシ（CORS回避）

// Static Maps画像プロキシ（LINE送信用）
app.get('/static-map', async (req, res) => {
  try {
    if (!GOOGLE_MAPS_API_KEY) {
      return res.status(500).json({ status: 'error', message: 'GOOGLE_MAPS_API_KEY not configured' });
    }
    var markers = req.query.markers || '';
    var size = req.query.size || '600x400';
    var zoom = req.query.zoom || '';
    var mapUrl = 'https://maps.googleapis.com/maps/api/staticmap?size=' + size + '&maptype=roadmap&language=ja&key=' + GOOGLE_MAPS_API_KEY;
    if (zoom) mapUrl += '&zoom=' + zoom;
    // markers can be multiple
    if (Array.isArray(markers)) {
      for (var i = 0; i < markers.length; i++) {
        mapUrl += '&markers=' + encodeURIComponent(markers[i]);
      }
    } else if (markers) {
      mapUrl += '&markers=' + encodeURIComponent(markers);
    }
    var response = await axios.get(mapUrl, { responseType: 'arraybuffer', timeout: 15000 });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(response.data));
  } catch (e) {
    console.error('static-map error:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

const ADDR_MASTER_GAS_URL = process.env.ADDR_MASTER_GAS_URL || '';
const VOLUME_MASTER_GAS_URL = process.env.VOLUME_MASTER_GAS_URL || '';
const TENKO_MASTER_GAS_URL = process.env.TENKO_MASTER_GAS_URL || '';
const AREA_EXPERIENCE_MASTER_GAS_URL = process.env.AREA_EXPERIENCE_MASTER_GAS_URL || '';

// 物量マスターGASプロキシ
app.get('/volume-master', async (req, res) => {
  try {
    if (!VOLUME_MASTER_GAS_URL) {
      return res.status(500).json({ status: 'error', message: 'VOLUME_MASTER_GAS_URL not configured' });
    }
    var qs = Object.keys(req.query).map(function(k) { return k + '=' + encodeURIComponent(req.query[k]); }).join('&');
    var url = VOLUME_MASTER_GAS_URL + '?' + qs;
    console.log('volume-master GET:', url);
    var response = await axios.get(url, { maxRedirects: 5, timeout: 120000 });
    if (typeof response.data === 'string' && response.data.indexOf('<!DOCTYPE') >= 0) {
      return res.status(502).json({ status: 'error', message: 'GAS returned HTML' });
    }
    res.json(response.data);
  } catch (e) {
    console.error('volume-master GET error:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/volume-master', async (req, res) => {
  try {
    if (!VOLUME_MASTER_GAS_URL) {
      return res.status(500).json({ status: 'error', message: 'VOLUME_MASTER_GAS_URL not configured' });
    }
    var action = req.query.action || '';
    var url = VOLUME_MASTER_GAS_URL + '?action=' + encodeURIComponent(action);
    console.log('volume-master POST:', url);
    var response = await axios.post(url, req.body, {
      headers: { 'Content-Type': 'application/json' },
      maxRedirects: 5,
      timeout: 120000,
      validateStatus: function() { return true; }
    });
    res.status(response.status).json(response.data);
  } catch (e) {
    console.error('volume-master POST error:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/addr-master', async (req, res) => {
  try {
    if (!ADDR_MASTER_GAS_URL) {
      return res.status(500).json({ status: 'error', message: 'ADDR_MASTER_GAS_URL not configured' });
    }
    var qs = Object.keys(req.query).map(function(k) { return k + '=' + encodeURIComponent(req.query[k]); }).join('&');
    var url = ADDR_MASTER_GAS_URL + '?' + qs;
    console.log('addr-master GET:', url);
    var response = await axios.get(url, { maxRedirects: 5, timeout: 120000 });
    // GASがHTMLを返した場合のエラーハンドリング
    if (typeof response.data === 'string' && response.data.indexOf('<!DOCTYPE') >= 0) {
      console.error('addr-master GET: GAS returned HTML instead of JSON');
      return res.status(502).json({ status: 'error', message: 'GAS returned HTML (possible error or auth issue)' });
    }
    console.log('addr-master GET response:', JSON.stringify(response.data).substring(0, 200));
    res.json(response.data);
  } catch (e) {
    console.error('addr-master GET error:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/addr-master', async (req, res) => {
  try {
    if (!ADDR_MASTER_GAS_URL) {
      return res.status(500).json({ status: 'error', message: 'ADDR_MASTER_GAS_URL not configured' });
    }
    var action = req.query.action || '';
    var url = ADDR_MASTER_GAS_URL + '?action=' + encodeURIComponent(action);
    console.log('addr-master POST:', url, 'body:', JSON.stringify(req.body).substring(0, 200));

    // GAS WebアプリはPOST時に302リダイレクトを返す。
    // axiosのリダイレクトフォローはPOST→GETに変換してしまうため、手動でリダイレクトをフォローする。
    var response = await axios.post(url, req.body, {
      headers: { 'Content-Type': 'application/json' },
      maxRedirects: 0,
      timeout: 55000,
      validateStatus: function(s) { return s < 400 || s === 302; }
    });

    // 302リダイレクトの場合、locationヘッダーのURLにPOSTし直す
    if (response.status === 302 && response.headers.location) {
      var redirectUrl = response.headers.location;
      console.log('addr-master POST redirect to:', redirectUrl);
      response = await axios.get(redirectUrl, {
        maxRedirects: 5,
        timeout: 55000,
        validateStatus: function() { return true; }
      });
    }

    console.log('addr-master POST response status:', response.status, 'data:', JSON.stringify(response.data).substring(0, 500));
    res.status(response.status).json(response.data);
  } catch (e) {
    console.error('===== ADDR MASTER ERROR =====');
    if (e.response) {
      console.error('Status:', e.response.status);
      console.error('Data:', e.response.data);
    }
    console.error('Message:', e.message);
    res.status(e.response && e.response.status ? e.response.status : 500).json({
      status: 'error',
      message: e.message,
      data: e.response && e.response.data ? e.response.data : null
    });
  }
});

// PDF一時アップロード（請求書送付用）
app.post('/pdf-upload', function(req, res) {
  // base64で受け取る方式
  var filename = req.body.filename || 'document.pdf';
  var base64 = req.body.data; // base64エンコードされたPDFデータ
  if (!base64) {
    return res.status(400).json({ status: 'error', message: 'data (base64) required' });
  }
  var id = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
  pdfStore[id] = { data: Buffer.from(base64, 'base64'), filename: filename, created: Date.now() };
  // 24時間後に自動削除
  setTimeout(function() { delete pdfStore[id]; }, 86400000);
  var downloadUrl = (req.protocol === 'https' ? 'https' : 'http') + '://' + req.get('host') + '/pdf/' + id;
  log('PDF uploaded:', filename, 'id:', id);
  res.json({ status: 'ok', id: id, url: downloadUrl });
});

app.get('/pdf/:id', function(req, res) {
  var entry = pdfStore[req.params.id];
  if (!entry) {
    return res.status(404).send('PDF not found or expired');
  }
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'inline; filename="' + encodeURIComponent(entry.filename) + '"');
  res.send(entry.data);
});

// LINE proxy（フロントエンドからの送信）

// メンターアラート — 方式B（前回Activeから消えたドライバー検知）
// Body: { disappeared: [{ driverId, name, shiftStartTime, elapsedMinutes }] }
var MENTOR_ADMIN_IDS = [
  'U48be7d67e979988a2298c2b9b8cb8035'
];
// ↑ テスト確認後に7人に戻す:
// 'U48be7d67e979988a2298c2b9b8cb8035',
// 'U9a1ce9f6f0c47b2a0e6d1f3c5a8b7d4e',
// 'U82d1a3b5c7e9f0d2a4b6c8e0f1a3b5d7',
// 'U6507d8e9f0a1b2c3d4e5f6a7b8c9d0e1',
// 'U2391a4b5c6d7e8f9a0b1c2d3e4f5a6b7',
// 'Uecc8d9e0f1a2b3c4d5e6f7a8b9c0d1e2',
// 'U45dfa1b2c3d4e5f6a7b8c9d0e1f2a3b4'

app.post('/mentor-alert', async (req, res) => {
  try {
    var now = new Date();
    var today = getTodayJst();
    var disappeared = req.body.disappeared || [];

    if (disappeared.length === 0) {
      return res.json({ status: 'ok', sent: 0, message: 'No disappeared drivers' });
    }

    // driverIdリストを作成
    var driverIds = [];
    for (var i = 0; i < disappeared.length; i++) {
      driverIds.push(disappeared[i].driverId);
    }

    // GASに一括チェック（当日既に通知済みか）
    var notifiedIds = [];
    if (GAS_URL) {
      try {
        var checkUrl = GAS_URL + '?action=batchCheck&date=' + encodeURIComponent(today) + '&ids=' + encodeURIComponent(driverIds.join(','));
        var checkRes = await axios.get(checkUrl, { timeout: 15000, maxRedirects: 5 });
        notifiedIds = (checkRes.data && checkRes.data.notifiedIds) || [];
        console.log('[mentor-alert] Already notified:', notifiedIds);
      } catch (e) {
        console.log('[mentor-alert] GAS check failed, proceeding anyway:', e.message);
      }
    }

    // 通知済みを除外
    var newDrivers = [];
    for (var i = 0; i < disappeared.length; i++) {
      if (notifiedIds.indexOf(disappeared[i].driverId) === -1) {
        newDrivers.push(disappeared[i]);
      }
    }

    if (newDrivers.length === 0) {
      console.log('[mentor-alert] All drivers already notified today, skipping.');
      return res.json({ status: 'ok', sent: 0, skipped: driverIds.length });
    }

    // GASに記録（送信前に記録して二重送信防止）
    var newIds = [];
    for (var i = 0; i < newDrivers.length; i++) {
      newIds.push(newDrivers[i].driverId);
    }
    if (GAS_URL) {
      try {
        var markUrl = GAS_URL + '?action=mark&date=' + encodeURIComponent(today) + '&ids=' + encodeURIComponent(newIds.join(','));
        await axios.get(markUrl, { timeout: 15000, maxRedirects: 5 });
        console.log('[mentor-alert] Marked as notified:', newIds);
      } catch (e) {
        console.log('[mentor-alert] GAS mark failed:', e.message);
      }
    }

    // 通知メッセージ生成
    var alertText = '\u26a0\ufe0f メンター早期停止検知\n\n';
    for (var i = 0; i < newDrivers.length; i++) {
      var d = newDrivers[i];
      var h = Math.floor(d.elapsedMinutes / 60);
      var m = d.elapsedMinutes % 60;
      alertText += d.name + '\n';
      alertText += '  稼働時間: ' + h + '時間' + m + '分（4時間未満で停止）\n';
    }

    // 全管理者にLINE送信
    var sent = 0;
    for (var i = 0; i < MENTOR_ADMIN_IDS.length; i++) {
      try {
        await sendLinePushMessage(MENTOR_ADMIN_IDS[i], [{ type: 'text', text: alertText }]);
        sent++;
      } catch (e) {
        console.log('[mentor-alert] LINE error for ' + MENTOR_ADMIN_IDS[i] + ':', e.response ? e.response.status : e.message);
      }
    }

    console.log('[mentor-alert] Sent to ' + sent + '/' + MENTOR_ADMIN_IDS.length + ' admins. Drivers: ' + newIds.join(', '));
    res.json({ status: 'ok', sent: sent, newDrivers: newIds });
  } catch (e) {
    console.error('[mentor-alert] Error:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// メンター通知済みドライバー取得・登録（レガシー）
app.get('/mentor-notified', (req, res) => {
  var today = getTodayJst();
  if (mentorNotified.date !== today) {
    mentorNotified = { date: today, drivers: [] };
  }
  res.json({ date: today, drivers: mentorNotified.drivers });
});

app.post('/mentor-notified', (req, res) => {
  var today = getTodayJst();
  if (mentorNotified.date !== today) {
    mentorNotified = { date: today, drivers: [] };
  }
  var newDrivers = req.body.drivers || [];
  for (var i = 0; i < newDrivers.length; i++) {
    if (mentorNotified.drivers.indexOf(newDrivers[i]) === -1) {
      mentorNotified.drivers.push(newDrivers[i]);
    }
  }
  res.json({ date: today, drivers: mentorNotified.drivers });
});

const PROXY_SECRET = process.env.PROXY_SECRET || '';

app.post('/proxy', async (req, res) => {
  try {
    // 簡易認証: PROXY_SECRET設定時のみチェック
    if (PROXY_SECRET && req.headers['x-proxy-secret'] !== PROXY_SECRET) {
      return res.status(403).json({ status: 'error', message: 'Forbidden' });
    }
    const { to, messages } = req.body;
    if (!to || !messages || !Array.isArray(messages)) {
      return res.status(400).json({ status: 'error', message: 'Invalid payload' });
    }

    const target = to === '__admin__' ? ADMIN_LINE_ID : to;
    if (!target) {
      return res.status(400).json({ status: 'error', message: 'Target not found' });
    }

    // デバッグ: LINE送信ペイロードをログ
    console.log('===== LINE PUSH PAYLOAD =====');
    console.log('to:', target);
    console.log('messages count:', messages.length);
    for (var mi = 0; mi < messages.length; mi++) {
      console.log('messages[' + mi + ']:', JSON.stringify(messages[mi]).substring(0, 500));
    }

    const result = await sendLinePushMessage(target, messages);
    if (result && result.skipped) {
      return res.json({ status: 'ok', lineSkipped: true });
    }

    log('LINE push success:', target, result.status);
    res.json({ status: 'ok', lineStatus: result.status });
  } catch (err) {
    console.error('===== LINE PUSH ERROR =====');
    console.error('Error details:', JSON.stringify(err.response && err.response.data ? err.response.data : err.message, null, 2));
    res.status(502).json({ status: 'error', lineBody: err.response && err.response.data ? err.response.data : null, message: err.message });
  }
});

async function sendWelcomeMessage(userId) {
  try {
    const result = await sendLinePushMessage(userId, [{ type: 'text', text: '友だち追加ありがとうございます。\n配送通知の設定は管理者画面から行ってください。' }]);
    if (!(result && result.skipped)) {
      log('Welcome message sent to', userId);
    }
  } catch (err) {
    log('Welcome message error:', err.response?.data || err.message);
  }
}

// ===== WH60 自動アラート =====
var wh60AlertData = []; // [{ tid, name, dsp, weekTotal, remaining, returnLimit, lineId, date }]
var wh60SentAlerts = {}; // { "tid_date_type": true } — 重複送信防止

// フロントからWH60データ保存
app.post('/wh60/save', (req, res) => {
  try {
    var data = req.body;
    if (!data || !Array.isArray(data.drivers)) {
      return res.status(400).json({ error: 'drivers array required' });
    }
    wh60AlertData = data.drivers;
    wh60SentAlerts = {}; // 新データで送信済みリセット
    log('WH60 alert data saved: ' + wh60AlertData.length + ' drivers');
    res.json({ status: 'ok', count: wh60AlertData.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// WH60データ確認用
app.get('/wh60/status', (req, res) => {
  res.json({
    status: 'ok',
    driverCount: wh60AlertData.length,
    sentAlerts: Object.keys(wh60SentAlerts).length,
    lastCheck: wh60LastCheck || null
  });
});

var wh60LastCheck = null;

function wh60AutoCheck() {
  if (wh60AlertData.length === 0) return;
  var now = new Date();
  var nowMin = now.getHours() * 60 + now.getMinutes();
  var today = getTodayJst();
  wh60LastCheck = now.toISOString();

  var dangerDAs = [];
  var reminderDAs = [];

  for (var i = 0; i < wh60AlertData.length; i++) {
    var da = wh60AlertData[i];
    var remaining = parseFloat(da.remaining) || 60;
    var returnLimit = da.returnLimit || '--:--';

    // 危険アラート（残り≤12.5h、1回だけ送信）
    if (remaining <= 12.5) {
      var dangerKey = da.tid + '_' + today + '_danger';
      if (!wh60SentAlerts[dangerKey]) {
        dangerDAs.push(da);
        wh60SentAlerts[dangerKey] = true;
      }
    }

    // 帰庫1時間前リマインド
    if (returnLimit !== '--:--' && returnLimit !== '超過！' && remaining > 0 && remaining <= 12.5) {
      var parts = returnLimit.split(':');
      var limitMin = parseInt(parts[0]) * 60 + parseInt(parts[1]);
      var diff = limitMin - nowMin;
      if (diff >= -5 && diff <= 65) {
        var reminderKey = da.tid + '_' + today + '_reminder';
        if (!wh60SentAlerts[reminderKey]) {
          reminderDAs.push(da);
          wh60SentAlerts[reminderKey] = true;
        }
      }
    }
  }

  // 危険アラート送信
  if (dangerDAs.length > 0) {
    var adminMsg = '【WH60超過危険アラート（自動）】\n';
    for (var i = 0; i < dangerDAs.length; i++) {
      var d = dangerDAs[i];
      var rh = Math.floor(d.remaining);
      var rm = Math.round((d.remaining - rh) * 60);
      adminMsg += '\n' + d.name + '（' + (d.dsp || '') + '）\n';
      adminMsg += '  残り: ' + rh + ':' + String(rm).padStart(2, '0') + ' / 帰庫リミット: ' + (d.returnLimit || '--:--') + '\n';
    }
    wh60SendLine(ADMIN_LINE_ID || 'U48be7d67e979988a2298c2b9b8cb8035', adminMsg);

    // 個別DA送信
    for (var i = 0; i < dangerDAs.length; i++) {
      var d = dangerDAs[i];
      if (!d.lineId) continue;
      var rh = Math.floor(d.remaining);
      var rm = Math.round((d.remaining - rh) * 60);
      var msg = '【60時間超過危険】\n' + d.name + 'さん\n\n';
      msg += '今週の稼働: ' + Math.floor(60 - d.remaining) + ':' + String(Math.round(((60 - d.remaining) % 1) * 60)).padStart(2, '0') + '\n';
      msg += '残り: ' + rh + ':' + String(rm).padStart(2, '0') + '\n';
      msg += '帰庫リミット: ' + (d.returnLimit || '--:--') + '\n\n';
      msg += '超過しないよう早めの帰庫をお願いします。';
      wh60SendLine(d.lineId, msg);
    }
    log('WH60 danger alerts sent: ' + dangerDAs.length + ' drivers');
  }

  // 帰庫1時間前リマインド送信
  if (reminderDAs.length > 0) {
    var adminMsg2 = '【帰庫リマインド（自動）】\n';
    for (var i = 0; i < reminderDAs.length; i++) {
      adminMsg2 += reminderDAs[i].name + '（' + (reminderDAs[i].dsp || '') + '）→ ' + reminderDAs[i].returnLimit + ' 帰庫必須\n';
    }
    wh60SendLine(ADMIN_LINE_ID || 'U48be7d67e979988a2298c2b9b8cb8035', adminMsg2);

    for (var i = 0; i < reminderDAs.length; i++) {
      var t = reminderDAs[i];
      if (!t.lineId) continue;
      var rh2 = Math.floor(t.remaining);
      var rm2 = Math.round((t.remaining - rh2) * 60);
      var msg2 = '【帰庫リマインド】\n' + t.name + 'さん\n\n';
      msg2 += '帰庫リミット: ' + t.returnLimit + '\n';
      msg2 += '残り稼働可能: ' + rh2 + ':' + String(rm2).padStart(2, '0') + '\n\n';
      msg2 += '60時間超過防止のため、帰庫時刻を意識して行動してください。';
      wh60SendLine(t.lineId, msg2);
    }
    log('WH60 reminder alerts sent: ' + reminderDAs.length + ' drivers');
  }
}

async function wh60SendLine(to, text) {
  if (!to || !CHANNEL_ACCESS_TOKEN) return;
  try {
    await sendLinePushMessage(to, [{ type: 'text', text: text }]);
  } catch (err) {
    log('WH60 LINE send error:', err.response ? err.response.data : err.message);
  }
}

// 10分ごとに自動チェック
setInterval(wh60AutoCheck, 10 * 60 * 1000);
log('WH60 auto-alert started (every 10 min)');

// ===== エリア経験マスタ GASプロキシ =====
app.get('/area-experience-master', async (req, res) => {
  try {
    if (!AREA_EXPERIENCE_MASTER_GAS_URL) {
      return res.status(500).json({ status: 'error', message: 'AREA_EXPERIENCE_MASTER_GAS_URL not configured' });
    }
    var qs = Object.keys(req.query).map(function(k) { return k + '=' + encodeURIComponent(req.query[k]); }).join('&');
    var url = AREA_EXPERIENCE_MASTER_GAS_URL + '?' + qs;
    console.log('area-experience-master GET:', url);
    var response = await axios.get(url, { maxRedirects: 5, timeout: 120000 });
    if (typeof response.data === 'string' && response.data.indexOf('<!DOCTYPE') >= 0) {
      return res.status(502).json({ status: 'error', message: 'GAS returned HTML' });
    }
    res.json(response.data);
  } catch (e) {
    console.error('area-experience-master GET error:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/area-experience-master', async (req, res) => {
  try {
    if (!AREA_EXPERIENCE_MASTER_GAS_URL) {
      return res.status(500).json({ status: 'error', message: 'AREA_EXPERIENCE_MASTER_GAS_URL not configured' });
    }
    var action = req.query.action || 'save';
    var url = AREA_EXPERIENCE_MASTER_GAS_URL + '?action=' + encodeURIComponent(action);
    console.log('area-experience-master POST:', url, 'records:', req.body && req.body.records ? req.body.records.length : 0);
    var response = await axios.post(url, req.body, {
      headers: { 'Content-Type': 'application/json' },
      maxRedirects: 5,
      timeout: 120000,
      validateStatus: function() { return true; }
    });
    res.status(response.status).json(response.data);
  } catch (e) {
    console.error('area-experience-master POST error:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ===== 点呼マスタ＋ログ GASプロキシ =====
app.get('/tenko-master', async (req, res) => {
  try {
    if (!TENKO_MASTER_GAS_URL) {
      return res.status(500).json({ status: 'error', message: 'TENKO_MASTER_GAS_URL not configured' });
    }
    var qs = Object.keys(req.query).map(function(k) { return k + '=' + encodeURIComponent(req.query[k]); }).join('&');
    var url = TENKO_MASTER_GAS_URL + '?' + qs;
    console.log('tenko-master GET:', url);
    var response = await axios.get(url, { maxRedirects: 5, timeout: 30000 });
    if (typeof response.data === 'string' && response.data.indexOf('<') >= 0) {
      return res.status(502).json({ status: 'error', message: 'GAS returned HTML' });
    }
    res.json(response.data);
  } catch (e) {
    console.error('tenko-master GET error:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/tenko-master', async (req, res) => {
  try {
    if (!TENKO_MASTER_GAS_URL) {
      return res.status(500).json({ status: 'error', message: 'TENKO_MASTER_GAS_URL not configured' });
    }

    // saveMasterアクションの場合、ローカルにバックアップを保存
    if (req.body && req.body.action === 'saveMaster' && Array.isArray(req.body.drivers)) {
      try {
        var now = new Date();
        var pad2 = function(n) { return String(n).padStart(2, '0'); };
        var backupName = 'master_' + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) + '_' + pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds()) + '.json';
        var backupPath = path.join(os.tmpdir(), backupName);
        fs.writeFileSync(backupPath, JSON.stringify(req.body.drivers, null, 2), 'utf8');
        log('Master backup saved: ' + backupPath + ' (' + req.body.drivers.length + ' drivers)');
      } catch (backupErr) {
        log('Master backup error: ' + backupErr.message);
      }
    }

    var url = TENKO_MASTER_GAS_URL;
    console.log('tenko-master POST:', JSON.stringify(req.body).substring(0, 200));

    var response = await axios.post(url, req.body, {
      headers: { 'Content-Type': 'application/json' },
      maxRedirects: 0,
      timeout: 55000,
      validateStatus: function(s) { return s < 400 || s === 302; }
    });

    if (response.status === 302 && response.headers.location) {
      var redirectUrl = response.headers.location;
      console.log('tenko-master POST redirect to:', redirectUrl);
      response = await axios.get(redirectUrl, {
        maxRedirects: 5,
        timeout: 55000,
        validateStatus: function() { return true; }
      });
    }

    console.log('tenko-master POST response:', response.status, JSON.stringify(response.data).substring(0, 300));
    res.status(response.status).json(response.data);
  } catch (e) {
    console.error('tenko-master POST error:', e.message);
    if (e.response) {
      console.error('Status:', e.response.status, 'Data:', e.response.data);
    }
    res.status(e.response && e.response.status ? e.response.status : 500).json({
      status: 'error',
      message: e.message
    });
  }
});

// ===== 点呼データ同期 =====
app.post('/tenko-sync', function(req, res) {
  if (!checkTenkoSyncAuth(req, res)) return;
  try {
    log('tenko-sync POST received');
    var today = getTodayJst();
    ensureTenkoSyncStore();
    if (req.body.schedule !== undefined) {
      tenkoSyncStore.schedule = req.body.schedule || [];
      tenkoSyncStore.date = req.body.date || today;
    }
    // 点呼アラートの解除/有効化状態を端末間で共有。updatedAtが新しい方を採用するlast-write-wins
    // （解除だけでなく再有効化も伝播するため、誤解除した端末を別端末から復旧できる）
    if (req.body.notifyDisabled && typeof req.body.notifyDisabled === 'object') {
      tenkoSyncStore.notifyDisabled = tenkoSyncStore.notifyDisabled || {};
      for (var ndKey in req.body.notifyDisabled) {
        var incomingRec = req.body.notifyDisabled[ndKey];
        if (!incomingRec || typeof incomingRec.updatedAt !== 'number') continue;
        var existingRec = tenkoSyncStore.notifyDisabled[ndKey];
        if (!existingRec || incomingRec.updatedAt > existingRec.updatedAt) {
          tenkoSyncStore.notifyDisabled[ndKey] = incomingRec;
        }
      }
      // 2日以上前の解除情報は判定上は無害だが無期限に増え続けないよう間引く
      var notifyCutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
      for (var pruneKey in tenkoSyncStore.notifyDisabled) {
        if (tenkoSyncStore.notifyDisabled[pruneKey].updatedAt < notifyCutoff) {
          delete tenkoSyncStore.notifyDisabled[pruneKey];
        }
      }
    }
    // 新規登録ドライバー等のマスタ差分を端末間で共有（直近200件まで保持、無期限増加を防止）
    // 各deltaにサーバー採番のserverSeqを付与（クライアント時計に依存しない、クロックスキュー耐性のある順序付け）
    if (Array.isArray(req.body.driverDeltas) && req.body.driverDeltas.length > 0) {
      tenkoSyncStore.driverDeltas = tenkoSyncStore.driverDeltas || [];
      for (var dj = 0; dj < req.body.driverDeltas.length; dj++) {
        var incomingDelta = req.body.driverDeltas[dj];
        if (!incomingDelta || !incomingDelta.name) continue;
        tenkoDeltaSeqCounter += 1;
        var stamped = {
          name: incomingDelta.name,
          driverId: incomingDelta.driverId || '',
          transportId: incomingDelta.transportId || '',
          japaneseName: incomingDelta.japaneseName || '',
          company: incomingDelta.company || '',
          updatedAt: typeof incomingDelta.updatedAt === 'number' ? incomingDelta.updatedAt : null,
          serverSeq: tenkoDeltaSeqCounter,
          serverInstanceId: tenkoServerInstanceId
        };
        tenkoSyncStore.driverDeltas.push(stamped);
      }
      if (tenkoSyncStore.driverDeltas.length > 200) {
        tenkoSyncStore.driverDeltas = tenkoSyncStore.driverDeltas.slice(-200);
      }
    }
    tenkoSyncStore.timestamp = Date.now();
    tenkoSyncStore.source = req.body.source || tenkoSyncStore.source || 'unknown';
    persistTenkoSyncStoreToDisk();
    log('tenko-sync saved: ' + tenkoSyncStore.schedule.length + ' drivers for ' + tenkoSyncStore.date +
      ' / notifyDisabled=' + Object.keys(tenkoSyncStore.notifyDisabled || {}).length +
      ' / driverDeltas=' + (tenkoSyncStore.driverDeltas || []).length);
    res.json({ status: 'ok', count: tenkoSyncStore.schedule.length, timestamp: tenkoSyncStore.timestamp });
  } catch (e) {
    log('tenko-sync POST error: ' + e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/tenko-sync', function(req, res) {
  if (!checkTenkoSyncAuth(req, res)) return;
  if (!tenkoSyncStore) {
    return res.json({ status: 'empty', serverInstanceId: tenkoServerInstanceId });
  }
  var since = parseInt(req.query.since) || 0;
  if (since && tenkoSyncStore.timestamp <= since) {
    return res.json({ status: 'no_update', serverInstanceId: tenkoServerInstanceId });
  }
  res.json({ status: 'ok', data: tenkoSyncStore });
});

// ===== パスワード付きZIPエンドポイント =====
// 起動時に重いライブラリで落ちないよう、エンドポイント呼び出し時に遅延ロード
var zipModuleCache = null;
var zipMulterCache = null;

function getZipModules() {
  if (zipModuleCache) return zipModuleCache;
  try {
    var archiver = require('archiver');
    var EncryptedFormat = require('archiver-zip-encrypted');
    archiver.registerFormat('zip-encrypted', EncryptedFormat);
    zipModuleCache = archiver;
    log('archiver-zip-encrypted registered lazily');
  } catch (e) {
    log('archiver-zip-encrypted lazy init failed: ' + e.message);
    zipModuleCache = null;
  }
  return zipModuleCache;
}

function getZipMulter() {
  if (zipMulterCache) return zipMulterCache;
  try {
    var multerLib = require('multer');
    zipMulterCache = multerLib({ storage: multerLib.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  } catch (e) {
    log('multer lazy init failed: ' + e.message);
    zipMulterCache = null;
  }
  return zipMulterCache;
}

app.post('/encrypt-zip', function(req, res) {
  var encryptedArchiver = getZipModules();
  var zipMulter = getZipMulter();
  if (!encryptedArchiver || !zipMulter) {
    return res.status(500).json({ error: 'server modules not ready' });
  }

  zipMulter.single('file')(req, res, function(err) {
    if (err) {
      log('multer error: ' + (err.message || JSON.stringify(err)));
      return res.status(400).json({ error: err.message || 'upload error' });
    }

    try {
      var file = req.file;
      var password = (req.body && req.body.password) ? String(req.body.password) : '';
      var filename = (req.body && req.body.filename) ? String(req.body.filename) : 'document.pdf';

      if (!file) return res.status(400).json({ error: 'file required' });
      if (!password || password.length < 4) return res.status(400).json({ error: 'password required (4+ chars)' });

      var zipName = filename.replace(/\.[^.]+$/, '') + '.zip';
      // Content-Dispositionのfilenameを安全にエンコード（日本語対応）
      var encodedZipName = encodeURIComponent(zipName);

      var archive = encryptedArchiver.create('zip-encrypted', {
        zlib: { level: 8 },
        encryptionMethod: 'zip20',
        password: password
      });

      var errorSent = false;

      archive.on('warning', function(warn) {
        log('ZIP warning: ' + (warn.message || warn));
      });

      archive.on('error', function(err) {
        if (errorSent) return;
        errorSent = true;
        log('ZIP archive error: ' + (err.message || err));
        if (!res.headersSent) res.status(500).json({ error: err.message || 'archive error' });
        try { archive.unpipe(res); } catch(e) {}
      });

      archive.on('end', function() {
        log('ZIP finalized: ' + zipName);
      });

      try {
        res.set({
          'Content-Type': 'application/zip',
          'Content-Disposition': "attachment; filename*=UTF-8''" + encodedZipName
        });
        archive.pipe(res);
        archive.append(Buffer.from(file.buffer), { name: filename });
        archive.finalize();
      } catch(e) {
        log('ZIP finalize error: ' + e.message);
        if (!res.headersSent) res.status(500).json({ error: e.message });
      }
    } catch(e) {
      log('ZIP endpoint error: ' + e.message + '\\n' + e.stack);
      if (!res.headersSent) {
        res.status(500).json({ error: e.message, stack: e.stack });
      }
    }
  });
});

// ===== パスワードZIP復号 =====
var unzipperCache = null;
function getUnzipper() {
  if (unzipperCache) return unzipperCache;
  try {
    unzipperCache = require('unzipper');
    log('unzipper loaded lazily');
  } catch (e) {
    log('unzipper lazy init failed: ' + e.message);
    unzipperCache = null;
  }
  return unzipperCache;
}

app.post('/decrypt-zip', function(req, res) {
  var zipMulter = getZipMulter();
  if (!zipMulter) {
    return res.status(500).json({ error: 'server modules not ready' });
  }

  zipMulter.single('file')(req, res, function(err) {
    if (err) {
      log('decrypt-zip multer error: ' + (err.message || JSON.stringify(err)));
      return res.status(400).json({ error: err.message || 'upload error' });
    }

    var unzipLib = getUnzipper();
    if (!unzipLib) {
      return res.status(500).json({ error: 'unzipper module not available' });
    }

    try {
      var file = req.file;
      var password = (req.body && req.body.password) ? String(req.body.password) : '';
      var mode = (req.body && req.body.mode) ? String(req.body.mode) : 'download';

      if (!file) return res.status(400).json({ error: 'file required' });
      if (!password) return res.status(400).json({ error: 'password required' });

      var bufferStream = require('stream').Readable.from(file.buffer);

      if (mode === 'list') {
        var fileList = [];
        bufferStream
          .pipe(unzipLib.Parse({ password: password }))
          .on('entry', function(entry) {
            fileList.push({ path: entry.path, type: entry.type, size: entry.vars && entry.vars.uncompressedSize || 0 });
            entry.autodrain();
          })
          .on('close', function() {
            res.json({ files: fileList });
          })
          .on('error', function(e) {
            log('decrypt-zip list error: ' + e.message);
            if (!res.headersSent) res.status(400).json({ error: 'ZIP展開に失敗しました。パスワードを確認してください。' });
          });
      } else {
        var targetFile = (req.body && req.body.targetFile) ? String(req.body.targetFile) : '';
        var found = false;

        bufferStream
          .pipe(unzipLib.Parse({ password: password }))
          .on('entry', function(entry) {
            if (entry.type === 'Directory') {
              entry.autodrain();
              return;
            }
            if (!found && (!targetFile || entry.path === targetFile)) {
              found = true;
              var entryName = entry.path.split('/').pop() || 'file';
              var encodedName = encodeURIComponent(entryName);
              res.set({
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': "attachment; filename*=UTF-8''" + encodedName
              });
              entry.pipe(res);
            } else {
              entry.autodrain();
            }
          })
          .on('close', function() {
            if (!found && !res.headersSent) {
              res.status(404).json({ error: 'ファイルが見つかりません' });
            }
          })
          .on('error', function(e) {
            log('decrypt-zip error: ' + e.message);
            if (!res.headersSent) res.status(400).json({ error: 'ZIP展開に失敗しました。パスワードを確認してください。' });
          });
      }
    } catch(e) {
      log('decrypt-zip endpoint error: ' + e.message);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });
});

// ===== FTDS Excel解析API（n8n連携用） =====
// index.htmlの既存FTDS処理（normalizeReportHeader/isTransporterHeader/mapAnalysisHeaderColumns/
// findAnalysisHeaderRow/findReportSheet/processFtdsData/parseReasonBreakdownPipe/REASON_JA/
// translateReason/exportFtdsResult、index.html内 15701-16574行・18243-18327行付近）と
// 同じ判定・変換・集計・出力仕様をNode側に移植したもの。index.html側のロジックは無変更。
// ドライバーマスタは既存の GET /tenko-master?action=getMaster をサーバー内部から呼び出して取得する
// （/tenko-masterルート自体は無変更）。

const FTDS_API_TOKEN = process.env.FTDS_API_TOKEN || '';
console.log('FTDS_API_TOKEN configured:', !!FTDS_API_TOKEN);

// /ftds-exportの認証チェック。true=認証OK、false=既にレスポンス済み（呼び出し側はreturnするだけでよい）
// /tenko-syncのcheckTenkoSyncAuthと同じfail-closed方針（未設定時503、不一致時401）
function checkFtdsApiAuth(req, res) {
  if (!FTDS_API_TOKEN) {
    res.status(503).json({ status: 'error', message: 'FTDS_API_TOKEN not configured' });
    return false;
  }
  var provided = req.headers['x-ftds-api-token'] || '';
  if (!provided || provided !== FTDS_API_TOKEN) {
    res.status(401).json({ status: 'error', message: 'unauthorized' });
    return false;
  }
  return true;
}

// xlsxライブラリの遅延読込（archiver-zip-encrypted/unzipperと同じ遅延require方式）
var xlsxLibCache = null;
function getXlsxLib() {
  if (xlsxLibCache) return xlsxLibCache;
  try {
    xlsxLibCache = require('xlsx');
  } catch (e) {
    log('xlsx lazy init failed: ' + e.message);
    xlsxLibCache = null;
  }
  return xlsxLibCache;
}

// --- 列名判定（index.html: normalizeReportHeader/isTransporterHeader/mapAnalysisHeaderColumns の
//     FTDS該当部分を移植。CC専用列(ベき架電/実架電/通話時間等)は本APIの対象外のため含めない） ---
function ftdsNormalizeHeader(h) {
  return String(h || '').replace(/^﻿/, '').toLowerCase().trim().replace(/[\s_]+/g, ' ');
}
function ftdsIsTransporterHeader(h) {
  var n = ftdsNormalizeHeader(h);
  var compact = n.replace(/\s/g, '');
  return n === 'transporter id' || n === 'transporter_id' || compact === 'transporterid' || compact === 'transportid';
}
function ftdsMapHeaderColumns(headerRow) {
  var cols = {};
  for (var i = 0; i < headerRow.length; i++) {
    var h = ftdsNormalizeHeader(headerRow[i]);
    var raw = String(headerRow[i] || '').trim();
    if (ftdsIsTransporterHeader(raw)) cols.tid = i;
    else if (h.indexOf('ドライバ') >= 0 || h.indexOf('driver') >= 0) cols.driver = i;
    else if (h.indexOf('件数合計') >= 0) cols.count = i;
    else if ((h === '件数' || h.indexOf('件数') >= 0) && cols.count === undefined) cols.count = i;
    else if (h === 'カウント' && cols.count === undefined) cols.count = i; // Amazon生データの「カウント」列（修正1件目: 件数列として認識）
    else if (h.indexOf('日付') >= 0) cols.date = i;
    else if ((h === 'event_date' || h === 'event date') && cols.date === undefined) cols.date = i; // 修正1件目: event_dateを日付列として認識（既存の「日付」列より優先度は下げる）
    else if (h.indexOf('失敗理由') >= 0 && h.indexOf('内訳') >= 0) cols.reasonBreakdown = i;
    else if (h.indexOf('理由内訳') >= 0) cols.reasonBreakdown = i;
    else if (h.indexOf('対象週') >= 0) cols.weekCount = i;
    else if (h === 'failure reason' || h === 'failure_reason') cols.reason = i;
    else if (h === 'cycle name' || h === 'cycle_name') cols.cycle = i;
    else if (h === 'route code' || h === 'route_code') cols.route = i;
    else if (h === 'tracking id' || h === 'tracking_id') cols.tracking = i;
    else if (h === 'scannable id' || h === 'scannable_id') cols.tracking = i;
    else if (h.indexOf('postal') >= 0 || h === 'zip') cols.zip = i;
    else if (h === 'shipment reason' || h === 'shipment_reason') cols.reason = i;
    else if (h === 'ship method' || h === 'ship_method') cols.method = i;
  }
  return cols;
}

// index.html: findAnalysisHeaderRow(rows, 'ftds') のftds分岐のみを移植
function ftdsFindHeaderRow(rows) {
  for (var ri = 0; ri < Math.min(rows.length, 15); ri++) {
    var cols = ftdsMapHeaderColumns(rows[ri]);
    if (cols.tid === undefined) continue;
    if (cols.count !== undefined || cols.reasonBreakdown !== undefined || cols.reason !== undefined) return ri;
  }
  return -1;
}

// index.html: findReportSheet(wb, 'ftds') のftds分岐のみを移植。
// 「累計」始まりのシートは既存同様スキップ（累計レポート取込は本APIの対象外）。
function ftdsFindReportSheet(wb, XLSX) {
  var best = null;
  var bestName = null;
  var bestScore = 0;
  for (var si = 0; si < wb.SheetNames.length; si++) {
    if (wb.SheetNames[si].indexOf('累計') === 0) continue;
    var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[si]], { header: 1, defval: '' });
    if (!rows || rows.length < 2) continue;
    var hdr = rows[0];
    var score = 0;
    var hasTransporter = false;
    for (var hi = 0; hi < hdr.length; hi++) {
      var h = ftdsNormalizeHeader(hdr[hi]);
      if (ftdsIsTransporterHeader(hdr[hi])) { hasTransporter = true; score += 3; }
      if (h.indexOf('failure') >= 0 && h.indexOf('reason') >= 0) score += 4;
      if (h.indexOf('cycle') >= 0 && h.indexOf('name') >= 0) score += 2;
      if (h.indexOf('route') >= 0 && h.indexOf('code') >= 0) score += 2;
    }
    if (hasTransporter && score > bestScore) {
      bestScore = score;
      best = rows;
      bestName = wb.SheetNames[si];
    }
  }
  return { rows: best, sheetName: bestName };
}

// index.html: extractReportPeriodLabel を移植（ファイル名の週ラベル抽出用）
function ftdsExtractPeriodLabel(sheetName, fileName) {
  var src = (sheetName || '') + ' ' + (fileName || '');
  var m = src.match(/W\d+\s*[-–~]\s*W\d+/i);
  if (m) return m[0].replace(/\s/g, '');
  m = src.match(/W\d+/i);
  return m ? m[0] : '';
}

// index.html: parseReasonBreakdownPipe を移植
function ftdsParseReasonBreakdownPipe(text) {
  var out = {};
  var s = String(text || '').trim();
  if (!s) return out;
  var parts = s.split('|');
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (!p) continue;
    var idx = p.lastIndexOf(':');
    if (idx <= 0) continue;
    var reason = p.slice(0, idx).trim();
    var cnt = parseInt(p.slice(idx + 1).trim(), 10);
    if (reason && !isNaN(cnt)) out[reason] = cnt;
  }
  return out;
}

// index.html: REASON_JA / translateReason を値そのまま移植（Bad Weather表記ゆれ4種含む）
var FTDS_REASON_JA = {
  'CUSTOMER_UNAVAILABLE': '不在',
  'CUSTOMER_MOVED': '転居済み',
  'ADDRESS_NOT_FOUND': '住所不明',
  'INACCESSIBLE_DELIVERY_LOCATION': '配達先アクセス不可',
  'NOT_ATTEMPT': '配達未試行',
  'BUSINESS_CLOSED': '営業時間外',
  'OBJECT_MISSING': '荷物紛失',
  'NO_SECURE_LOCATION': '安全な置場所なし',
  'REFUSED_DELIVERY': '受取拒否',
  'UNDELIVERABLE': '配達不能',
  'PACKAGE_DAMAGED': '荷物破損',
  'MISSING_PACKAGE': '荷物不明',
  'WRONG_ADDRESS': '住所間違い',
  'DELIVERY_ATTEMPTED': '配達試行済',
  'OTHER': 'その他',
  'UNSAFE_DUE_TO_DOG': '犬がいて危険',
  'LOCKER_ISSUE': 'ロッカー不具合',
  'NO_LOCKER_AVAILABLE': 'ロッカー空きなし',
  'DELIVERED_TO_FRONT_DOOR': '玄関前置き',
  'DELIVERED_TO_OTHER_AS_INSTRUCTED': '指示先へ配達済',
  'DELIVERED_TO_MAIL_SLOT': '郵便受け投函',
  'DELIVERED_TO_DELIVERY_BOX': '宅配ボックス投函',
  'DELIVERED_TO_NEIGHBOR': '隣人渡し',
  'DELIVERED_TO_RECEPTION_LOBBY': '受付/ロビー渡し',
  'DELIVERED_TO_HOUSEHOLD_MEMBER': '同居人渡し',
  'DELIVERED_TO_GAS_METER': 'ガスメーター置き',
  'DELIVERED_TO_BICYCLE_BASKET': '自転車カゴ置き',
  'DELIVERED_TO_RECEPTIONIST': '受付人渡し',
  'DELIVERED_TO_SAFE_LOCATION': '安全な場所に置き配',
  'DELIVERED_TO_EVERYWHERE_LOCKER': '宅配ロッカー（PUDO等）',
  'Calls to Customer': '顧客への電話',
  'Text to Customer': '顧客へのSMS',
  'Attempt within 8AM to 8PM': '8時〜20時内に試行',
  'CANT_FIND_ADDRESS': '住所が見つからない',
  'CANT_FIND_SAFE_LOCATION': '安全な置場所が見つからない',
  'CANT_GET_ACCESS': 'アクセスできない',
  'Missing/Wrong Delivery Box Number or PIN code': '宅配BOX番号/暗証番号間違い',
  'No Item_delivery box': '宅配BOXに荷物なし',
  'No Item_reception/front_desk/mail room': '受付/フロント/メールルームに荷物なし',
  'No Item_neighbor': '隣人渡し先に荷物なし',
  'No Item_safe place': '安全な場所に荷物なし',
  'Driver - Controllable': 'ドライバー起因（管理可能）',
  'Driver - Not Controllable': 'ドライバー起因（管理不可）',
  'Non-Driver': 'ドライバー以外',
  'Uncategorized': '未分類',
  'NONE': 'なし',
  'None': 'なし',
  'none': 'なし',
  'DNR': '受取否認（DNR）',
  'FTDS': '未配達（FTDS）',
  'NO_ANSWER': '応答なし',
  'LATE_DELIVERY': '遅延配達',
  'EARLY_DELIVERY': '早期配達',
  'WRONG_ITEM': '商品間違い',
  'PARTIAL_DELIVERY': '一部未配達',
  'WEATHER': '天候不良',
  'VEHICLE_ISSUE': '車両トラブル',
  'TRAFFIC': '交通渋滞',
  'SAFETY_CONCERN': '安全上の問題',
  'CUSTOMER_CANCELLED': '顧客キャンセル',
  'DUPLICATE_DELIVERY': '重複配達',
  'SYSTEM_ERROR': 'システムエラー',
  'NO_SUCH_PLACE': '該当場所なし',
  'RECIPIENT_UNAVAILABLE': '受取人不在',
  'ACCESS_PROBLEM': 'アクセス問題',
  'PACKAGE_TOO_LARGE': '荷物サイズ超過',
  'INCOMPLETE_ADDRESS': '住所不完全',
  // FTDS/CC「Bad Weather」ステータスの日本語表示（元データは書き換えず表示のみ変換）
  'Bad Weather': '悪天候',
  'BAD_WEATHER': '悪天候',
  'bad weather': '悪天候',
  'Bad weather': '悪天候'
};
function ftdsTranslateReason(reason) {
  if (!reason) return '';
  if (FTDS_REASON_JA[reason]) return FTDS_REASON_JA[reason];
  var ja = reason.replace(/\s*[A-Za-z].*$/, '').trim();
  if (ja && ja !== reason) return ja;
  return reason.replace(/_/g, ' ');
}

// index.html: ftdsRecordWeight を移植
function ftdsRecordWeightSrv(rec) {
  return rec && rec.summaryCount ? rec.summaryCount : 1;
}

// 修正1件目: 日付セルの整形。xlsxLib.read()にcellDates:trueを渡した場合、日付型セルは
// JS Dateオブジェクトとして渡ってくるためUTCの年月日から直接YYYY-MM-DDを組み立てる。
// 文字列セル（"2026-08-29 00:00:00"等）は既存どおりスペース区切りの前半のみを使う。
function ftdsFormatDateValue(val) {
  if (val instanceof Date) {
    var y = val.getUTCFullYear();
    var m = String(val.getUTCMonth() + 1).padStart(2, '0');
    var d = String(val.getUTCDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  var s = String(val || '');
  if (s.indexOf(' ') > 0) s = s.split(' ')[0];
  return s;
}

// 修正4件目: 件数列（カウント/件数等）の値をそのまま集計件数として使う。
// 有効な正の整数のときだけその値、それ以外（列が無い/空/0以下/数値でない）は1件として扱う。
function ftdsResolveWeight(rawCountVal) {
  if (rawCountVal === undefined || rawCountVal === null || String(rawCountVal).trim() === '') return 1;
  var n = parseInt(rawCountVal, 10);
  if (isNaN(n) || n <= 0) return 1;
  return n;
}

// index.html: processFtdsData の本体ロジック（列マッピング〜行ごとの正規化）を移植。
// ドライバー名解決（TID→氏名）はマスタ取得後に別途行うため、ここではTID列・rowNameのみ抽出する。
function ftdsProcessRows(rows) {
  var headerIdx = ftdsFindHeaderRow(rows);
  if (headerIdx < 0) headerIdx = 0;
  var header = rows[headerIdx];
  var colMap = ftdsMapHeaderColumns(header);
  if (colMap.tid === undefined) {
    return { error: 'TransportID列が見つかりません' };
  }

  var results = [];
  for (var r = headerIdx + 1; r < rows.length; r++) {
    var row = rows[r];
    if (!row) continue;
    var tid = String(row[colMap.tid] || '').trim();
    if (!tid) continue;
    var rowName = colMap.driver !== undefined ? String(row[colMap.driver] || '').trim() : '';
    var dateVal = colMap.date !== undefined ? ftdsFormatDateValue(row[colMap.date]) : '';
    var reason = colMap.reason !== undefined ? String(row[colMap.reason] || '') : (colMap.reasonBreakdown !== undefined ? String(row[colMap.reasonBreakdown] || '') : '');
    var cycle = colMap.cycle !== undefined ? String(row[colMap.cycle] || '') : '';
    var route = colMap.route !== undefined ? String(row[colMap.route] || '') : '';
    var tracking = colMap.tracking !== undefined ? String(row[colMap.tracking] || '') : '';
    var zip = colMap.zip !== undefined ? String(row[colMap.zip] || '') : '';
    var weight = ftdsResolveWeight(colMap.count !== undefined ? row[colMap.count] : undefined);

    var rec = {
      date: dateVal,
      driverName: rowName, // TID未一致時のフォールバック値。マスタ照合後に上書きされる
      transporterId: tid,
      cycle: cycle,
      route: route,
      tracking: tracking,
      zip: zip,
      reason: reason,
      weight: weight // 修正4件目: 件数列の値（無効/欠落時は1）。集計時の重みとして使用
    };
    results.push(rec);
  }
  return { results: results };
}

// index.html: exportFtdsResult のCSV生成ロジックを移植したもの（列構成・2ブロック構成は同一）。
// 以下3点は既存のバグ修正として今回変更:
//  修正2件目: 未特定（driverName空）行は「(未特定)::TransportID」を内部集約キーとし、TID単位で別行にする
//             （登録済みドライバーはdriverNameのみで集約する既存挙動を維持）
//  修正3件目: 失敗理由の集計キーをftdsTranslateReason()後の日本語にし、表記ゆれ（Bad Weather/BAD_WEATHER等）を合算
//  修正4件目: 行数++ではなくr.weight（カウント等の件数列。無ければ1）を集計値として加算
function ftdsBuildExportCsv(results) {
  var driverStats = {};
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var dName = r.driverName || '(未特定)';
    // 登録済みドライバー: driverNameのみで集約（既存挙動維持）。未特定: driverName+TIDで集約（TIDごとに別行）
    var groupKey = r.driverName ? dName : (dName + '::' + r.transporterId);
    if (!driverStats[groupKey]) driverStats[groupKey] = { displayName: dName, tid: r.transporterId, count: 0, reasons: {}, dates: {} };
    driverStats[groupKey].count += r.weight;
    if (r.reason) {
      var reasonJa = ftdsTranslateReason(r.reason);
      driverStats[groupKey].reasons[reasonJa] = (driverStats[groupKey].reasons[reasonJa] || 0) + r.weight;
    }
    if (r.date) driverStats[groupKey].dates[r.date] = true;
  }

  var csvRows = [['ドライバー名', 'TransportID', '件数', '日付', '失敗理由内訳']];
  var dKeys = Object.keys(driverStats).sort(function(a, b) { return driverStats[b].count - driverStats[a].count; });
  for (var d = 0; d < dKeys.length; d++) {
    var ds = driverStats[dKeys[d]];
    var reasonParts = [];
    var rKeys = Object.keys(ds.reasons); // 既に日本語翻訳済みキーのため再翻訳は不要
    for (var ri = 0; ri < rKeys.length; ri++) {
      reasonParts.push(rKeys[ri] + ':' + ds.reasons[rKeys[ri]]);
    }
    var dateList = Object.keys(ds.dates).sort().join(' / ');
    csvRows.push([ds.displayName, ds.tid, ds.count, dateList, reasonParts.join(' | ')]);
  }

  csvRows.push([]);
  csvRows.push(['=== 詳細データ ===']);
  csvRows.push(['日付', 'ドライバー名', 'TransportID', 'サイクル', 'ルートコード', 'TrackingID', '郵便番号', '失敗理由']);
  for (var j = 0; j < results.length; j++) {
    var rec = results[j];
    csvRows.push([rec.date, rec.driverName || '(未特定)', rec.transporterId, rec.cycle, rec.route, rec.tracking, rec.zip, ftdsTranslateReason(rec.reason)]);
  }

  return csvRows.map(function(row) {
    return row.map(function(c) { return '"' + String(c || '').replace(/"/g, '""') + '"'; }).join(',');
  }).join('\n');
}

// ドライバーマスタ取得: 既存の GET /tenko-master?action=getMaster をサーバー内部からループバック呼出
// （/tenko-masterルート自体は無変更。GAS未設定時はstatus!=='ok'となるため空配列を返し、
//   全行が「未特定」として処理を継続する＝呼び出し不能で/ftds-export全体を落とさない）
function fetchFtdsDriverMaster() {
  var url = 'http://127.0.0.1:' + PORT + '/tenko-master?action=getMaster';
  // validateStatus:常にtrue → /tenko-masterが4xx/5xx(例: TENKO_MASTER_GAS_URL未設定時の500)を返しても
  // axiosの例外にせず、下のstatus!=='ok'判定で空配列（＝全行「未特定」）にフォールバックする。
  // 接続自体が失敗した場合（サーバー未起動等）のみPromiseがrejectされ、呼び出し元で502として扱われる。
  return axios.get(url, { timeout: 30000, validateStatus: function() { return true; } }).then(function(response) {
    var data = response.data;
    if (!data || data.status !== 'ok' || !Array.isArray(data.drivers)) return [];
    return data.drivers;
  });
}

app.post('/ftds-export', function(req, res) {
  if (!checkFtdsApiAuth(req, res)) return;

  var xlsxLib = getXlsxLib();
  var zipMulter = getZipMulter(); // /encrypt-zip・/decrypt-zipと同じ multer(memoryStorage, 10MB上限) を再利用
  if (!xlsxLib || !zipMulter) {
    return res.status(500).json({ status: 'error', message: 'server modules not ready' });
  }

  zipMulter.single('file')(req, res, function(err) {
    if (err) {
      log('ftds-export multer error: ' + (err.message || JSON.stringify(err)));
      return res.status(400).json({ status: 'error', message: err.message || 'upload error' });
    }

    var file = req.file;
    if (!file) return res.status(400).json({ status: 'error', message: 'file required (field name: file)' });

    var wb;
    try {
      // 修正1件目: cellDates:trueでExcelの日付型セルをJS Dateとして受け取る（文字列日付はそのままString）
      wb = xlsxLib.read(file.buffer, { type: 'buffer', cellDates: true });
    } catch (parseErr) {
      return res.status(400).json({ status: 'error', message: 'Excelファイルの解析に失敗しました: ' + parseErr.message });
    }

    var sheetInfo = ftdsFindReportSheet(wb, xlsxLib);
    if (!sheetInfo.rows || sheetInfo.rows.length < 2) {
      return res.status(422).json({ status: 'error', message: 'FTDS形式のシートが見つかりません（transporter_id列を含むシートが必要です）' });
    }

    var processed = ftdsProcessRows(sheetInfo.rows);
    if (processed.error) {
      return res.status(422).json({ status: 'error', message: processed.error });
    }
    if (processed.results.length === 0) {
      return res.status(422).json({ status: 'error', message: 'TransportIDを持つ行が見つかりませんでした' });
    }

    fetchFtdsDriverMaster().then(function(master) {
      var tidToName = {};
      for (var mi = 0; mi < master.length; mi++) {
        var mtid = String(master[mi].transportId || '').trim();
        if (!mtid) continue;
        tidToName[mtid] = master[mi].englishName || '';
      }

      var results = processed.results;
      for (var ri2 = 0; ri2 < results.length; ri2++) {
        var rec = results[ri2];
        // 優先順位: マスタのTID一致 > ファイル内のドライバー名列 > 未特定（空文字のまま）
        if (tidToName[rec.transporterId]) rec.driverName = tidToName[rec.transporterId];
      }

      var csv = ftdsBuildExportCsv(results);
      var periodLabel = ftdsExtractPeriodLabel(sheetInfo.sheetName, file.originalname);
      var outFileName = 'FTDS分析_' + (periodLabel || getTodayJst()) + '.csv';

      log('ftds-export: ' + results.length + ' rows, master=' + master.length + ' drivers, file=' + outFileName);

      // Content-Dispositionのヘッダー値はASCII範囲外の文字を直接入れられない（Node/Expressが
      // 「Invalid character in header content」で例外を投げる）ため、/encrypt-zip・/decrypt-zip
      // と同じ RFC 5987 形式（filename*=UTF-8''...）で日本語ファイル名を渡す。
      // 対応クライアント向けに素のfilename=にはASCII安全なフォールバック名を入れる。
      var asciiFallbackName = 'FTDS_export_' + (periodLabel || getTodayJst()).replace(/[^A-Za-z0-9_-]/g, '') + '.csv';
      var encodedOutFileName = encodeURIComponent(outFileName);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="' + asciiFallbackName + '"; filename*=UTF-8\'\'' + encodedOutFileName);
      res.send('﻿' + csv);
    }).catch(function(masterErr) {
      log('ftds-export driver master fetch error: ' + masterErr.message);
      if (!res.headersSent) {
        res.status(502).json({ status: 'error', message: 'ドライバーマスタの取得に失敗しました: ' + masterErr.message });
      }
    });
  });
});

app.listen(PORT, () => {
  log(`Server running on port ${PORT}`);
});


