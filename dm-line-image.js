/**
 * 個別LINEメッセージの画像添付。
 * JPEG と PNG はそのまま送る。PDF変換ライブラリはここでは読まない。
 * 宛先はサーバが読む点呼マスタだけを使う。画像URLは本文へ入れない。
 * 画像の本番送信は、試験アカウントで保持確認が記録されるまで行わない。
 */
'use strict';

var crypto = require('crypto');
var Core = require('./billing-reconcile-core.js');

var DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
var MAX_TTL_MS = 2 * 60 * 60 * 1000;
var MAX_PAGES = 8;
var MAX_UPLOAD = 6 * 1024 * 1024;
var ORIGINAL_MAX = 10 * 1024 * 1024;
var PREVIEW_MAX = 1024 * 1024;
var TOKEN_BYTES = 32;

function liveSendAllowed(envValue, lineEnabled) {
  return envValue === '1' && lineEnabled === true;
}

function resolvePublicOrigin(input) {
  input = input || {};
  var host = String(input.host || '').split(',')[0].trim();
  var proto = String(input.proto || 'http').split(',')[0].trim().toLowerCase();
  if (!host) return '';
  if (/onrender\.com$/i.test(host) || /ofk3-line-proxy/i.test(host)) proto = 'https';
  if (proto !== 'https' && proto !== 'http') proto = 'http';
  return proto + '://' + host;
}

function deliveryUnknown(err) {
  return !err || !err.response;
}

function acceptPush(response) {
  if (!response || response.skipped || response.lineSkipped) return { ok: false, code: 'line_skipped' };
  var data = response.data;
  if (data && (data.lineSkipped || data.skipped)) return { ok: false, code: 'line_skipped' };
  var status = Number(response.status || 0);
  if (status >= 200 && status < 300) return { ok: true, code: 'line_accepted' };
  return { ok: false, code: 'line_send_failed' };
}

function directoryFromDrivers(drivers) {
  var out = [];
  (drivers || []).forEach(function (row) {
    if (!row) return;
    var key = String(row.englishName || row.key || row.name || '').trim();
    var japaneseName = String(row.japaneseName || '').trim();
    if (!key && !japaneseName) return;
    out.push({
      key: key || japaneseName,
      japaneseName: japaneseName || key,
      company: String(row.company || '').trim(),
      lineId: String(row.lineId || '').trim()
    });
  });
  return out;
}

function sniff(bytes) {
  if (!bytes || bytes.length < 8) return '';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D) return 'application/pdf';
  return '';
}

function chunkMessages(messages, size) {
  var step = size || 5;
  var out = [];
  for (var i = 0; i < messages.length; i += step) out.push(messages.slice(i, i + step));
  return out;
}

function jpegSize(bytes) {
  var i = 2;
  while (i + 8 < bytes.length) {
    if (bytes[i] !== 0xFF) return null;
    while (i < bytes.length && bytes[i] === 0xFF) i += 1;
    if (i >= bytes.length) return null;
    var marker = bytes[i];
    i += 1;
    if (marker === 0xD8 || marker === 0x01) continue;
    if (marker === 0xD9 || marker === 0xDA) return null;
    if (i + 1 >= bytes.length) return null;
    var len = (bytes[i] << 8) + bytes[i + 1];
    if (len < 2 || i + len > bytes.length) return null;
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      if (len < 7) return null;
      var height = (bytes[i + 3] << 8) + bytes[i + 4];
      var width = (bytes[i + 5] << 8) + bytes[i + 6];
      if (!width || !height || width > 20000 || height > 20000) return null;
      return { width: width, height: height };
    }
    i += len;
  }
  return null;
}

function pngSize(bytes) {
  if (bytes.length < 24) return null;
  if (bytes.slice(12, 16).toString('ascii') !== 'IHDR') return null;
  var width = bytes.readUInt32BE(16);
  var height = bytes.readUInt32BE(20);
  if (!width || !height || width > 20000 || height > 20000) return null;
  return { width: width, height: height };
}

