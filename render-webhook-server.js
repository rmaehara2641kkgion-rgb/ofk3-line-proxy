const express = require('express');
const axios = require('axios');
const app = express();
const path = require('path');

app.use(express.json());

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

    const response = await axios.get(
      'https://nominatim.openstreetmap.org/search',
      {
        params: {
          q: address,
          format: 'json',
          limit: 1
        },
        headers: {
          'User-Agent': 'OFK3 Delivery System'
        }
      }
    );

    if (!response.data.length) {
      return res.json({
        status: 'notfound'
      });
    }

    // キャッシュ保存
    geocodeCache[address] = {
      lat: Number(response.data[0].lat),
      lng: Number(response.data[0].lon)
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

    const response = await axios.post('https://api.line.me/v2/bot/message/push', {
      to: target,
      messages: messages
    }, {
      headers: {
        'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    log('LINE push success:', target, response.status);
    res.json({ status: 'ok', lineStatus: response.status });
  } catch (err) {
    log('Proxy error:', err.response?.data || err.message);
    res.status(502).json({ status: 'error', lineBody: err.response?.data, message: err.message });
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
