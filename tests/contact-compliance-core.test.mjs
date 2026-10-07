// contact-compliance-core.js（CC Logic Version 1）のユニットテストと Wk40 OFK3 実データ検証。
// 実データ fixture は Scannable ID / Destination Address ID のみ仮名化（同一値は同一仮名）。
// 判定・集計に使う列（Event Date / Transporter ID / Shipment Reason / Call Event / Text Event）は原本のまま。
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
const require = createRequire(import.meta.url);
const Cc = require('../contact-compliance-core.js');
const XLSX = require('xlsx');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

function rec(reason, callEvent, textEvent, extra) {
  var r = {
    eventDate: '2026-09-27',
    scannableId: 'SID1',
    destinationAddressId: 'DEST1',
    transporterId: 'TID1',
    shipmentReason: reason,
    callEvent: callEvent || '',
    textEvent: textEvent || ''
  };
  for (var k in (extra || {})) r[k] = extra[k];
  return r;
}

var CALL = 'Calls to Customer';
var TEXT = 'Text to Customer';
var S = Cc.CC_STATUS;

// ---- 必須テスト 1〜8: 判定 ----
function testStatusJudgment() {
  assert(Cc.getCcStatus(rec('CUSTOMER_UNAVAILABLE', CALL, '')) === S.COMPLIANT, '1. 不在 + Call → Compliant');
  assert(Cc.getCcStatus(rec('CUSTOMER_UNAVAILABLE', '', TEXT)) === S.COMPLIANT, '2. 不在 + Text → Compliant');
  assert(Cc.getCcStatus(rec('CUSTOMER_UNAVAILABLE', '', '')) === S.NON_COMPLIANT, '3. 不在 + なし → Non-Compliant');
  assert(Cc.getCcStatus(rec('INACCESSIBLE_DELIVERY_LOCATION', CALL, '')) === S.COMPLIANT, '4. アクセス不可 + Call → Compliant');
  assert(Cc.getCcStatus(rec('ADDRESS_NOT_FOUND', '', TEXT)) === S.COMPLIANT, '5. 住所不明 + Text → Compliant');
  assert(Cc.getCcStatus(rec('NO_SECURE_LOCATION', '', '')) === S.NON_COMPLIANT, '6. 置き場所なし + なし → Non-Compliant');
  assert(Cc.getCcStatus(rec('DELIVERED_TO_FRONT_DOOR', CALL, TEXT)) === S.NOT_ELIGIBLE, '7. 対象外理由 + Contact → 対象外');
  assert(!Cc.isCcEligible(rec('DELIVERED_TO_FRONT_DOOR', CALL, '')), '7. 対象外理由は isCcEligible=false');

  var both = [rec('CUSTOMER_UNAVAILABLE', CALL, TEXT)];
  var s = Cc.calculateCcSummary(both);
  assert(s.total === 1 && s.compliant === 1 && s.nonCompliant === 0, '8. Call/Text両方 → Compliant 1件のみ: ' + JSON.stringify(s));

  // 4理由すべてが同じ扱い（不在だけを対象にしない）
  for (var i = 0; i < Cc.CC_ELIGIBLE_REASONS.length; i++) {
    var reason = Cc.CC_ELIGIBLE_REASONS[i];
    assert(Cc.isCcEligible(rec(reason)), reason + ' はCC対象');
    assert(Cc.getCcStatus(rec(reason, '', '')) === S.NON_COMPLIANT, reason + ' + Contactなし → Non-Compliant');
  }
  assert(Cc.CC_ELIGIBLE_REASONS.length === 4, '対象理由は4種類');

  // 通話時間・chat_reason_code は判定に使わない
  assert(Cc.getCcStatus(rec('CUSTOMER_UNAVAILABLE', CALL, '', { totalCallDuration: 0 })) === S.COMPLIANT, '通話0秒でもCallありはCompliant');
  assert(Cc.getCcStatus(rec('CUSTOMER_UNAVAILABLE', '  ', ' ')) === S.NON_COMPLIANT, '空白のみは Contact なし');
}

