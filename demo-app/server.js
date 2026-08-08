var express = require('express');
var path = require('path');
var fs = require('fs');
var app = express();
var PORT = process.env.PORT || 3000;
var rootDir = path.join(__dirname, '..');

app.use(express.static(__dirname, {
  index: false,
  maxAge: '1h',
  setHeaders: function(res, filePath) {
    if (filePath.slice(-5) === '.html' || filePath.slice(-13) === 'demo-fixes.js') {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));
// リポジトリ直下の共有アセット（スプラッシュ・ヒーロー画像等）
app.use(express.static(rootDir, {
  index: false,
  maxAge: '1h'
}));

app.get('/', function(req, res) {
  var indexPath = path.join(__dirname, 'index.html');
  fs.readFile(indexPath, 'utf8', function(err, html) {
    if (err) {
      res.status(500).send('Failed to load demo');
      return;
    }
    var fixTag = '<script src="/demo-fixes.js?v=20260808-2"></script>';
    html = html.replace('</body>', fixTag + '\n</body>');
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  });
});

app.listen(PORT, function() {
  console.log('OFK3 delivery demo listening on port ' + PORT);
});
