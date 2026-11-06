/**
 * PDF変換の親側。変換ライブラリは読まず、子プロセスへ渡して終了を待つ。
 * 同時に動かす子は1つまで。時間内に終わらなければ子を止める。
 */
'use strict';

var childProcess = require('child_process');
var path = require('path');

var DEFAULT_TIMEOUT_MS = 20000;
var SECRET = /TOKEN|SECRET|PASSWORD|CHANNEL_ID|LINE_ID|API_KEY|_KEY|GAS_URL|DATABASE|CREDENTIAL/i;

function safeEnv(source) {
  var env = {};
  var input = source || process.env;
  Object.keys(input).forEach(function (key) {
    if (key === 'NODE_OPTIONS' || key === 'NODE_DEBUG') return;
    if (SECRET.test(key)) return;
    env[key] = input[key];
  });
  return env;
}

function childScript() {
  return path.join(__dirname, 'scripts', 'dm-line-pdf-child.js');
}

function defaultSpawn() {
  return childProcess.spawn(process.execPath, [childScript()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: safeEnv(),
    windowsHide: true
  });
}

function coded(code, message, reason) {
  var error = new Error(message || code);
  error.code = code;
  if (reason) error.reason = reason;
  return error;
}

function decodePage(page) {
  var original = Buffer.from(String(page && page.original || ''), 'base64');
  var preview = Buffer.from(String(page && page.preview || ''), 'base64');
  if (original.length < 4 || preview.length < 4 || original[0] !== 0xFF || original[1] !== 0xD8 || preview[0] !== 0xFF || preview[1] !== 0xD8) {
    throw coded('image_convert_failed', 'bad child image');
  }
  return {
    mime: 'image/jpeg',
    previewMime: 'image/jpeg',
    original: original,
    preview: preview,
    width: Number(page.width) || 0,
    height: Number(page.height) || 0
  };
}

function runChild(bytes, limits, timeoutMs, spawnImpl) {
  return new Promise(function (resolve, reject) {
    var child;
    try {
      child = spawnImpl();
    } catch (err) {
      reject(coded('pdf_unavailable', err.message));
      return;
    }
    var stdout = [];
    var settled = false;
    var timer = setTimeout(function () {
      finish(coded('image_convert_failed', 'timeout', 'timeout'));
      try { child.kill(); } catch (e) { /* 停止できない場合は終了通知を待つ */ }
      try { if (child.stdin) child.stdin.destroy(); } catch (e2) { /* 入力を閉じる */ }
    }, timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    }

    child.stdout.on('data', function (chunk) { stdout.push(chunk); });
    child.stderr.on('data', function () { /* ライブラリの警告は結果に混ぜない */ });
    if (child.stdin && child.stdin.on) child.stdin.on('error', function () { /* 子が先に終了した場合 */ });
    child.on('error', function (err) {
      finish(coded('pdf_unavailable', err.message));
    });
    child.on('close', function (status) {
      if (settled) return;
      var text = Buffer.concat(stdout).toString('utf8');
      var payload = null;
      try { payload = JSON.parse(text); } catch (e) { payload = null; }
      if (!payload || payload.ok !== true || status !== 0) {
        var code = payload && payload.code;
        if (code !== 'invalid_file' && code !== 'size_exceeded' && code !== 'image_convert_failed' && code !== 'pdf_unavailable') {
          code = 'image_convert_failed';
        }
        var error = coded(code, payload && payload.message || ('child exit ' + status));
        if (payload && payload.peakRss) error.peakRss = payload.peakRss;
        finish(error);
        return;
      }
      try {
        finish(null, {
          peakRss: Number(payload.peakRss) || 0,
          pages: (payload.pages || []).map(decodePage)
        });
      } catch (err) {
        finish(coded('image_convert_failed', err.message));
      }
    });

    var header = Buffer.from(JSON.stringify({
      maxPages: limits.maxPages,
      originalMax: limits.originalMax,
      previewMax: limits.previewMax,
      length: bytes.length
    }) + '\n');
    try {
      child.stdin.write(header);
      child.stdin.write(bytes);
      child.stdin.end();
    } catch (err) {
      finish(coded('image_convert_failed', err.message));
    }
  });
}

function createPdfHost(options) {
  options = options || {};
  var active = 0;
  var limit = options.concurrency || 1;
  var timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  var spawnImpl = options.spawn || defaultSpawn;

  function render(bytes, limits) {
    if (active >= limit) {
      return Promise.reject(coded('pdf_busy', 'pdf busy'));
    }
    active += 1;
    return runChild(bytes, limits || {}, timeoutMs, spawnImpl).then(function (result) {
      active -= 1;
      return result;
    }, function (error) {
      active -= 1;
      throw error;
    });
  }

  return {
    render: render,
    active: function () { return active; }
  };
}

var shared = createPdfHost({});

function renderPdfPages(bytes, limits) {
  return shared.render(bytes, limits).then(function (result) { return result.pages; });
}

function renderPdfDetailed(bytes, limits) {
  return shared.render(bytes, limits);
}

function activeConversions() {
  return shared.active();
}

module.exports = {
  createPdfHost: createPdfHost,
  renderPdfPages: renderPdfPages,
  renderPdfDetailed: renderPdfDetailed,
  activeConversions: activeConversions,
  safeEnv: safeEnv,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS
};