// ---- 必須テスト 9: 0件 ----
function testZeroEligible() {
  var s = Cc.calculateCcSummary([rec('DELIVERED_TO_FRONT_DOOR', CALL, '')]);
  assert(s.total === 0 && s.rate === null && s.notEligible === 1, '9. CC対象0件 → rate=null: ' + JSON.stringify(s));
  assert(Cc.formatCcRate(s.rate) === '-', '0件の表示は "-"');
  var e = Cc.calculateCcSummary([]);
  assert(e.total === 0 && e.rate === null, '空配列でもゼロ除算しない');
  var byReason = Cc.groupCcByReason([]);
  assert(byReason.length === 4 && byReason[0].rate === null, '理由別は0件でも4理由を返す');
  assert(Cc.groupCcByDriver([]).length === 0 && Cc.groupCcByDate([]).length === 0, 'DA別・日別は空');
}

// ---- 必須テスト 10: 未特定DA ----
function testUnknownDriver() {
  var master = { TID1: '山田 太郎' };
  var resolve = function (tid) { return master[tid] || ''; };
  var rows = [
    rec('CUSTOMER_UNAVAILABLE', CALL, '', { transporterId: 'TID1' }),
    rec('CUSTOMER_UNAVAILABLE', '', '', { transporterId: 'TID_UNKNOWN' }),
    rec('ADDRESS_NOT_FOUND', '', '', { transporterId: '' })
  ];
  var byDriver = Cc.groupCcByDriver(rows, resolve);
  var unknown = byDriver.filter(function (d) { return d.transporterId === 'TID_UNKNOWN'; })[0];
  assert(unknown.driverName === '未特定' && unknown.identified === false, '10. マスタに無いTID → 「未特定」');
  var known = byDriver.filter(function (d) { return d.transporterId === 'TID1'; })[0];
  assert(known.driverName === '山田 太郎' && known.identified === true, 'マスタにあるTID → 氏名');
  var blank = byDriver.filter(function (d) { return d.transporterId === ''; })[0];
  assert(blank.driverName === '未特定', 'TID空欄も「未特定」');
  assert(Cc.resolveCcDriverName('X', undefined) === '未特定', 'resolveName未指定でも落ちない');
  var nc = Cc.listCcNonCompliant(rows, resolve);
  assert(nc.length === 2 && nc.every(function (r) { return r.driverName === '未特定'; }), '明細でも未特定');
}

