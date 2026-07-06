const express = require('express');
const axios = require('axios');
const app = express();
const path = require('path');

app.use(express.json({ limit: '10mb' }));

// PDF一時保存用
var pdfStore = {};

// body-parserでrawも受け取れるようにする
var multer;
try { multer = require('multer'); } catch(e) { multer = null; }
var pdfUpload = multer ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }) : null;

// CORS対応
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(200).json({ status: 'ok' });
  }
  next();
});

const PORT = process.env.PORT || 3000;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const ADMIN_LINE_ID = process.env.ADMIN_LINE_ID;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
console.log('API KEY =', GOOGLE_MAPS_API_KEY);

// 住所→座標キャッシュ（プロセス内、Renderでは再起動で消える）
const geocodeCache = {};

// 静的ファイル配信（index.html, logo.pngなど）
app.use(express.static(path.join(__dirname)));

// 簡易ログ（Render Dashboard → Logs で確認）
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
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
  // 1時間後に自動削除
  setTimeout(function() { delete routeDataStore[id]; }, 3600000);
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

app.get('/addr-master', async (req, res) => {
  try {
    if (!ADDR_MASTER_GAS_URL) {
      return res.status(500).json({ status: 'error', message: 'ADDR_MASTER_GAS_URL not configured' });
    }
    var qs = Object.keys(req.query).map(function(k) { return k + '=' + encodeURIComponent(req.query[k]); }).join('&');
    var url = ADDR_MASTER_GAS_URL + '?' + qs;
    console.log('addr-master GET:', url);
    var response = await axios.get(url, { maxRedirects: 5 });
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
    var response = await axios.post(url, req.body, {
      headers: { 'Content-Type': 'application/json' },
      maxRedirects: 5,
      timeout: 55000,
      validateStatus: function() { return true; }
    });
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
app.post('/proxy', async (req, res) => {
  try {
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

    const response = await axios.post('https://api.line.me/v2/bot/message/push', {
      to: target,
      messages: messages
    }, {
      headers: {
        'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    log('LINE push success:', target, response.status);
    res.json({ status: 'ok', lineStatus: response.status });
  } catch (err) {
    console.error('===== LINE PUSH ERROR =====');
    console.error('Error details:', JSON.stringify(err.response && err.response.data ? err.response.data : err.message, null, 2));
    res.status(502).json({ status: 'error', lineBody: err.response && err.response.data ? err.response.data : null, message: err.message });
  }
});

async function sendWelcomeMessage(userId) {
  try {
    await axios.post('https://api.line.me/v2/bot/message/push', {
      to: userId,
      messages: [{ type: 'text', text: '友だち追加ありがとうございます。\n配送通知の設定は管理者画面から行ってください。' }]
    }, {
      headers: {
        'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    log('Welcome message sent to', userId);
  } catch (err) {
    log('Welcome message error:', err.response?.data || err.message);
  }
}

app.listen(PORT, () => {
  log(`Server running on port ${PORT}`);
});
