/**
 * PDF変換の子プロセス。終了すると変換ライブラリのメモリも一緒に返る。
 * 標準出力へ結果JSONを1回だけ書く。
 */
'use strict';

var peak = process.memoryUsage().rss;

function note() {
  var rss = process.memoryUsage().rss;
  if (rss > peak) peak = rss;
}

function send(payload, status) {
  note();
  payload.peakRss = peak;
  var body = JSON.stringify(payload);
  var code = status || 0;
  if (!process.stdout.write(body)) {
    process.stdout.once('drain', function () { process.exit(code); });
    return;
  }
  process.exit(code);
}

if (process.env.DM_PDF_SIMULATE_MISSING === '1') {
  send({ ok: false, code: 'pdf_unavailable', message: 'pdf libraries unavailable' }, 0);
}

var chunks = [];
process.stdin.on('data', function (chunk) { chunks.push(chunk); });
process.stdin.on('end', function () {
  var timer = setInterval(note, 50);
  if (timer.unref) timer.unref();
  Promise.resolve().then(function () {
    var all = Buffer.concat(chunks);
    var split = all.indexOf(0x0A);
    if (split < 0) {
      var broken = new Error('missing header');
      broken.code = 'invalid_file';
      throw broken;
    }
    var limits = JSON.parse(all.slice(0, split).toString('utf8'));
    var pdf = all.slice(split + 1);
    if (pdf.length !== Number(limits.length)) {
      var mismatch = new Error('truncated pdf');
      mismatch.code = 'invalid_file';
      throw mismatch;
    }
    var render = require('../dm-line-pdf.js').renderPdfPages;
    note();
    return render(pdf, {
      maxPages: limits.maxPages,
      originalMax: limits.originalMax,
      previewMax: limits.previewMax
    });
  }).then(function (pages) {
    clearInterval(timer);
    note();
    send({
      ok: true,
      pages: pages.map(function (page) {
        return {
          width: page.width,
          height: page.height,
          original: page.original.toString('base64'),
          preview: page.preview.toString('base64')
        };
      })
    }, 0);
  }).catch(function (err) {
    clearInterval(timer);
    var code = err && err.code;
    if (code !== 'invalid_file' && code !== 'size_exceeded' && code !== 'image_convert_failed' && code !== 'pdf_unavailable') {
      code = 'image_convert_failed';
    }
    send({ ok: false, code: code, message: code }, 0);
  });
});