// ---- 集計（理由別・DA別・日別・率・並び） ----
function testAggregations() {
  var rows = [
    rec('CUSTOMER_UNAVAILABLE', CALL, '', { transporterId: 'A', eventDate: '2026-09-28' }),
    rec('CUSTOMER_UNAVAILABLE', '', '', { transporterId: 'A', eventDate: '2026-09-27' }),
    rec('INACCESSIBLE_DELIVERY_LOCATION', '', '', { transporterId: 'B', eventDate: '2026-09-27' }),
    rec('INACCESSIBLE_DELIVERY_LOCATION', '', '', { transporterId: 'B', eventDate: '2026-09-27' }),
    rec('NO_SECURE_LOCATION', '', TEXT, { transporterId: 'C', eventDate: '2026-09-28' }),
    rec('DELIVERED_TO_SAFE_LOCATION', CALL, '', { transporterId: 'C', eventDate: '2026-09-29' })
  ];
  var s = Cc.calculateCcSummary(rows);
  assert(s.total === 5 && s.compliant === 2 && s.nonCompliant === 3 && s.notEligible === 1, 'summary: ' + JSON.stringify(s));
  assert(Cc.formatCcRate(s.rate) === '40.00%', 'CC率は小数2桁: ' + Cc.formatCcRate(s.rate));

  var byReason = Cc.groupCcByReason(rows);
  assert(byReason.map(function (r) { return r.reason; }).join() === Cc.CC_ELIGIBLE_REASONS.join(), '理由別は定数順');
  assert(byReason[0].reasonLabel === '不在' && byReason[1].reasonLabel === '配達先アクセス不可'
    && byReason[2].reasonLabel === '住所不明' && byReason[3].reasonLabel === '安全な置き場所なし', '日本語ラベル');
  assert(byReason[1].total === 2 && byReason[1].nonCompliant === 2 && byReason[1].rate === 0, 'アクセス不可 0/2');
  assert(byReason[2].total === 0 && byReason[2].rate === null, '住所不明 0件');

  var byDriver = Cc.groupCcByDriver(rows);
  assert(byDriver[0].transporterId === 'B', '既定はNon-Compliant降順でBが先頭');
  assert(byDriver.length === 3, '対象外行しか無いDAは出さない（Cは対象行1件あり）');
  var asc = Cc.sortCcDriverStats(byDriver, 'rateAsc');
  assert(asc[0].transporterId === 'B' && asc[2].transporterId === 'C', 'CC率昇順: ' + asc.map(function (d) { return d.transporterId; }));
  assert(byDriver[0].transporterId === 'B', 'sortCcDriverStatsは元配列を変更しない');

  var byDate = Cc.groupCcByDate(rows);
  assert(byDate.length === 2 && byDate[0].eventDate === '2026-09-27' && byDate[0].nonCompliant === 3, '日別: ' + JSON.stringify(byDate));
  assert(byDate[1].compliant === 2 && byDate[1].rate === 100, '9/28 2/2');

  var nc = Cc.listCcNonCompliant(rows);
  assert(nc.length === 3 && nc[0].eventDate === '2026-09-27', 'Non-Compliant明細3件、日付昇順');
  assert(nc[0].shipmentReasonLabel && nc[0].statusLabel === '非適合', '明細に日本語理由と判定');
}

// ---- 取込: ヘッダー名で列特定 / 列順非依存 / 余分列 / 必須列不足 ----
function testParseRows() {
  var header = ['chat_reason_code', 'Text Event', 'Shipment Reason', 'Extra', 'Transporter ID', 'Call Event',
    'Destination Address ID', 'Scannable ID', 'Event Date'];
  var rows = [
    ['メモ行'],
    header,
    ['OTHER', TEXT, 'CUSTOMER_UNAVAILABLE', 'x', 'T1', '', 160360722923, 'S1', '2026-09-27 00:00:00'],
    ['', '', 'ADDRESS_NOT_FOUND', 'y', 'T2', '', 'D2', 'S2', new Date(2026, 8, 28)],
    ['', '', '', '', '', '', '', '', ''],
    ['', '', 'NO_SECURE_LOCATION', '', 'T3', CALL, 'D3', 'S3', 46295]
  ];
  var parsed = Cc.ccParseRows(rows);
  assert(!parsed.error, 'parse ok: ' + JSON.stringify(parsed));
  assert(parsed.headerIndex === 1, 'ヘッダー行を検出');
  assert(parsed.records.length === 3, '空行はスキップ: ' + parsed.records.length);
  var r0 = parsed.records[0];
  assert(r0.transporterId === 'T1' && r0.textEvent === TEXT && r0.eventDate === '2026-09-27' && r0.destinationAddressId === '160360722923', '列順非依存: ' + JSON.stringify(r0));
  assert(parsed.records[1].eventDate === '2026-09-28', 'Date型の日付');
  assert(parsed.records[2].eventDate === '2026-09-30', 'Excelシリアル日付: ' + parsed.records[2].eventDate);
  var st = parsed.records.map(Cc.getCcStatus);
  assert(st.join() === [S.COMPLIANT, S.NON_COMPLIANT, S.COMPLIANT].join(), '取込後の判定: ' + st);

  var missing = Cc.ccParseRows([['Event Date', 'Transporter ID', 'Shipment Reason', 'Call Event'], ['2026-09-27', 'T', 'CUSTOMER_UNAVAILABLE', '']]);
  assert(missing.error === 'missing_columns', '必須列不足はエラー');
  assert(missing.missing.join() === 'Scannable ID,Destination Address ID,Text Event', '不足列名を返す: ' + missing.missing);

  var none = Cc.ccParseRows([['a', 'b'], [1, 2]]);
  assert(none.error === 'missing_columns' && none.missing.length === 7, 'ヘッダーが全く無い場合は全列不足');
  assert(Cc.ccParseRows([]).error === 'empty', '空ファイル');

  var alt = Cc.ccMapColumns(['event_date', 'SCANNABLE ID', 'destination_address_id', 'TransportID', 'shipment_reason', 'call_event', 'text_event']);
  assert(alt.missing.length === 0, '表記揺れ（_/大文字/TransportID）を許容: ' + alt.missing);
}

