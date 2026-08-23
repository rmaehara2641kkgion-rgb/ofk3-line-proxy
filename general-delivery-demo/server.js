'use strict';

var express = require('express');
var fs = require('fs');
var path = require('path');
var app = express();
var PORT = process.env.PORT || 3100;
var DEMO_DIR = __dirname;
var ASSETS_DIR = path.join(DEMO_DIR, 'assets');
var SRC_DIR = path.join(DEMO_DIR, 'src');

function setAssetHeaders(res, filePath) {
  if (filePath.slice(-4) === '.css') {
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
  } else if (filePath.slice(-3) === '.js') {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  }
  res.setHeader('Cache-Control', 'no-cache');
}

function sendExisting(filePath, contentType, res) {
  if (!fs.existsSync(filePath)) {
    res.status(404).type('text').send('Not found');
    return;
  }
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(filePath);
}

app.use(express.json({ limit: '32kb' }));

app.get('/assets/app.css', function (req, res) {
  sendExisting(path.join(ASSETS_DIR, 'app.css'), 'text/css; charset=utf-8', res);
});
app.get('/src/app.js', function (req, res) {
  sendExisting(path.join(SRC_DIR, 'app.js'), 'application/javascript; charset=utf-8', res);
});
app.get('/src/sample-data.js', function (req, res) {
  sendExisting(path.join(SRC_DIR, 'sample-data.js'), 'application/javascript; charset=utf-8', res);
});
app.get('/src/assign.js', function (req, res) {
  sendExisting(path.join(SRC_DIR, 'assign.js'), 'application/javascript; charset=utf-8', res);
});
app.get('/src/ops.js', function (req, res) {
  sendExisting(path.join(SRC_DIR, 'ops.js'), 'application/javascript; charset=utf-8', res);
});
app.get('/src/csv.js', function (req, res) {
  sendExisting(path.join(SRC_DIR, 'csv.js'), 'application/javascript; charset=utf-8', res);
});

app.use('/assets', express.static(ASSETS_DIR, {
  index: false,
  fallthrough: false,
  setHeaders: setAssetHeaders
}));
app.use('/src', express.static(SRC_DIR, {
  index: false,
  fallthrough: false,
  setHeaders: setAssetHeaders
}));

app.get('/', function (req, res) {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(DEMO_DIR, 'index.html'));
});

app.get('/health', function (req, res) {
  res.status(200).json({ ok: true, service: 'general-delivery-demo' });
});

app.get('/deploy-info', function (req, res) {
  res.status(200).json({
    name: 'general-delivery-demo',
    demo: true,
    lineSend: false
  });
});

app.post('/api/line/send', function (req, res) {
  res.status(403).json({
    ok: false,
    demo: true,
    message: 'Demoでは実際には送信されません'
  });
});

app.listen(PORT, function () {
  console.log('Delivery Operations Demo listening on http://localhost:' + PORT);
});
