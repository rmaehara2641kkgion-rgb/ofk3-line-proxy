'use strict';

var fs = require('fs');
var path = require('path');
var PDFDocument = require('pdfkit');
var Host = require('../dm-line-pdf-host.js');

var outDir = path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'ofk3-pdf-child-proof');
fs.mkdirSync(outDir, { recursive: true });

function makePdf(draw) {
  return new Promise(function (resolve, reject) {
    var doc = new PDFDocument({ size: 'A4', margin: 48 });
    var chunks = [];
    doc.on('data', function (chunk) { chunks.push(chunk); });
    doc.on('end', function () { resolve(Buffer.concat(chunks)); });
    doc.on('error', reject);
    draw(doc);
    doc.end();
  });
}

function limits() {
  return { maxPages: 8, originalMax: 10 * 1024 * 1024, previewMax: 1024 * 1024 };
}

async function main() {
  var simple = await makePdf(function (doc) {
    doc.fontSize(18).text('page 1');
    doc.addPage();
    doc.fontSize(18).text('page 2');
  });
  var start = process.memoryUsage().rss;
  var samples = [];
  for (var i = 0; i < 10; i++) {
    var result = await Host.renderPdfDetailed(simple, limits());
    samples.push({
      parent: process.memoryUsage().rss,
      child: result.peakRss,
      pages: result.pages.length
    });
  }
  if (global.gc) global.gc();
  var end = process.memoryUsage().rss;
  var font = 'C:/Windows/Fonts/yumin.ttf';
  var invoice = await makePdf(function (doc) {
    doc.font(font);
    doc.fontSize(22).text('架空請求書', { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(14).text('ページ 1 / 2');
    doc.moveDown(0.5);
    doc.fontSize(12);
    doc.text('宛名: 架空 太郎');
    doc.text('請求番号: TEST-0001');
    doc.moveDown(0.4);
    doc.text('1. 基本料金          100,000円');
    doc.text('2. 付帯作業           23,450円');
    doc.moveDown(0.4);
    doc.fontSize(14).text('小計: 123,450円');
    doc.addPage();
    doc.font(font);
    doc.fontSize(22).text('架空請求書', { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(14).text('ページ 2 / 2');
    doc.moveDown(0.5);
    doc.fontSize(12);
    doc.text('宛名: 架空 太郎');
    doc.text('3. 調整額                 0円');
    doc.moveDown(0.4);
    doc.fontSize(16).text('合計: 123,450円');
    doc.moveDown(0.6);
    doc.fontSize(8).text('注記: これは架空の試験請求書です。実在の取引先、金額、配送実績ではありません。');
  });
  var quality = await Host.renderPdfDetailed(invoice, limits());
  var pages = quality.pages.map(function (page, index) {
    var n = index + 1;
    fs.writeFileSync(path.join(outDir, 'p' + n + '-original.jpg'), page.original);
    fs.writeFileSync(path.join(outDir, 'p' + n + '-preview.jpg'), page.preview);
    return {
      page: n,
      width: page.width,
      height: page.height,
      originalBytes: page.original.length,
      previewBytes: page.preview.length,
      magic: page.original[0] === 0xFF && page.original[1] === 0xD8
    };
  });
  var report = {
    runs: samples.length,
    pages: samples[0] ? samples[0].pages : 0,
    start: start,
    end: end,
    parentGrowth: end - start,
    childPeakMin: Math.min.apply(null, samples.map(function (sample) { return sample.child; })),
    childPeakMax: Math.max.apply(null, samples.map(function (sample) { return sample.child; })),
    samples: samples,
    quality: {
      pageCount: pages.length,
      differentPages: !pages[0] || !pages[1] ? false : !quality.pages[0].original.equals(quality.pages[1].original),
      childPeak: quality.peakRss,
      pages: pages
    }
  };
  fs.writeFileSync(path.join(outDir, 'rss.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report));
}

main().catch(function (error) {
  process.stderr.write(String(error && error.stack || error) + '\n');
  process.exit(1);
});