// ---- 17. Wk40 OFK3 実データ検証（ハードコードなし。ロジック適用結果のみを確認） ----
function testWk40Ofk3RealData() {
  var csv = readFileSync(path.join(__dirname, 'fixtures/contact-compliance/wk40-ofk3-contact-compliance-sanitized.csv'), 'utf8');
  var wb = XLSX.read(csv, { type: 'string', raw: true });
  var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
  var result = Cc.analyzeCcRows(rows, function () { return ''; });
  assert(!result.error, 'Wk40 parse: ' + JSON.stringify(result.missing));
  assert(result.records.length === 845, '全845行を取込: ' + result.records.length);
  var s = result.summary;
  console.log('  Wk40 OFK3: total=' + s.total + ' compliant=' + s.compliant + ' nonCompliant=' + s.nonCompliant
    + ' notEligible=' + s.notEligible + ' rate=' + Cc.formatCcRate(s.rate));
  assert(s.total === 575, 'Total 575, got ' + s.total);
  assert(s.compliant === 453, 'Compliant 453, got ' + s.compliant);
  assert(s.nonCompliant === 122, 'Non-Compliant 122, got ' + s.nonCompliant);
  assert(Cc.formatCcRate(s.rate) === '78.78%', 'CC率 78.78%, got ' + Cc.formatCcRate(s.rate));
  assert(s.notEligible === 270, '対象外 270行');

  var byReason = {};
  result.byReason.forEach(function (r) { byReason[r.reason] = r; });
  assert(byReason.CUSTOMER_UNAVAILABLE.total === 336 && byReason.CUSTOMER_UNAVAILABLE.nonCompliant === 58, '不在 336/NC58');
  assert(byReason.INACCESSIBLE_DELIVERY_LOCATION.total === 173 && byReason.INACCESSIBLE_DELIVERY_LOCATION.nonCompliant === 51, 'アクセス不可 173/NC51');
  assert(byReason.ADDRESS_NOT_FOUND.total === 27 && byReason.ADDRESS_NOT_FOUND.nonCompliant === 10, '住所不明 27/NC10');
  assert(byReason.NO_SECURE_LOCATION.total === 39 && byReason.NO_SECURE_LOCATION.nonCompliant === 3, '置き場所なし 39/NC3');

  var sumDriver = result.byDriver.reduce(function (a, d) { return a + d.total; }, 0);
  var sumDate = result.byDate.reduce(function (a, d) { return a + d.nonCompliant; }, 0);
  assert(sumDriver === 575 && result.byDriver.length === 60, 'DA別合計575 / 60名');
  assert(result.byDriver[0].nonCompliant === 16, 'ワーストDAのNon-Compliantは16');
  assert(sumDate === 122 && result.byDate.length === 7, '日別NC合計122 / 7日');
  assert(result.nonCompliant.length === 122, 'Non-Compliant明細122件');
  assert(result.byDriver.every(function (d) { return d.driverName === '未特定'; }), 'マスタ無しなら全員未特定');
}

