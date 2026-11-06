/**
 * 個別LINEのPDF→画像変換。第2段階。
 * このファイルは変換子プロセスだけが読む。親プロセスは読まない。
 * JPEG・PNG の直接送信と、サーバの起動では読まない。
 */
'use strict';

var canvasApi = null;
var pdfjsLib = null;

function loadRenderLibs(loader) {
  if (canvasApi && pdfjsLib) return;
  var load = loader || require;
  try {
    canvasApi = load('@napi-rs/canvas');
    if (!global.DOMMatrix && canvasApi.DOMMatrix) global.DOMMatrix = canvasApi.DOMMatrix;
    if (!global.ImageData && canvasApi.ImageData) global.ImageData = canvasApi.ImageData;
    if (!global.Path2D && canvasApi.Path2D) global.Path2D = canvasApi.Path2D;
    pdfjsLib = load('pdfjs-dist/legacy/build/pdf.js');
  } catch (e) {
    canvasApi = null;
    pdfjsLib = null;
    var missing = new Error('pdf libraries unavailable');
    missing.code = 'pdf_unavailable';
    throw missing;
  }
}

function encodeJpeg(canvas, quality) {
  if (typeof canvas.toBuffer === 'function') {
    try { return canvas.toBuffer('image/jpeg', quality); } catch (e) { /* 次の形式 */ }
    try { return canvas.toBuffer('image/jpeg', { quality: quality / 100 }); } catch (e2) { /* encodeへ */ }
  }
  if (typeof canvas.encode === 'function') return Buffer.from(canvas.encode('jpeg', quality));
  throw new Error('jpeg encoder missing');
}

function jpegUnder(canvas, maxBytes, startQuality) {
  var quality = startQuality;
  var buf = encodeJpeg(canvas, quality);
  while (buf.length > maxBytes && quality > 50) {
    quality -= 10;
    buf = encodeJpeg(canvas, quality);
  }
  if (!buf || buf.length < 32 || buf.length > maxBytes) return null;
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  return buf;
}

async function renderPdfPages(bytes, limits, loader) {
  limits = limits || {};
  var maxPages = limits.maxPages || 8;
  var originalMax = limits.originalMax || (10 * 1024 * 1024);
  var previewMax = limits.previewMax || (1024 * 1024);
  loadRenderLibs(loader);
  var data = new Uint8Array(bytes.length);
  for (var i = 0; i < bytes.length; i++) data[i] = bytes[i];
  var doc = await pdfjsLib.getDocument({
    data: data,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0
  }).promise;
  try {
    if (!doc.numPages) {
      var empty = new Error('no pages');
      empty.code = 'invalid_file';
      throw empty;
    }
    if (doc.numPages > maxPages) {
      var tooMany = new Error('too many pages');
      tooMany.code = 'image_convert_failed';
      throw tooMany;
    }
    var pages = [];
    for (var n = 1; n <= doc.numPages; n++) {
      var page = await doc.getPage(n);
      var base = page.getViewport({ scale: 1 });
      var scale = Math.min(3, Math.max(2.2, 1280 / base.width));
      var viewport = page.getViewport({ scale: scale });
      var width = Math.ceil(viewport.width);
      var height = Math.ceil(viewport.height);
      var canvas = canvasApi.createCanvas(width, height);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      var task = page.render({ canvasContext: ctx, viewport: viewport });
      await (task.promise || task);
      var original = jpegUnder(canvas, originalMax, 82);
      var previewWidth = 480;
      var previewHeight = Math.max(1, Math.round(height * (previewWidth / width)));
      var previewCanvas = canvasApi.createCanvas(previewWidth, previewHeight);
      var previewCtx = previewCanvas.getContext('2d');
      previewCtx.fillStyle = '#ffffff';
      previewCtx.fillRect(0, 0, previewWidth, previewHeight);
      previewCtx.drawImage(canvas, 0, 0, previewWidth, previewHeight);
      var preview = jpegUnder(previewCanvas, previewMax, 70);
      if (page.cleanup) { try { page.cleanup(); } catch (e) { /* ページ破棄の失敗は変換結果を変えない */ } }
      if (!original || !preview) {
        var big = new Error('jpeg too large');
        big.code = 'size_exceeded';
        throw big;
      }
      pages.push({
        mime: 'image/jpeg',
        previewMime: 'image/jpeg',
        original: original,
        preview: preview,
        width: width,
        height: height
      });
    }
    return pages;
  } finally {
    if (doc.cleanup) { try { await doc.cleanup(); } catch (e1) { /* キャッシュ破棄の失敗は画像を捨てない */ } }
    if (doc.destroy) { try { await doc.destroy(); } catch (e2) { /* 破棄失敗は変換済み画像を捨てない */ } }
  }
}

module.exports = {
  renderPdfPages: renderPdfPages,
  loadRenderLibs: loadRenderLibs
};
