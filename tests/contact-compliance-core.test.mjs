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

var tests = [testStatusJudgment, testZeroEligible, testUnknownDriver, testAggregations, testParseRows, testWk40Ofk3RealData];
for (var i = 0; i < tests.length; i++) {
  tests[i]();
  console.log('PASS ' + tests[i].name);
}
console.log('contact-compliance-core tests passed (' + tests.length + ')');