// ---- CC率の評価色分け: 正式基準が未確認のため既定では評価しない ----
function testRateLevelDisabledByDefault() {
  assert(Cc.CC_RATE_LEVEL_THRESHOLDS === null, '閾値は未設定（null）');
  [0, 50, 78.78, 85, 95, 100, null].forEach(function (r) {
    assert(Cc.getCcRateLevel(r) === null, '既定では評価なし: ' + r);
  });
  var t = [{ min: 90, level: 'good' }, { min: 0, level: 'bad' }];
  assert(Cc.getCcRateLevel(95, t) === 'good' && Cc.getCcRateLevel(10, t) === 'bad', '閾値を渡せば評価できる（将来用）');
  assert(Cc.getCcRateLevel(null, t) === null, '0件は評価しない');
}

function loadWk40Rows() {
  var csv = readFileSync(path.join(__dirname, 'fixtures/contact-compliance/wk40-ofk3-contact-compliance-sanitized.csv'), 'utf8');
  var wb = XLSX.read(csv, { type: 'string', raw: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
}

function sheetAoa(wb, name) {
  assert(wb.SheetNames.indexOf(name) >= 0, 'シート ' + name + ' がある: ' + wb.SheetNames);
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true });
}

function cellText(wb, name, r, c) {
  var cell = wb.Sheets[name][XLSX.utils.encode_cell({ r: r, c: c })];
  return cell ? (cell.w !== undefined ? cell.w : String(cell.v)) : '';
}

