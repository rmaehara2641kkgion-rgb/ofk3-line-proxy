var express = require('express');
var path = require('path');
var app = express();
var PORT = process.env.PORT || 3000;
var rootDir = path.join(__dirname, '..');

app.use(express.static(__dirname, {
  maxAge: '1h',
  setHeaders: function(res, filePath) {
    if (filePath.slice(-5) === '.html') {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));
// リポジトリ直下の共有アセット（スプラッシュ・ヒーロー画像等）
app.use(express.static(rootDir, {
  maxAge: '1h'
}));

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, function() {
  console.log('OFK3 delivery demo listening on port ' + PORT);
});
