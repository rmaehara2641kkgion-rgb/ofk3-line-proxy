'use strict';

var Module = require('module');
var path = require('path');

function nativeLoaded() {
  return Object.keys(require.cache).filter(function (key) {
    return key.indexOf('pdfjs-dist') !== -1 || key.indexOf('napi-rs') !== -1;
  });
}

delete process.env.DM_PDF_CONVERT;
delete process.env.DM_IMAGE_LIVE_SEND;
delete process.env.DM_IMAGE_RETENTION_TEST_LINE_ID;

var Dm = require(path.join('..', 'dm-line-image.js'));
var Http = require(path.join('..', 'dm-line-http.js'));
if (nativeLoaded().length) {
  console.error('loaded at import', nativeLoaded());
  process.exit(2);
}

var jpeg = Buffer.from(process.env.DM_PROBE_JPEG || '', 'base64');
var lineId = 'U' + 'a'.repeat(32);

function service(extra) {
  return Dm.createService(Object.assign({
    retentionConfirmed: true,
    productionUnlocked: true,
    directory: async function () {
      return [{ key: '山田 太郎', japaneseName: '山田 太郎', company: '福岡', lineId: lineId }];
    },
    liveSendEnabled: function () { return true; },
    sendLine: async function () { return { status: 200, data: {} }; }
  }, extra || {}));
}

function input(extra) {
  return Object.assign({
    subjectName: '山田 太郎',
    confirmSubject: '山田 太郎',
    confirmed: true,
    origin: 'https://ofk3-line-proxy-1.onrender.com'
  }, extra || {});
}

(async function () {
  var plain = service();
  var reviewed = await plain.review(input({ bytes: jpeg }));
  if (reviewed.code !== 'ready') {
    console.error('jpeg review', reviewed);
    process.exit(3);
  }
  var sent = await plain.perform(input({ imageSetId: reviewed.imageSetId }));
  if (sent.code !== 'line_accepted') {
    console.error('jpeg send', sent);
    process.exit(4);
  }
  if (nativeLoaded().length) {
    console.error('loaded after jpeg', nativeLoaded());
    process.exit(5);
  }
  var blockedPdf = await plain.review(input({ bytes: Buffer.from('%PDF-1.7\n%isolate\n') }));
  if (blockedPdf.code !== 'pdf_unavailable') {
    console.error('pdf should stay unloaded', blockedPdf);
    process.exit(6);
  }
  if (Object.keys(require.cache).some(function (key) { return key.indexOf('dm-line-pdf.js') !== -1; })) {
    console.error('pdf module loaded while disabled');
    process.exit(7);
  }

  var originalRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    var name = String(id);
    if (name === '@napi-rs/canvas' || name.indexOf('pdfjs-dist') === 0) {
      var missing = new Error('Cannot find module ' + name);
      missing.code = 'MODULE_NOT_FOUND';
      throw missing;
    }
    return originalRequire.apply(this, arguments);
  };

  var enabled = service({ pdfEnabled: true });
  process.env.DM_PDF_SIMULATE_MISSING = '1';
  var missingPdf = await enabled.review(input({ bytes: Buffer.from('%PDF-1.7\n%isolate\n') }));
  delete process.env.DM_PDF_SIMULATE_MISSING;
  if (missingPdf.code !== 'pdf_unavailable') {
    console.error('missing library', missingPdf);
    process.exit(8);
  }
  var failedPdf = await enabled.review(input({ bytes: Buffer.from('%PDF-1.7\n%isolate\n') }));
  if (failedPdf.code !== 'image_convert_failed' && failedPdf.code !== 'invalid_file') {
    console.error('bad pdf', failedPdf);
    process.exit(8);
  }
  if (Object.keys(require.cache).some(function (key) { return key.indexOf('dm-line-pdf.js') !== -1 || key.indexOf('pdfjs-dist') !== -1; })) {
    console.error('parent loaded pdf converter');
    process.exit(10);
  }
  var again = await enabled.review(input({ bytes: jpeg }));
  if (again.code !== 'ready') {
    console.error('jpeg after missing pdf library', again);
    process.exit(9);
  }
  if (nativeLoaded().length) {
    console.error('native loaded despite missing modules', nativeLoaded());
    process.exit(10);
  }

  var defaults = Http.createDefaultService({
    lineEnabled: function () { return true; },
    sendLine: async function () { return { status: 200, data: {} }; },
    directory: async function () {
      return [{ key: '山田 太郎', japaneseName: '山田 太郎', company: '福岡', lineId: lineId }];
    }
  });
  var defaultPdf = await defaults.review(input({ bytes: Buffer.from('%PDF-1.7\n%isolate\n') }));
  if (defaultPdf.code !== 'pdf_unavailable') {
    console.error('default service enabled pdf', defaultPdf);
    process.exit(11);
  }
  console.log('jpeg isolated');
})().catch(function (error) {
  console.error(error);
  process.exit(12);
});
