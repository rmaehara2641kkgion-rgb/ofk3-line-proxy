/**
 * 請求照合の対象者取込と PDF 自動振り分け。
 * DOM・LINE送信APIには依存しない。
 *
 * 有効行は氏名（C列）または TID（B列）で判定する。
 * A列が空でも行全体は捨てない。TIDは driverKey にコピーしない
 * （別ドライバーの TransportID へ送信先を付け替えないため）。
 *
 * PDFの自動送信は、空白差を除いた氏名の一意一致だけ。
 * 部分一致・複数候補・読込失敗は sendable=false。
 * 同一対象者へ2件以上割り当てた場合も sendable=false。先着も後着も採用しない。
 */
(function (global) {
  'use strict';

  var DAY_LABELS = ['11B', '8B', 'B1', 'B2', 'biker', '嘉麻応援', 'C1', 'C3'];
  var NAME_CHAR = /[\u4E00-\u9FFF\u3040-\u30FF]/;
  var KANA_ONLY = /^[\u30A0-\u30FF\u30FC\u3040-\u309F]+$/;

  function cellText(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/\u00A0/g, ' ').trim();
  }

  function parseNum(val) {
    if (!val) return 0;
    var s = val.toString().replace(/[¥,\s]/g, '');
    return parseInt(s, 10) || 0;
  }

  function looksLikeTransportId(s) {
    return /^[A-Za-z][A-Za-z0-9]{8,}$/.test(s);
  }

  function normalizePersonName(s) {
    return String(s == null ? '' : s).replace(/[\s\u3000\u00A0\r\n\f\v]+/g, '');
  }

  function nameTokens(s) {
    return String(s == null ? '' : s).trim().split(/[\s\u3000\u00A0\r\n]+/).filter(function (part) {
      return part.length > 0;
    });
  }

  function samePersonName(a, b) {
    var na = normalizePersonName(a);
    var nb = normalizePersonName(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    var ta = nameTokens(a);
    var tb = nameTokens(b);
    return ta.length === 2 && tb.length === 2 && ta[0] === tb[1] && ta[1] === tb[0];
  }

  function isKanaReading(s) {
    var n = normalizePersonName(s);
    return n.length >= 2 && KANA_ONLY.test(n);
  }

  function parseBillingRows(rows) {
    var out = [];
    if (!rows || !rows.length) return out;
    var startRow = 2;
    var scan = Math.min(rows.length, 5);
    for (var h = 0; h < scan; h++) {
      var headerRow = rows[h];
      if (headerRow && headerRow.join && String(headerRow.join('')).indexOf('宛名') >= 0) {
        startRow = h + 1;
        break;
      }
    }
    for (var i = startRow; i < rows.length; i++) {
      var row = rows[i];
      if (!row) continue;
      var colA = cellText(row[0]);
      var colB = cellText(row[1]);
      var name = cellText(row[2]);
      var tid = '';
      if (looksLikeTransportId(colB)) tid = colB;
      else if (looksLikeTransportId(colA)) tid = colA;
      if (!name && !tid) continue;

      var driverKey = colA;
      var workDays = 0;
      var breakdown = [];
      for (var c = 3; c <= 10; c++) {
        var v = parseInt(row[c], 10) || 0;
        workDays += v;
        if (v > 0) breakdown.push(DAY_LABELS[c - 3] + ': ' + v + '日');
      }
      out.push({
        driverKey: driverKey,
        tid: tid,
        name: name,
        workDays: workDays,
        breakdown: breakdown,
        sysUsageFlag: cellText(row[11]),
        sysUsageFee: parseNum(row[17]),
        sundayBonus: cellText(row[12]),
        charter: parseNum(row[13]),
        mileage: parseNum(row[14]),
        deduction: parseNum(row[15]),
        subtotal: parseNum(row[16]),
        tax: parseNum(row[18]),
        total: parseNum(row[19]),
        selected: true
      });
    }
    return out;
  }

  function hasPdfMagic(bytes) {
    if (!bytes || bytes.length < 5) return false;
    return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D;
  }

  function classifyPdfUpload(meta, bytes) {
    meta = meta || {};
    var name = String(meta.name || '');
    var type = String(meta.type || '').toLowerCase();
    var ext = /\.pdf$/i.test(name);
    var mime = type === 'application/pdf' || type === 'application/x-pdf';
    var magic = hasPdfMagic(bytes);
    if (!ext && !mime && !magic) return { ok: false, reason: 'not_pdf' };
    if (!magic) return { ok: false, reason: 'bad_magic' };
    return { ok: true, reason: '' };
  }

  function latin1FromBytes(bytes) {
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(bytes)) {
      return bytes.toString('latin1');
    }
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function decodePdfHex(hex) {
    if (!hex || hex.length < 4 || hex.length % 2) return '';
    var bytes = [];
    for (var i = 0; i < hex.length; i += 2) {
      var n = parseInt(hex.substr(i, 2), 16);
      if (isNaN(n)) return '';
      bytes.push(n);
    }
    if (!(bytes[0] === 0xFE && bytes[1] === 0xFF)) return '';
    var out = '';
    for (var j = 2; j + 1 < bytes.length; j += 2) {
      out += String.fromCharCode((bytes[j] << 8) | bytes[j + 1]);
    }
    return out;
  }

  function decodePdfLiteral(body) {
    var out = '';
    for (var i = 0; i < body.length; i++) {
      var ch = body.charAt(i);
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      var n = body.charAt(++i);
      if (n === 'n') out += '\n';
      else if (n === 'r') out += '\r';
      else if (n === 't') out += '\t';
      else if (n === '(' || n === ')' || n === '\\') out += n;
      else out += n;
    }
    return out;
  }

  function extractPdfText(bytes) {
    if (!bytes) return '';
    var src = latin1FromBytes(bytes);
    if (src.indexOf('%PDF-') < 0) return '';
    var parts = [];
    var hexRe = /<([0-9A-Fa-f\s]+)>\s*Tj/g;
    var m;
    while ((m = hexRe.exec(src))) {
      var text = decodePdfHex(m[1].replace(/\s+/g, ''));
      if (text) parts.push(text);
    }
    var litRe = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
    while ((m = litRe.exec(src))) {
      var lit = decodePdfLiteral(m[1]);
      if (lit) parts.push(lit);
    }
    return parts.join('\n');
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function textHasPersonName(text, displayName) {
    var raw = String(text || '');
    var tokens = nameTokens(displayName);
    if (!tokens.length) return false;
    if (tokens.length === 1 && normalizePersonName(tokens[0]).length < 2) return false;
    var between = '[\\s\\u3000\\u00A0\\r\\n]*';
    var body = tokens.map(escapeRegExp).join(between);
    var honor = '(?:[\\s\\u3000\\u00A0\\r\\n]*(?:様|殿|氏|君|さん|御中))?';
    var re = new RegExp('(?:^|[^\\u4E00-\\u9FFF\\u3040-\\u30FF])' + body + honor + '(?![\\u4E00-\\u9FFF\\u3040-\\u30FF])');
    return re.test(raw);
  }

  function extractBracketName(filename) {
    var m = String(filename || '').match(/【(.+?)(?:DA|ＤＡ)?】/);
    return m ? String(m[1]).trim() : '';
  }

  function targetsNamed(targets, rawName) {
    var hits = [];
    var norm = normalizePersonName(rawName);
    if (!norm) return hits;
    for (var i = 0; i < targets.length; i++) {
      if (normalizePersonName(targets[i].name) === norm) hits.push(targets[i]);
    }
    return hits;
  }

  function kanjiHits(text, targets) {
    var hits = [];
    for (var i = 0; i < targets.length; i++) {
      if (!targets[i].name || isKanaReading(targets[i].name)) continue;
      if (textHasPersonName(text, targets[i].name)) hits.push(targets[i]);
    }
    return hits;
  }

  function readingsForTarget(readings, target) {
    var out = [];
    var keys = Object.keys(readings || {});
    for (var i = 0; i < keys.length; i++) {
      if (!samePersonName(keys[i], target.name)) continue;
      var list = readings[keys[i]] || [];
      for (var j = 0; j < list.length; j++) out.push(list[j]);
    }
    return out;
  }

  function kanaHits(text, targets, readings) {
    var hits = [];
    for (var i = 0; i < targets.length; i++) {
      var list = readingsForTarget(readings, targets[i]);
      for (var j = 0; j < list.length; j++) {
        if (textHasPersonName(text, list[j])) {
          hits.push(targets[i]);
          break;
        }
      }
    }
    return hits;
  }

  function resultOf(file, code, target) {
    var labels = {
      matched: target ? target.name : '',
      unmatched: '対象者を特定できません',
      ambiguous: '候補者が複数存在',
      read_error: 'PDF読込失敗',
      extract_failed: '氏名抽出失敗',
      not_pdf: 'PDFとして認識されません'
    };
    return {
      filename: (file && file.filename) || '',
      code: code,
      label: labels[code] || '',
      targetName: target ? target.name : '',
      target: target || null,
      sendable: code === 'matched'
    };
  }

  function assignOne(file, targets, readings) {
    file = file || {};
    if (file.error === 'not_pdf') return resultOf(file, 'not_pdf', null);
    if (file.error === 'read_error' || file.error === 'bad_magic') return resultOf(file, 'read_error', null);

    var text = String(file.text || '');
    var kanji = kanjiHits(text, targets);
    if (kanji.length > 1) return resultOf(file, 'ambiguous', null);
    var textTarget = kanji.length === 1 ? kanji[0] : null;
    if (!textTarget) {
      var kana = kanaHits(text, targets, readings);
      if (kana.length > 1) return resultOf(file, 'ambiguous', null);
      if (kana.length === 1) textTarget = kana[0];
    }

    var bracket = extractBracketName(file.filename);
    var fileHits = bracket ? targetsNamed(targets, bracket) : [];
    var fileTarget = fileHits.length === 1 ? fileHits[0] : null;
    if (fileHits.length > 1) return resultOf(file, 'ambiguous', null);
    if (textTarget && fileTarget && normalizePersonName(textTarget.name) !== normalizePersonName(fileTarget.name)) {
      return resultOf(file, 'ambiguous', null);
    }
    if (textTarget) return resultOf(file, 'matched', textTarget);
    if (fileTarget) return resultOf(file, 'matched', fileTarget);
    if (!text.replace(/\s/g, '') && !bracket) return resultOf(file, 'extract_failed', null);
    return resultOf(file, 'unmatched', null);
  }

  var DUPLICATE_PDF_WARNING = '同一対象者に複数PDFがあります';

  // 同一対象者に2件以上の一意一致があるとき、その対象者のPDFはすべて送信不可。
  // 1件に戻したあと再度呼ぶと、残った一致は送信可に戻る。PDFの中身は結合しない。
  function applyDuplicatePdfBlock(results) {
    results = results || [];
    var counts = {};
    for (var i = 0; i < results.length; i++) {
      var row = results[i];
      if (!row || row.code !== 'matched' || !row.targetName) continue;
      var key = normalizePersonName(row.targetName);
      counts[key] = (counts[key] || 0) + 1;
    }
    for (var j = 0; j < results.length; j++) {
      var item = results[j];
      if (!item || item.code !== 'matched' || !item.targetName) continue;
      var dup = counts[normalizePersonName(item.targetName)] >= 2;
      item.sendable = !dup;
      item.duplicateTarget = dup;
      item.duplicateWarning = dup ? DUPLICATE_PDF_WARNING : '';
    }
    return results;
  }

  function assignBillingPdfs(files, targets, options) {
    var readings = (options && options.readings) || {};
    var list = files || [];
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(assignOne(list[i], targets || [], readings));
    return applyDuplicatePdfBlock(out);
  }

  function collectNameReadings(targets, master) {
    targets = targets || [];
    master = master || {};
    var pairs = [];
    var jp = master.driverJapaneseNames || {};
    var aliases = master.driverNameAliases || {};
    Object.keys(jp).forEach(function (k) { pairs.push([k, jp[k]]); });
    Object.keys(aliases).forEach(function (k) { pairs.push([k, aliases[k]]); });
    var readings = {};
    function add(target, reading) {
      if (!isKanaReading(reading)) return;
      var key = target.name;
      if (!readings[key]) readings[key] = [];
      var n = normalizePersonName(reading);
      for (var i = 0; i < readings[key].length; i++) {
        if (normalizePersonName(readings[key][i]) === n) return;
      }
      readings[key].push(reading);
    }
    pairs.forEach(function (pair) {
      [[pair[0], pair[1]], [pair[1], pair[0]]].forEach(function (side) {
        if (!isKanaReading(side[1])) return;
        var hits = [];
        for (var i = 0; i < targets.length; i++) {
          if (samePersonName(targets[i].name, side[0])) hits.push(targets[i]);
        }
        if (hits.length === 1) add(hits[0], side[1]);
      });
    });
    return readings;
  }

  function matchUniqueTarget(targets, rawName) {
    var hits = targetsNamed(targets || [], rawName);
    return hits.length === 1 ? hits[0] : null;
  }

  // 表示専用。マスタも送信先も書き換えない。
  // masterNames が空なら不一致とは扱わない。1件でも同一人物なら警告しない。
  function tidNameMismatch(billingName, masterNames) {
    masterNames = masterNames || [];
    if (!billingName || !masterNames.length) return false;
    for (var i = 0; i < masterNames.length; i++) {
      if (samePersonName(billingName, masterNames[i])) return false;
    }
    return true;
  }

  var api = {
    parseBillingRows: parseBillingRows,
    normalizePersonName: normalizePersonName,
    samePersonName: samePersonName,
    textHasPersonName: textHasPersonName,
    classifyPdfUpload: classifyPdfUpload,
    extractPdfText: extractPdfText,
    extractBracketName: extractBracketName,
    assignBillingPdfs: assignBillingPdfs,
    applyDuplicatePdfBlock: applyDuplicatePdfBlock,
    collectNameReadings: collectNameReadings,
    matchUniqueTarget: matchUniqueTarget,
    tidNameMismatch: tidNameMismatch,
    hasPdfMagic: hasPdfMagic
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.BillingReconcile = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