// ---- Excel出力（5シート）: 画面と同じ analyzeCcRows 結果から作り、書き出し→読み戻しで一致を確認 ----
function testExcelExportWk40() {
  var result = Cc.analyzeCcRows(loadWk40Rows(), function (tid) { return tid === 'A8JSA661WQ3ZH' ? 'テスト 太郎' : ''; });
  var buf = XLSX.write(Cc.buildCcExportWorkbook(XLSX, result, 'nonCompliantDesc'), { type: 'buffer', bookType: 'xlsx' });
  var wb = XLSX.read(buf, { type: 'buffer' });
  assert(wb.SheetNames.join() === 'CCサマリー,理由別,DA別,日別,Non-Compliant明細', 'シート構成: ' + wb.SheetNames);

  var sum = {};
  sheetAoa(wb, 'CCサマリー').forEach(function (row, i) { sum[row[0]] = { v: row[1], i: i }; });
  assert(sum['Logic Version'].v === 'CC Logic Ver.1', 'Logic Version');
  assert(sum['CC対象件数'].v === 575 && sum['Compliant件数'].v === 453 && sum['Non-Compliant件数'].v === 122, 'Excel件数 575/453/122');
  assert(sum['CC率'].v === 78.78, 'Excel CC率の値 78.78: ' + sum['CC率'].v);
  var excelRateText = cellText(wb, 'CCサマリー', sum['CC率'].i, 1);
  assert(excelRateText === '78.78%', 'Excel CC率の表示 78.78%: ' + excelRateText);
  // 画面表示（formatCcRate）と完全一致
  assert(excelRateText === Cc.formatCcRate(result.summary.rate), '画面とExcelのCC率表示が一致');
  console.log('  Excel CCサマリー: ' + sum['CC対象件数'].v + ' / ' + sum['Compliant件数'].v + ' / '
    + sum['Non-Compliant件数'].v + ' / ' + excelRateText + '  (screen: ' + Cc.formatCcRate(result.summary.rate) + ')');

  var reason = sheetAoa(wb, '理由別');
  assert(reason[0].join() === '配送理由,Shipment Reason,対象件数,Compliant,Non-Compliant,CC率', '理由別ヘッダー');
  assert(reason.length === 5, '4理由');
  var expectReason = [['不在', 'CUSTOMER_UNAVAILABLE', 336, 278, 58], ['配達先アクセス不可', 'INACCESSIBLE_DELIVERY_LOCATION', 173, 122, 51],
    ['住所不明', 'ADDRESS_NOT_FOUND', 27, 17, 10], ['安全な置き場所なし', 'NO_SECURE_LOCATION', 39, 36, 3]];
  for (var i = 0; i < 4; i++) {
    assert(reason[i + 1].slice(0, 5).join() === expectReason[i].join(), '理由別 ' + reason[i + 1]);
    assert(cellText(wb, '理由別', i + 1, 5) === Cc.formatCcRate(result.byReason[i].rate), '理由別CC率表示一致');
  }

  var da = sheetAoa(wb, 'DA別');
  assert(da[0].join() === 'DA名,Transporter ID,対象件数,Compliant,Non-Compliant,CC率', 'DA別ヘッダー');
  assert(da.length === 61, 'DA 60名');
  var daTotal = 0, daNc = 0;
  for (var d = 1; d < da.length; d++) {
    daTotal += da[d][2]; daNc += da[d][4];
    var screen = result.byDriver.filter(function (x) { return x.transporterId === da[d][1]; })[0];
    assert(screen && screen.driverName === da[d][0] && screen.total === da[d][2] && screen.nonCompliant === da[d][4], 'DA行一致 ' + da[d]);
    assert(cellText(wb, 'DA別', d, 5) === Cc.formatCcRate(screen.rate), 'DA CC率表示一致 ' + da[d][1]);
  }
  assert(daTotal === 575 && daNc === 122, 'DA別合計 575/122');
  assert(da[1][0] === 'テスト 太郎' && da[1][1] === 'A8JSA661WQ3ZH', 'DA名照合（マスタあり）');
  assert(da.filter(function (r) { return r[0] === '未特定'; }).length === 59, 'マスタ無しは未特定');
  var asc = sheetAoa(XLSX.read(XLSX.write(Cc.buildCcExportWorkbook(XLSX, result, 'rateAsc'), { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' }), 'DA別');
  assert(asc[1][5] === 0 && asc[60][5] === 100, 'DA別は画面の並び順指定に従う（CC率昇順）');

  var date = sheetAoa(wb, '日別');
  assert(date[0].join() === 'Event Date,対象件数,Compliant,Non-Compliant,CC率', '日別ヘッダー');
  assert(date.length === 8 && date[1][0] === '2026-09-27' && date[1][1] === 60 && date[1][3] === 24, '日別 ' + date[1]);
  assert(cellText(wb, '日別', 1, 4) === '60.00%', '日別CC率表示');

  var nc = sheetAoa(wb, 'Non-Compliant明細');
  assert(nc[0].join() === 'Event Date,DA名,Transporter ID,Scannable ID,Destination Address ID,Shipment Reason,配送理由（日本語）,Call Event,Text Event,判定', 'NC明細ヘッダー');
  assert(nc.length === 123, 'NC明細122件');
  assert(nc.slice(1).every(function (r) { return r[9] === 'Non-Compliant' && r[7] === '' && r[8] === ''; }), '判定=Non-Compliant、Call/Textなし');
  assert(nc.slice(1).every(function (r) { return Cc.CC_ELIGIBLE_REASONS.indexOf(r[5]) >= 0 && r[6] === Cc.getCcReasonLabel(r[5]); }), '理由コードと日本語');
}

function testExcelExportZero() {
  var result = Cc.analyzeCcRows([['Event Date', 'Scannable ID', 'Destination Address ID', 'Transporter ID', 'Shipment Reason', 'Call Event', 'Text Event'],
    ['2026-09-27', 'S', 'D', 'T', 'DELIVERED_TO_FRONT_DOOR', CALL, '']]);
  var sheets = Cc.buildCcExportSheets(result);
  assert(sheets[0].rows[2][1] === '-', '0件のCC率は "-"');
  var wb = Cc.buildCcExportWorkbook(XLSX, result);
  assert(wb.SheetNames.length === 5, '0件でも5シート');
}

var tests = [testStatusJudgment, testZeroEligible, testUnknownDriver, testAggregations, testParseRows, testWk40Ofk3RealData,
  testRateLevelDisabledByDefault, testExcelExportWk40, testExcelExportZero];
for (var i = 0; i < tests.length; i++) {
  tests[i]();
  console.log('PASS ' + tests[i].name);
}
console.log('contact-compliance-core tests passed (' + tests.length + ')');
