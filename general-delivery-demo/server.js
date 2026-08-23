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

app.post('/api/line/send', function (req, res) {
  var enabled = process.env.LINE_SEND_ENABLED === 'true';
  var hasToken = !!(process.env.PRIVATE_LINE_TOKEN || '').trim();
  if (!enabled || !hasToken) {
    res.status(403).json({
      ok: false,
      previewOnly: true,
      message: 'Demoでは実際には送信されません'
    });
    return;
  }
  res.status(501).json({
    ok: false,
    message: 'Private send is reserved for a configured environment'
  });
});

app.listen(PORT, function () {
  console.log('Delivery Operations Demo listening on http://localhost:' + PORT);
});
