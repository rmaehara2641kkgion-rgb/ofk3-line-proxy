/**
 * OFK3 DNR — 明細パススルー処理コア（DOM非依存の純粋関数のみ）
 *
 * index.html の既存DNR処理（handleDnrFile 18473-18557 / exportDnrResult 18881-18908、
 * 現行main時点の行番号）から、DOM/ブラウザAPI（FileReader・document・localStorage・
 * alert・Leafletマップ・LINE送信）に依存しない部分だけを抽出したもの。
 *
 * 現時点では render-webhook-server.js（/dnr-export）からのみ require('./dnr-core.js') で
 * 利用する。index.html 側は今回変更しない。将来的に index.html のインライン実装をこの
 * core呼び出しへ置き換える際も、ここに定義した関数のシグネチャ（純粋関数・DOM非依存）は
 * そのまま流用できるように設計している。
 *
 * 既存仕様からの意図的な変更点（ユーザー指示により今回追加）:
 *   - handleDnrFile にあった「TransportID列が見つからない場合、ヘッダーが8列超なら
 *     9列目を強制的にTID列とみなす」というフォールバックは削除した（自動化APIでは危険なため）。
 *   - dnrDetectSignal() は新規追加。TID列に加え、DNR固有色の強い列（DNR_STRONG_SIGNAL_COLS）が
 *     最低1つ無ければ「DNRファイルではない」と判定できるようにした（原本のhandleDnrFileには
 *     この判定自体が無かった）。
 *   - dnrTranslateReason() は既存の translateReason()（index.html:18318）とは別物。辞書に
 *     完全一致する値だけを翻訳し、一致しない場合は原文をそのまま返す（既存translateReasonに
 *     ある「英字除去して日本語部分だけ残す」フォールバックは持ち込んでいない）。
 */
