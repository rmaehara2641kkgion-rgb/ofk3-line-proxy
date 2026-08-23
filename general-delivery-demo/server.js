'use strict';

var express = require('express');
var path = require('path');
var app = express();
var PORT = process.env.PORT || 3100;
var DEMO_DIR = __dirname;

app.use(express.json({ limit: '32kb' }));
app.use(express.static(DEMO_DIR, {
  index: false,
  setHeaders: function (res, filePath) {
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
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
