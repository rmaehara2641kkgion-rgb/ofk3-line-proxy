// Render起動前に点呼TransportID監査スクリプトをindex.html末尾へ安全に追加する。
// 巨大index.html内の文字列に含まれる </body> を誤置換しないよう lastIndexOf を使用。
const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, 'index.html');
const tags = [
  '<script src="/tenko-transport-audit.js?v=20260812-1"></script>',
  '<script src="/tenko-transport-audit-success.js?v=20260812-1"></script>'
];

try {
  var html = fs.readFileSync(indexPath, 'utf8');
  var pos = html.lastIndexOf('</body>');
  if (pos < 0) throw new Error('index.html の </body> が見つかりません');

  var insert = '';
  if (html.indexOf('/tenko-transport-audit.js') < 0) {
    insert += '  ' + tags[0] + '\n';
  }
  if (html.indexOf('/tenko-transport-audit-success.js') < 0) {
    insert += '  ' + tags[1] + '\n';
  }

  if (insert) {
    html = html.slice(0, pos) + insert + html.slice(pos);
    fs.writeFileSync(indexPath, html, 'utf8');
    console.log('Tenko TransportID audit scripts injected');
  } else {
    console.log('Tenko TransportID audit scripts already present');
  }
} catch (e) {
  console.error('Failed to inject Tenko TransportID audit:', e.message);
  process.exit(1);
}

require('./render-webhook-server.js');