(function (global) {
  'use strict';

  // index.html: DNR_KEEP_COLS (18458) を値そのまま移植
  var DNR_KEEP_COLS = [
    'delivery_date_jst', 'delivery_station_code', 'provider_company_name',
    'transporter_id', 'tracking_id', 'shipment_reason', 'bucket', 'sub_bucket',
    'state', 'postal_code', 'address', 'scan_gps_latitude', 'scan_gps_longitude',
    'conceded_units', 'dnr_cost_jpy'
  ];

  // index.html: DNR_COL_LABELS (18459-18466) を値そのまま移植
  var DNR_COL_LABELS = {
    'delivery_date_jst': '配達日', 'delivery_station_code': 'DS', 'provider_company_name': 'DSP名',
    'transporter_id': 'TransportID', 'tracking_id': 'TrackingID', 'shipment_reason': 'DNR理由',
    'bucket': '分類', 'sub_bucket': '詳細分類',
    'state': '都道府県', 'postal_code': '郵便番号', 'address': '住所',
    'scan_gps_latitude': '緯度', 'scan_gps_longitude': '経度',
    'conceded_units': '個数', 'dnr_cost_jpy': '金額(円)'
  };

  // DNR固有と判定するための列（新規）。DNR_KEEP_COLSのうち、tracking_id/shipment_reason/
  // delivery_station_code はFTDS・CC等の他ファイル種別にも同名列が存在しうる（調査で確認済み）
  // ため対象から除外し、DNRにしか通常現れない列名のみを「強いシグナル」として扱う。
  var DNR_STRONG_SIGNAL_COLS = [
    'delivery_date_jst', 'provider_company_name', 'bucket', 'sub_bucket',
    'state', 'postal_code', 'address', 'scan_gps_latitude', 'scan_gps_longitude',
    'conceded_units', 'dnr_cost_jpy'
  ];

  // index.html: handleDnrFile内のヘッダー正規化（18493）を移植。normalizeReportHeader（FTDS/CC用）
  // とは別物で、BOM除去や空白/アンダースコア統一は行わない既存の簡易実装のまま。
  function dnrNormalizeHeaderCell(h) {
    return String(h || '').trim().toLowerCase();
  }

  // index.html: handleDnrFile内のTID列ファジーマッチ（18502-18506）を移植。
  // 「transporter_id」完全一致、または空白/アンダースコア除去後「transporterid」「transportid」
  // に一致する表記ゆれを許容する（既存仕様のまま。9列目フォールバックのみ削除）。
  function dnrIsTransporterIdHeader(h) {
    var n = dnrNormalizeHeaderCell(h);
    if (n === 'transporter_id') return true;
    var compact = n.replace(/[_\s]/g, '');
    return compact === 'transporterid' || compact === 'transportid';
  }

  // ヘッダー行から { colIdx: {正規化ヘッダー名: 列index}, tidIdx: number(-1は未検出) } を構築。
  // 同名ヘッダーが複数ある場合は既存同様、後に出現した列で上書きされる（原本と同じ挙動）。
  function dnrMapHeaderColumns(headerRow) {
    var colIdx = {};
    for (var h = 0; h < headerRow.length; h++) {
      colIdx[dnrNormalizeHeaderCell(headerRow[h])] = h;
    }
    var tidIdx = colIdx['transporter_id'] !== undefined ? colIdx['transporter_id'] : -1;
    if (tidIdx < 0) {
      for (var key in colIdx) {
        if (dnrIsTransporterIdHeader(key)) { tidIdx = colIdx[key]; break; }
      }
    }
    return { colIdx: colIdx, tidIdx: tidIdx };
  }

  // 新規: このヘッダー行がDNRファイルとして合理的に受理できるか。
  // TID列が見つかり、かつDNR_STRONG_SIGNAL_COLSのいずれか1つ以上が存在することを要求する。
  function dnrDetectSignal(colMap) {
    if (!colMap || colMap.tidIdx < 0) return false;
    for (var i = 0; i < DNR_STRONG_SIGNAL_COLS.length; i++) {
      if (colMap.colIdx[DNR_STRONG_SIGNAL_COLS[i]] !== undefined) return true;
    }
    return false;
  }

  // index.html: handleDnrFile内のドライバー表示名生成（18524-18526）を移植。
  // 日本語名があれば「日本語名 (英語名)」、無ければ英語名のみ（英語名も無ければ空文字）。
  function dnrResolveDriverDisplayName(englishName, japaneseName) {
    var en = englishName || '';
    if (japaneseName) return japaneseName + ' (' + en + ')';
    return en;
  }

  // 新規（既存translateReasonとは別物）: dictに完全一致する値だけを翻訳する。
  // 一致しない場合は原文をそのまま返す（英字除去等のフォールバック変換はしない）。
  function dnrTranslateReason(reason, dict) {
    if (!reason) return '';
    if (dict && Object.prototype.hasOwnProperty.call(dict, reason)) return dict[reason];
    return reason;
  }

  // index.html: handleDnrFile内の1行分の抽出処理（18516-18535）を移植（ドライバー照合部分を除く。
  // 照合はマスタ取得後に呼び出し側で行う）。TransportIDが空でも rec は生成する
  // （既存仕様どおり、TID空欄を理由に行を落とさない）。
  function dnrExtractRow(row, colMap) {
    var tidIdx = colMap.tidIdx;
    var transportId = (tidIdx >= 0 && row[tidIdx] !== undefined && row[tidIdx] !== null) ? String(row[tidIdx]).trim() : '';
    var rec = { transportId: transportId, driverName: '' };
    for (var k = 0; k < DNR_KEEP_COLS.length; k++) {
      var col = DNR_KEEP_COLS[k];
      var idx = colMap.colIdx[col];
      rec[col] = (idx !== undefined && row[idx] !== undefined && row[idx] !== null) ? String(row[idx]).trim() : '';
    }
    return rec;
  }

  // index.html: handleDnrFile内の行ループ（18511-18543）を移植。
  // 除外するのは「行そのものが空」の場合のみ（既存仕様どおり。TID空欄では除外しない）。
  function dnrExtractRows(rows, headerIdx, colMap) {
    var out = [];
    for (var i = headerIdx + 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row || row.length === 0) continue;
      out.push(dnrExtractRow(row, colMap));
    }
    return out;
  }

  // ---- 日時の表示変換（表示層・出力層のみ。取込済みの元の値 rec.delivery_date_jst は変更しない） ----
  //
  // Amazon DNRファイルの delivery_date_jst / reporting_date は「YYYY-MM-DD 00:00:00」形式の日付のみの値で、
  // 時刻情報を持たない（00:00:00 は時刻ではなく日付のみを表すプレースホルダー）。したがって
  //   - 時刻部分が 00:00:00 以外 → 時刻あり: 「YYYY/MM/DD HH」（JST）
  //   - 日付のみ / 00:00:00     → 「YYYY/MM/DD 時刻不明」（00:00 を発生時刻として表示しない）
  //   - 解釈できない値           → 原文のまま（情報を落とさない）
  // 注意: 配達日(delivery_date_jst)は配達日であり DNR発生日時ではない。両者を混同しないため、この関数は
  // 配達日列の表記だけを整える（列名・値の意味は変えない）。

  function dnrPad2(n) { return (n < 10 ? '0' : '') + n; }

  var DNR_JST_OFFSET_MIN = 9 * 60;

  // Excel シリアル値 → { y, mo, d, h, mi, s }（シリアルは日付のセル値そのもの＝JSTの壁時計。タイムゾーン変換なし）
  function dnrSerialToParts(v) {
    if (typeof v !== 'number' || !isFinite(v) || v < 20000 || v > 80000) return null;
    var whole = Math.floor(v);
    var secs = Math.round((v - whole) * 86400);
    if (secs >= 86400) { whole += 1; secs -= 86400; }
    var dt = new Date(Math.round((whole - 25569) * 86400000));
    return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(),
      h: Math.floor(secs / 3600), mi: Math.floor((secs % 3600) / 60), s: secs % 60 };
  }

  // 値 → { y, mo, d, h, mi, s, hasTime } | null。
  // 文字列: 「YYYY-MM-DD[ T]HH[:mm[:ss]][.fff][Z|±hh[:mm]]」「YYYY/MM/DD HH」等。
  //   タイムゾーン指定（Z / ±hh:mm）がある場合だけ JST（+09:00）へ換算する。指定が無い値は JST とみなす
  //   （delivery_date_jst はすでにJST）。「時刻不明」など時刻として読めない後続文字列は日付のみ扱い。
  function dnrParseDateTime(v) {
    if (v === null || v === undefined || v === '') return null;
    var parts = null;
    if (Object.prototype.toString.call(v) === '[object Date]') {
      if (isNaN(v.getTime())) return null;
      // Date オブジェクトは絶対時刻として扱い JST に換算する
      var j = new Date(v.getTime() + DNR_JST_OFFSET_MIN * 60000);
      parts = { y: j.getUTCFullYear(), mo: j.getUTCMonth() + 1, d: j.getUTCDate(), h: j.getUTCHours(), mi: j.getUTCMinutes(), s: j.getUTCSeconds() };
    } else if (typeof v === 'number') {
      parts = dnrSerialToParts(v);
    } else {
      var str = String(v).replace(/ /g, ' ').trim();
      var m = str.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ T]+(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?/i);
      if (!m) return null;
      parts = { y: +m[1], mo: +m[2], d: +m[3], h: m[4] !== undefined ? +m[4] : 0, mi: m[5] !== undefined ? +m[5] : 0, s: m[6] !== undefined ? +m[6] : 0 };
      if (m[7]) {
        var off = 0;
        if (m[7].toUpperCase() !== 'Z') {
          var sign = m[7].charAt(0) === '-' ? -1 : 1;
          var digits = m[7].slice(1).replace(':', '');
          off = sign * (parseInt(digits.slice(0, 2), 10) * 60 + (digits.length > 2 ? parseInt(digits.slice(2, 4), 10) : 0));
        }
        var base = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s) - off * 60000 + DNR_JST_OFFSET_MIN * 60000;
        var jd = new Date(base);
        parts = { y: jd.getUTCFullYear(), mo: jd.getUTCMonth() + 1, d: jd.getUTCDate(), h: jd.getUTCHours(), mi: jd.getUTCMinutes(), s: jd.getUTCSeconds() };
      }
    }
    if (!parts) return null;
    parts.hasTime = !(parts.h === 0 && parts.mi === 0 && parts.s === 0);
    return parts;
  }

  var DNR_TIME_UNKNOWN_LABEL = '時刻不明';

  // 表示用の文字列。空値は ''、解釈できない値は原文（trim）のまま。
  function dnrFormatOccurrence(v) {
    if (v === null || v === undefined || v === '') return '';
    var p = dnrParseDateTime(v);
    if (!p) return String(v).trim();
    var date = p.y + '/' + dnrPad2(p.mo) + '/' + dnrPad2(p.d);
    return date + ' ' + (p.hasTime ? dnrPad2(p.h) : DNR_TIME_UNKNOWN_LABEL);
  }

  // Excel の日時セル（数値）→ 取込用の文字列「YYYY-MM-DD HH:MM:SS」。時刻の欠落を防ぐための取込補助。
  function dnrSerialToDateTimeString(v) {
    var p = dnrSerialToParts(v);
    if (!p) return null;
    return p.y + '-' + dnrPad2(p.mo) + '-' + dnrPad2(p.d) + ' ' + dnrPad2(p.h) + ':' + dnrPad2(p.mi) + ':' + dnrPad2(p.s);
  }

  // index.html: exportDnrResult のCSV行列生成部分（18881-18897）を移植。
  // ヘッダー行＋データ行の2次元配列を返す。文字列化（クォート/エスケープ/BOM等）や
  // 出力フォーマット（CSV/xlsx等）は呼び出し側の責務とし、ここでは持たない。
  // 新規（実データ比較で発見した既存アプリとの表記差の修正）: 「詳細分類」(sub_bucket)列だけに
  // 適用する表示正規化。アンダースコアを半角スペースに変換するのみ（大文字小文字は変更しない）。
  // 既存アプリのtranslateReason()は辞書未一致時のフォールバックとして`_`→半角スペース変換を
  // 行っており（index.html:18326 `return reason.replace(/_/g, ' ');`）、DNRの実データ出力でも
  // その変換結果が最終的な「詳細分類」表示として使われていた。dnrTranslateReason()はDNR用に
  // 辞書完全一致のみを翻訳し他のフォールバックは持ち込まない設計にしたため、この1点（アンダー
  // スコア→スペース）だけを独立した正規化として追加する。shipment_reason・bucket列や
  // TransportID・TrackingID等の他列には適用しない。
  function dnrNormalizeSubBucketDisplay(val) {
    return String(val || '').replace(/_/g, ' ');
  }

  function dnrBuildExportRows(recs, reasonDict) {
    var header = ['ドライバー'];
    for (var k = 0; k < DNR_KEEP_COLS.length; k++) {
      header.push(DNR_COL_LABELS[DNR_KEEP_COLS[k]] || DNR_KEEP_COLS[k]);
    }
    var rows = [header];
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      var row = [r.driverName || '未特定'];
      for (var k2 = 0; k2 < DNR_KEEP_COLS.length; k2++) {
        var col = DNR_KEEP_COLS[k2];
        var val = r[col] || '';
        if (col === 'shipment_reason' || col === 'sub_bucket' || col === 'bucket') {
          // 辞書ルックアップは元の値（アンダースコア含む）で行う。辞書キー自体に
          // アンダースコアを含むもの（例: 'No Item_delivery box'）があるため、
          // 正規化より先に翻訳を行う必要がある。
          val = dnrTranslateReason(val, reasonDict);
        }
        if (col === 'sub_bucket') {
          val = dnrNormalizeSubBucketDisplay(val);
        }
        if (col === 'delivery_date_jst') {
          val = dnrFormatOccurrence(val);
        }
        row.push(val);
      }
      rows.push(row);
    }
    return rows;
  }

  var DnrCore = {
    DNR_KEEP_COLS: DNR_KEEP_COLS,
    DNR_COL_LABELS: DNR_COL_LABELS,
    DNR_STRONG_SIGNAL_COLS: DNR_STRONG_SIGNAL_COLS,
    dnrNormalizeHeaderCell: dnrNormalizeHeaderCell,
    dnrIsTransporterIdHeader: dnrIsTransporterIdHeader,
    dnrMapHeaderColumns: dnrMapHeaderColumns,
    dnrDetectSignal: dnrDetectSignal,
    dnrResolveDriverDisplayName: dnrResolveDriverDisplayName,
    dnrTranslateReason: dnrTranslateReason,
    dnrNormalizeSubBucketDisplay: dnrNormalizeSubBucketDisplay,
    dnrExtractRow: dnrExtractRow,
    dnrExtractRows: dnrExtractRows,
    dnrBuildExportRows: dnrBuildExportRows,
    DNR_TIME_UNKNOWN_LABEL: DNR_TIME_UNKNOWN_LABEL,
    dnrParseDateTime: dnrParseDateTime,
    dnrFormatOccurrence: dnrFormatOccurrence,
    dnrSerialToDateTimeString: dnrSerialToDateTimeString
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = DnrCore;
  }
  if (typeof global !== 'undefined') {
    global.DnrCore = DnrCore;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