function directImagePage(bytes, mime) {
  if (bytes.length > PREVIEW_MAX) {
    return { error: 'size_exceeded', label: 'JPEGとPNGは1MB以下にしてください' };
  }
  var size = mime === 'image/jpeg' ? jpegSize(bytes) : pngSize(bytes);
  if (!size) return { error: 'invalid_file', label: '画像を確認できません' };
  return {
    pages: [{
      mime: mime,
      previewMime: mime,
      original: bytes,
      preview: bytes,
      width: size.width,
      height: size.height
    }]
  };
}

function createService(opts) {
  opts = opts || {};
  var ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
  if (ttlMs > MAX_TTL_MS) ttlMs = MAX_TTL_MS;
  var sets = {};
  var pageState = {};
  var retention = {
    confirmed: opts.retentionConfirmed === true,
    productionUnlocked: opts.allowProductionUnlock === false ? false : opts.productionUnlocked === true,
    testLineId: String(opts.retentionTestLineId || ''),
    probe: null
  };

  function now() {
    return opts.now ? opts.now() : new Date();
  }

  function originOf(input) {
    if (input && input.origin) return String(input.origin);
    return '';
  }

  async function loadDirectory() {
    if (typeof opts.directory !== 'function') return [];
    try {
      return directoryFromDrivers(await opts.directory());
    } catch (e) {
      return [];
    }
  }

  function resolveDestination(subjectName, master) {
    var hits = [];
    master.forEach(function (row) {
      if (Core.samePersonName(subjectName, row.key) || Core.samePersonName(subjectName, row.japaneseName)) hits.push(row);
    });
    if (!hits.length) return { status: 'missing' };
    var ids = [];
    hits.forEach(function (row) {
      if (!row.lineId || row.lineId.indexOf('U') !== 0) return;
      if (ids.indexOf(row.lineId) === -1) ids.push(row.lineId);
    });
    if (ids.length > 1) return { status: 'ambiguous' };
    if (ids.length === 1) {
      return { status: 'ok', lineId: ids[0], subjectId: hits[0].key, company: hits[0].company || '' };
    }
    return { status: 'unlinked' };
  }

  function blocked(base, code, label) {
    return {
      ok: false,
      sent: false,
      code: code,
      label: label,
      subjectName: base.subjectName || '',
      company: base.company || '',
      linkLabel: base.linkLabel || '',
      text: base.text || '',
      pageCount: base.pageCount || 0,
      imageSetId: base.imageSetId || '',
      previews: base.previews || [],
      acceptedPages: base.acceptedPages || [],
      uncertainPages: base.uncertainPages || [],
      viewed: false,
      viewedAvailable: false
    };
  }

  async function gate(input) {
    input = input || {};
    var base = {
      subjectName: String(input.subjectName || '').trim(),
      text: String(input.text || ''),
      company: '',
      linkLabel: ''
    };
    if (!base.subjectName || !Core.samePersonName(input.confirmSubject, base.subjectName)) {
      return { error: blocked(base, 'confirm_mismatch', '宛先を確認してください') };
    }
    var master = await loadDirectory();
    var destination = resolveDestination(base.subjectName, master);
    if (destination.status === 'ambiguous') return { error: blocked(base, 'ambiguous', '候補者が複数存在') };
    if (destination.status !== 'ok') return { error: blocked(base, 'unlinked', 'LINE未紐付け') };
    var claimed = String(input.lineId || '').trim();
    if (claimed && claimed !== destination.lineId) {
      return { error: blocked(base, 'mismatch', '宛先とマスタのLINE IDが一致しません') };
    }
    base.company = destination.company || '';
    base.linkLabel = 'LINE紐付け済み';
    base.subjectId = destination.subjectId || '';
    return { base: base, destination: destination, origin: originOf(input) };
  }

  function bytesOf(input) {
    if (Buffer.isBuffer(input.bytes)) return input.bytes;
    if (!input.fileBase64) return null;
    try { return Buffer.from(String(input.fileBase64), 'base64'); } catch (e) { return null; }
  }

  async function pagesFromFile(bytes) {
    if (!bytes || !bytes.length) return { error: 'invalid_file', label: 'ファイルを確認できません' };
    if (bytes.length > MAX_UPLOAD || bytes.length > ORIGINAL_MAX) return { error: 'size_exceeded', label: 'ファイルサイズが上限を超えています' };
    var mime = sniff(bytes);
    if (!mime) return { error: 'invalid_file', label: 'JPEG、PNG、PDF以外は送れません' };
    if (mime === 'application/pdf') return convertPdf(bytes);
    return directImagePage(bytes, mime);
  }

  async function convertPdf(bytes) {
    if (opts.pdfEnabled !== true) {
      return { error: 'pdf_unavailable', label: 'PDF変換はまだ有効ではありません。JPEGまたはPNGを選んでください' };
    }
    var render = opts.renderPdf;
    if (!render) {
      render = function (pdfBytes, limits) {
        return require('./dm-line-pdf-host.js').renderPdfPages(pdfBytes, limits);
      };
    }
    try {
      return {
        pages: await render(bytes, {
          maxPages: MAX_PAGES,
          originalMax: ORIGINAL_MAX,
          previewMax: PREVIEW_MAX
        })
      };
    } catch (err) {
      var code = err && err.code;
      if (code !== 'invalid_file' && code !== 'size_exceeded' && code !== 'image_convert_failed' && code !== 'pdf_unavailable' && code !== 'pdf_busy') {
        code = 'image_convert_failed';
      }
      var label = '画像変換失敗';
      if (code === 'size_exceeded') label = 'ファイルサイズが上限を超えています';
      if (code === 'invalid_file') label = 'PDFを確認できません';
      if (code === 'pdf_unavailable') label = 'PDF変換は使えません。JPEGまたはPNGを選んでください';
      if (code === 'pdf_busy') label = '別のPDF変換が実行中です。終わってからもう一度選んでください';
      if (code === 'image_convert_failed' && err && err.reason === 'timeout') label = 'PDF変換が時間内に終わりませんでした';
      return { error: code, label: label };
    }
  }

  function pageUrl(origin, id, page, token, preview) {
    var path = preview
      ? '/dm-line/preview/' + id + '/' + page + '/' + token
      : '/dm-line/file/' + id + '/' + page + '/' + token;
    return origin + path;
  }

  function previewList(stored, origin) {
    return stored.pages.map(function (page, index) {
      return {
        page: index + 1,
        mime: page.mime,
        width: page.width,
        height: page.height,
        originalBytes: page.original.length,
        previewBytes: page.preview.length,
        previewImageUrl: pageUrl(origin, stored.id, index + 1, page.token, true)
      };
    });
  }

  function read(id, page, token, kind) {
    var row = sets[id];
    if (!row || now().getTime() > row.expiresAt) {
      if (row) delete sets[id];
      return null;
    }
    var index = Number(page) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= row.pages.length) return null;
    var item = row.pages[index];
    var a = Buffer.from(String(token || ''));
    var b = Buffer.from(String(item.token || ''));
    if (!token || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    var body = kind === 'preview' ? item.preview : item.original;
    var mime = kind === 'preview' ? (item.previewMime || item.mime) : item.mime;
    return { body: body, mime: mime };
  }

  async function review(input) {
    var gated = await gate(input);
    if (gated.error) return gated.error;
    var built = await pagesFromFile(bytesOf(input));
    if (built.error) return blocked(gated.base, built.error, built.label);
    var id = crypto.randomBytes(18).toString('base64url');
    sets[id] = {
      id: id,
      expiresAt: now().getTime() + ttlMs,
      subjectName: gated.base.subjectName,
      lineId: gated.destination.lineId,
      pages: built.pages.map(function (page) {
        return {
          token: crypto.randomBytes(TOKEN_BYTES).toString('base64url'),
          mime: page.mime,
          previewMime: page.previewMime || page.mime,
          original: page.original,
          preview: page.preview,
          width: page.width,
          height: page.height
        };
      })
    };
    return {
      ok: false,
      sent: false,
      code: 'ready',
      label: '送信内容を確認できます',
      subjectName: gated.base.subjectName,
      company: gated.base.company,
      linkLabel: gated.base.linkLabel,
      text: gated.base.text,
      pageCount: sets[id].pages.length,
      imageSetId: id,
      previews: previewList(sets[id], gated.origin),
      acceptedPages: [],
      viewed: false,
      viewedAvailable: false
    };
  }

  function locationsOf(input) {
    var out = [];
    (input.locations || []).forEach(function (row) {
      if (!row) return;
      var lat = Number(row.latitude);
      var lng = Number(row.longitude);
      if (!isFinite(lat) || !isFinite(lng)) return;
      out.push({
        type: 'location',
        title: String(row.title || '場所').slice(0, 100),
        address: String(row.address || '').slice(0, 200),
        latitude: lat,
        longitude: lng
      });
    });
    return out;
  }

  function buildMessages(stored, origin, text, locations, accepted) {
    var messages = [];
    if (text && !accepted.text) messages.push({ type: 'text', text: text, kind: 'text' });
    if (stored) {
      stored.pages.forEach(function (page, index) {
        var pageNo = index + 1;
        if (accepted.pages[pageNo]) return;
        messages.push({
          type: 'image',
          kind: 'image',
          page: pageNo,
          originalContentUrl: pageUrl(origin, stored.id, pageNo, page.token, false),
          previewImageUrl: pageUrl(origin, stored.id, pageNo, page.token, true)
        });
      });
    }
    locations.forEach(function (location, index) {
      if (accepted.locations[index]) return;
      messages.push({
        type: 'location',
        kind: 'location',
        locationIndex: index,
        title: location.title,
        address: location.address,
        latitude: location.latitude,
        longitude: location.longitude
      });
    });
    return messages;
  }

  function outbound(messages) {
    return messages.map(function (message) {
      if (message.type === 'text') return { type: 'text', text: message.text };
      if (message.type === 'location') {
        return {
          type: 'location',
          title: message.title,
          address: message.address,
          latitude: message.latitude,
          longitude: message.longitude
        };
      }
      return {
        type: 'image',
        originalContentUrl: message.originalContentUrl,
        previewImageUrl: message.previewImageUrl
      };
    });
  }

  function retentionStatus() {
    var testConfigured = retention.testLineId.indexOf('U') === 0 && retention.testLineId.length >= 33;
    return {
      confirmed: retention.confirmed === true,
      productionUnlocked: retention.productionUnlocked === true,
      imageSendEnabled: retention.confirmed === true && retention.productionUnlocked === true,
      testConfigured: testConfigured,
      probe: retention.probe ? {
        imageSetId: retention.probe.imageSetId,
        accepted: retention.probe.accepted === true,
        revoked: retention.probe.revoked === true,
        visualCheck: retention.probe.visualCheck === true
      } : null
    };
  }

  function imageSendAllowed(lineId) {
    if (retention.testLineId && lineId === retention.testLineId) return 'test';
    if (retention.confirmed === true && retention.productionUnlocked === true) return 'production';
    if (retention.confirmed === true) return 'locked';
    return 'blocked';
  }

  async function perform(input) {
    input = input || {};
    var gated = await gate(input);
    if (gated.error) return gated.error;
    if (input.confirmed !== true) return blocked(gated.base, 'confirm_mismatch', '送信内容を確認してください');
    var text = String(input.text || '');
    var stored = null;
    if (input.imageSetId) {
      stored = sets[input.imageSetId];
      if (!stored || now().getTime() > stored.expiresAt) {
        if (stored) delete sets[stored.id];
        return blocked(gated.base, 'image_fetch_failed', '画像取得失敗');
      }
      if (!Core.samePersonName(stored.subjectName, gated.base.subjectName) || stored.lineId !== gated.destination.lineId) {
        return blocked(gated.base, 'mismatch', '宛先と添付が一致しません');
      }
    }
    var hasImage = !!(stored && stored.pages.length);
    if (!text && !hasImage && !(input.locations && input.locations.length)) {
      return blocked(gated.base, 'empty', '送信する内容がありません');
    }
    var https = /^https:\/\//i.test(gated.origin);
    if (hasImage && !https) return blocked(gated.base, 'insecure_delivery', '安全な画像配信ができないため送信しません');
    var allowance = hasImage ? imageSendAllowed(gated.destination.lineId) : 'ok';
    if (allowance === 'locked') return blocked(gated.base, 'production_locked', '本番の画像送信は解禁されていません');
    if (allowance === 'blocked') return blocked(gated.base, 'retention_unconfirmed', '試験用LINE ID以外へは送信しません');
    if (opts.imagesOnly === true && (text || locationsOf(input).length)) {
      return blocked(gated.base, 'images_only', '試験送信は画像だけです');
    }
    if (hasImage && opts.requiredPageCount && stored.pages.length !== Number(opts.requiredPageCount)) {
      return blocked(gated.base, 'page_count', '試験では2ページのPDFだけを送ります');
    }
    var live = opts.liveSendEnabled ? opts.liveSendEnabled() : false;
    if (!live) return blocked(gated.base, 'live_send_disabled', 'LINE送信は停止中です');
    var key = stored ? stored.id : ('text:' + Core.normalizePersonName(gated.base.subjectName));
    var accepted = pageState[key] || { text: false, pages: {}, locations: {} };
    var explicitResend = input.resend === true && input.confirmResend === true;
    var pendingImages = hasImage && stored.pages.some(function (page, index) { return !accepted.pages[index + 1]; });
    if ((accepted.text || !text) && !pendingImages && !explicitResend && hasImage && stored.pages.every(function (page, index) { return accepted.pages[index + 1]; })) {
      return blocked(gated.base, 'duplicate', 'この添付は送信済みです');
    }
    if (!explicitResend && hasImage && Object.keys(accepted.pages).length && pendingImages) {
      return blocked(Object.assign({}, gated.base, { acceptedPages: Object.keys(accepted.pages).map(Number) }), 'partial_hold', '一部の画像は受理済みです。自動再送はしません');
    }
    var uncertainPages = Object.keys(accepted.uncertain || {}).map(Number);
    var hasUnknown = uncertainPages.length > 0 || accepted.uncertainText === true;
    if (hasUnknown && !(input.confirmUnknown === true && input.confirmResend === true)) {
      return blocked(Object.assign({}, gated.base, {
        pageCount: stored ? stored.pages.length : 0,
        imageSetId: stored ? stored.id : '',
        acceptedPages: Object.keys(accepted.pages).map(Number),
        uncertainPages: uncertainPages
      }), 'delivery_unknown', '送信結果が不明です。自動再送はしません。トークを確認し、届いていなければ手動で再送してください');
    }
    if (hasUnknown) {
      accepted.uncertain = {};
      accepted.uncertainText = false;
    }
    var messages = buildMessages(stored, gated.origin, text, locationsOf(input), explicitResend && !pendingImages ? { text: false, pages: {}, locations: {} } : accepted);
    if (messages.some(function (message) { return message.type === 'text' && message.text.indexOf('/dm-line/file/') >= 0; })) {
      return blocked(gated.base, 'insecure_delivery', '画像URLを本文へは入れません');
    }
    var chunks = chunkMessages(messages, opts.maxPerPush || 5);
    for (var c = 0; c < chunks.length; c++) {
      var response;
      try {
        response = await opts.sendLine(gated.destination.lineId, outbound(chunks[c]));
      } catch (err) {
        if (deliveryUnknown(err)) {
          chunks[c].forEach(function (message) {
            if (message.kind === 'image' && !accepted.pages[message.page]) {
              accepted.uncertain = accepted.uncertain || {};
              accepted.uncertain[message.page] = true;
            }
            if (message.kind === 'text' && !accepted.text) accepted.uncertainText = true;
          });
        }
        pageState[key] = accepted;
        var unknownPages = Object.keys(accepted.uncertain || {}).map(Number);
        return blocked(Object.assign({}, gated.base, {
          pageCount: stored ? stored.pages.length : 0,
          imageSetId: stored ? stored.id : '',
          acceptedPages: Object.keys(accepted.pages).map(Number),
          uncertainPages: unknownPages
        }), deliveryUnknown(err) ? 'delivery_unknown' : 'line_send_failed', deliveryUnknown(err) ? '送信結果が不明です。自動再送はしません。トークを確認し、届いていなければ手動で再送してください' : 'LINE送信失敗');
      }
      var judged = acceptPush(response);
      if (!judged.ok) {
        pageState[key] = accepted;
        var skipped = judged.code === 'line_skipped';
        return blocked(gated.base, skipped ? 'line_skipped' : 'line_send_failed', skipped ? 'LINE送信は停止中のため未送信' : 'LINE送信失敗');
      }
      chunks[c].forEach(function (message) {
        if (message.kind === 'text') accepted.text = true;
        if (message.kind === 'image') accepted.pages[message.page] = true;
        if (message.kind === 'location') accepted.locations[message.locationIndex] = true;
      });
      pageState[key] = accepted;
    }
    if (hasImage && allowance === 'test') {
      retention.probe = { imageSetId: stored.id, accepted: true, revoked: false, visualCheck: false };
    }
    return {
      ok: true,
      sent: true,
      code: 'line_accepted',
      label: hasImage ? 'LINE API送信受理（閲覧は未確認）' : 'LINE API送信受理',
      subjectName: gated.base.subjectName,
      company: gated.base.company,
      linkLabel: gated.base.linkLabel,
      text: text,
      pageCount: stored ? stored.pages.length : 0,
      imageSetId: stored ? stored.id : '',
      previews: stored ? previewList(stored, gated.origin) : [],
      acceptedPages: Object.keys(accepted.pages).map(Number),
      viewed: false,
      viewedAvailable: false
    };
  }

  function revoke(imageSetId) {
    var id = String(imageSetId || '');
    if (!sets[id]) return { ok: false, code: 'image_fetch_failed', label: '画像取得失敗', retention: retentionStatus() };
    delete sets[id];
    if (retention.probe && retention.probe.imageSetId === id) retention.probe.revoked = true;
    return { ok: true, code: 'revoked', label: '試験画像のURLを破棄しました', retention: retentionStatus() };
  }

  function confirmRetention(input) {
    input = input || {};
    var probe = retention.probe;
    if (input.visualCheck !== true || !probe || !probe.accepted || !probe.revoked || probe.imageSetId !== input.imageSetId) {
      return { ok: false, code: 'retention_unconfirmed', label: '試験送信とURL削除のあと、トーク画像の残存を確認してください', retention: retentionStatus() };
    }
    retention.confirmed = true;
    probe.visualCheck = true;
    return { ok: true, code: 'retention_confirmed', label: '画像保持を確認しました。本番送信は未解禁です', retention: retentionStatus() };
  }

  function unlockProduction(input) {
    input = input || {};
    if (opts.allowProductionUnlock === false) {
      retention.productionUnlocked = false;
      return { ok: false, code: 'production_locked', label: 'このサーバでは本番解禁はできません', retention: retentionStatus() };
    }
    if (retention.confirmed !== true) {
      return { ok: false, code: 'retention_unconfirmed', label: '画像保持の確認が先です', retention: retentionStatus() };
    }
    if (input.unlockProduction !== true) {
      return { ok: false, code: 'production_locked', label: '本番解禁には明示の操作が必要です', retention: retentionStatus() };
    }
    retention.productionUnlocked = true;
    return { ok: true, code: 'production_unlocked', label: '本番の画像送信を解禁しました', retention: retentionStatus() };
  }

  return {
    review: review,
    perform: perform,
    read: read,
    retention: retentionStatus,
    revoke: revoke,
    confirmRetention: confirmRetention,
    unlockProduction: unlockProduction
  };
}

function singleTestDirectory(lineId) {
  var id = String(lineId || '').trim();
  if (!/^U[0-9a-f]{32}$/i.test(id)) {
    var error = new Error('test line id required');
    error.code = 'test_id_missing';
    throw error;
  }
  return [{
    key: '試験アカウント',
    japaneseName: '試験アカウント',
    company: '試験',
    lineId: id
  }];
}

module.exports = {
  createService: createService,
  liveSendAllowed: liveSendAllowed,
  resolvePublicOrigin: resolvePublicOrigin,
  acceptPush: acceptPush,
  directoryFromDrivers: directoryFromDrivers,
  sniff: sniff,
  chunkMessages: chunkMessages,
  jpegSize: jpegSize,
  pngSize: pngSize,
  PREVIEW_MAX: PREVIEW_MAX,
  singleTestDirectory: singleTestDirectory
};
