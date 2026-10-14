// DNR 詳細分類3種の日本語表示テスト:
//   No Item front door → 玄関前に荷物なし / No Item mail slot → 郵便受けに荷物なし / No item Others → その他の場所に荷物なし
// 表示・出力時のみ変換。元データの英語表記・DNR件数・分類・所属判定・集計・他の理由は変更しない。
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../dnr-core.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const server = readFileSync(join(root, 'render-webhook-server.js'), 'utf8');

function assert(c, m) { if (!c) throw new Error('FAIL: ' + m); }

const FRONT = '玄関前に荷物なし', MAIL = '郵便受けに荷物なし', OTHERS = 'その他の場所に荷物なし';

function testCore() {
  const f = D.dnrFormatDetailReason;
  // 実データの表記（W41: 区切りは _、'others' の i は小文字）と整形後の表記
  assert(f('No Item_front door') === FRONT && f('No Item front door') === FRONT, 'front door');
  assert(f('No Item_mail slot') === MAIL && f('No Item mail slot') === MAIL, 'mail slot');
  assert(f('No item_Others') === OTHERS && f('No item Others') === OTHERS && f('No Item_Others') === OTHERS, 'Others（item の大文字小文字違い）');
  // 大文字・小文字・空白の表記揺れ
  ['NO ITEM FRONT DOOR', 'no item_front door', 'No Item_Front Door', '  No Item_front door  ', 'No  Item__front   door', 'No Item_front door', 'No　Item_front door'].forEach(v => assert(f(v) === FRONT, '表記揺れ: ' + JSON.stringify(v)));
  ['NO ITEM MAIL SLOT', 'no item_MAIL slot'].forEach(v => assert(f(v) === MAIL, '表記揺れ: ' + v));
  ['NO ITEM OTHERS', 'no item_others'].forEach(v => assert(f(v) === OTHERS, '表記揺れ: ' + v));
  // 3種類以外は変更しない（入力をそのまま返す）
  ['No Item_delivery box', 'No Item_reception/front_desk/mail room', 'No Item_neighbor', 'No Item_safe place', 'No Item_front doors', 'No Item_front', 'No Item',
    'Missing/Wrong Delivery Box Number or PIN code', 'DELIVERED_TO_FRONT_DOOR', 'Driver - Controllable', '玄関前置き', '', 'x'].forEach(v => assert(f(v) === v, '他は不変: ' + v));
  assert(f(null) === null && f(undefined) === undefined, 'null/undefined はそのまま');
  assert(Object.keys(D.DNR_DETAIL_REASON_JA).length === 3, '追加は3種類のみ');
}

function testTranslateReason() {
  const dict = { 'No Item_delivery box': '宅配BOXに荷物なし', 'No Item_neighbor': '隣人渡し先に荷物なし', DELIVERED_TO_FRONT_DOOR: '玄関前置き' };
  const t = v => D.dnrTranslateReason(v, dict);
  assert(t('No Item_front door') === FRONT && t('No item_Others') === OTHERS && t('no item mail slot') === MAIL, '3種類を変換');
  // 既存の辞書変換・未知値は従来どおり
  assert(t('No Item_delivery box') === '宅配BOXに荷物なし' && t('No Item_neighbor') === '隣人渡し先に荷物なし' && t('DELIVERED_TO_FRONT_DOOR') === '玄関前置き', '既存辞書は不変');
  assert(t('UNKNOWN_X') === 'UNKNOWN_X' && t('') === '', '未知値・空は従来どおり');
  // 辞書側に同名キーがあれば辞書が優先（既存の挙動を壊さない）
  assert(D.dnrTranslateReason('No Item_front door', { 'No Item_front door': 'X' }) === 'X', '辞書の完全一致が優先');
}

const HEADER = ['delivery_station_code', 'bucket', 'sub_bucket', 'provider_company_name', 'transporter_id', 'tracking_id', 'shipment_reason', 'delivery_date_jst', 'state', 'conceded_units', 'dnr_cost_jpy'];
function row(sub, tid, tr, reason) { return ['OFK3', 'Driver - Controllable', sub, 'GDS', tid, tr, reason, '2026-10-04 00:00:00', '福岡県', 1, 1000]; }

function testExport() {
  const subs = ['No Item_front door', 'No Item_mail slot', 'No item_Others', 'No Item_delivery box', 'Missing/Wrong Delivery Box Number or PIN code'];
  const json = [HEADER].concat(subs.map((s, i) => row(s, 'T' + i, 'DA' + i, 'DELIVERED_TO_FRONT_DOOR')));
  const recs = D.dnrExtractRows(json, 0, D.dnrMapHeaderColumns(HEADER));
  const dict = { 'No Item_delivery box': '宅配BOXに荷物なし', 'Missing/Wrong Delivery Box Number or PIN code': '宅配BOX番号/暗証番号間違い', DELIVERED_TO_FRONT_DOOR: '玄関前置き', 'Driver - Controllable': 'ドライバー起因（管理可能）' };
  const out = D.dnrBuildExportRows(recs, dict);
  const si = out[0].indexOf('詳細分類');
  assert(out.slice(1).map(r => r[si]).join('|') === [FRONT, MAIL, OTHERS, '宅配BOXに荷物なし', '宅配BOX番号/暗証番号間違い'].join('|'), '詳細分類の出力: ' + out.slice(1).map(r => r[si]));
  // 内部データ（元の英語表記）は保持
  assert(recs.map(r => r.sub_bucket).join('|') === subs.join('|'), '内部データの英語表記を保持');
  // 件数・列構成・他列は不変（変換対象の詳細分類セルだけが違う）
  const baseline = D.dnrBuildExportRows(recs.map(r => Object.assign({}, r, { sub_bucket: 'ZZ' })), dict);
  assert(out.length === baseline.length && out[0].join() === baseline[0].join(), '行数・列構成は不変');
  out.forEach((r, i) => { if (i > 0) r.forEach((v, c) => { if (c !== si) assert(v === baseline[i][c], '詳細分類以外の列は不変 r' + i + 'c' + c); }); });
  // 実際に出力に英語3種が残らない
  const flat = JSON.stringify(out);
  assert(!/No [Ii]tem[ _](front door|mail slot|Others)/.test(flat), '出力に英語の3種が残らない');
}

function extractFn(name) {
  const st = html.indexOf('    function ' + name + '(');
  if (st < 0) throw new Error('function not found: ' + name);
  let i = html.indexOf('{', st), depth = 0;
  for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}' && --depth === 0) break; }
  return html.slice(st, i + 1);
}
function extractVar(name) {
  const st = html.indexOf('    var ' + name + ' = ');
  const end = html.indexOf('};', st);
  return html.slice(st, end + 2);
}

function testUi() {
  const sb = { DnrCore: D, console };
  vm.createContext(sb);
  vm.runInContext([extractVar('DNR_KEEP_COLS'), extractVar('DNR_COL_LABELS'), extractVar('REASON_JA'),
    extractFn('translateReason'), extractFn('dnrDisplayReasonText'), extractFn('dnrDisplayDateTime'), extractFn('buildDnrAoa')].join('\n'), sb);
  // 画面共通の理由変換（ダッシュボードの理由ランキング・明細表）
  assert(sb.translateReason('No Item_front door') === FRONT && sb.translateReason('No item_Others') === OTHERS && sb.translateReason('NO ITEM MAIL SLOT') === MAIL, 'translateReason');
  // 既存の変換は不変
  assert(sb.translateReason('DELIVERED_TO_FRONT_DOOR') === '玄関前置き' && sb.translateReason('No Item_delivery box') === '宅配BOXに荷物なし' && sb.translateReason('CUSTOMER_UNAVAILABLE') === '不在', '既存変換は不変');
  assert(sb.translateReason('No Item_neighbor') === '隣人渡し先に荷物なし' && sb.translateReason('UNKNOWN_REASON') === 'UNKNOWN REASON', '3種類以外は従来どおり');
  // ポップアップ・LINE用: 3種類だけ変換し、他は元の値のまま（DELIVERED_TO_FRONT_DOOR を勝手に日本語化しない）
  assert(sb.dnrDisplayReasonText('No Item_mail slot') === MAIL && sb.dnrDisplayReasonText('DELIVERED_TO_FRONT_DOOR') === 'DELIVERED_TO_FRONT_DOOR', '生表示箇所は3種類のみ変換');
  // アプリのExcel（buildDnrAoa）
  const recs = [
    { driverName: 'A', delivery_date_jst: '2026-10-04 00:00:00', shipment_reason: 'DELIVERED_TO_FRONT_DOOR', sub_bucket: 'No Item_front door', bucket: 'Driver - Controllable', transporter_id: 'T1' },
    { driverName: 'B', delivery_date_jst: '2026-10-05 00:00:00', shipment_reason: 'DELIVERED_TO_MAIL_SLOT', sub_bucket: 'No Item_mail slot', bucket: 'Driver - Controllable', transporter_id: 'T2' },
    { driverName: 'C', delivery_date_jst: '2026-10-06 00:00:00', shipment_reason: 'DELIVERED_TO_HOUSEHOLD_MEMBER', sub_bucket: 'No item_Others', bucket: 'Driver - Controllable', transporter_id: 'T3' }
  ];
  const aoa = sb.buildDnrAoa(recs);
  const si = aoa[0].indexOf('詳細分類');
  assert(aoa.slice(1).map(r => r[si]).join('|') === [FRONT, MAIL, OTHERS].join('|'), 'アプリExcelの詳細分類: ' + aoa.slice(1).map(r => r[si]));
  assert(aoa.slice(1).map(r => r[aoa[0].indexOf('DNR理由')]).join('|') === '玄関前置き|郵便受け投函|同居人渡し', 'DNR理由（shipment_reason）は従来どおり');
  assert(recs[0].sub_bucket === 'No Item_front door', '内部データは変更されない');
  // 表示箇所（地図ポップアップ2種・LINE通知）が変換ヘルパーを経由
  const popups = extractFn('renderDnrMap') + extractFn('dnrShowSingleMap') + extractFn('dnrSendSingleLine');
  assert((popups.match(/dnrDisplayReasonText\(/g) || []).length === 3, '地図ポップアップ・LINEが変換ヘルパーを使用');
  assert(!/\+ [a-z]\.shipment_reason \+/.test(popups), '生の shipment_reason を直接表示しない');
  // 件数・分類・所属判定・集計は変更されていない: 該当関数の本体に今回の変換が入り込んでいない
  ['renderDnrResults'].forEach(n => { const b = extractFn(n); assert(b.indexOf('dnrFormatDetailReason') < 0 && b.indexOf('DNR_DETAIL_REASON_JA') < 0, n + ' の集計ロジックは変更なし'); });
  assert(/var reason = r\.shipment_reason \|\| '不明';/.test(extractFn('renderDnrResults')), '理由ランキングの集計キーは元の値のまま');
}

function testServer() {
  // /dnr-export は dnr-core の dnrBuildExportRows を使用（辞書は FTDS_REASON_JA）。サーバー側辞書は変更しない
  assert(/DnrCore\.dnrBuildExportRows\(recs, FTDS_REASON_JA\)/.test(server), '/dnr-export は dnrBuildExportRows 経由');
  const dictStart = server.indexOf('var FTDS_REASON_JA = {');
  const dict = server.slice(dictStart, server.indexOf('};', dictStart));
  assert(dict.indexOf('No Item_front door') < 0 && dict.indexOf('No Item_mail slot') < 0, 'サーバー辞書には3種を追加していない（dnr-core側で処理）');
}

// ---- 明細一覧の「詳細分類」列 ----
function testDetailColumn() {
  // 静的: ヘッダーは DNR理由 の次、住所の前。既存列は残る
  const head = html.slice(html.indexOf('id="dnr-detail-section"'), html.indexOf('id="dnr-detail-tbody"'));
  const labels = [...head.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1]);
  assert(labels.join() === 'ドライバー,配達日,DS,DSP,TrackingID,DNR理由,詳細分類,住所,個数,金額,操作', '明細の列構成: ' + labels);

  const els = {};
  const el = id => (els[id] = els[id] || { id, innerHTML: '', textContent: '', disabled: true, style: {}, classList: { add() {}, remove() {} } });
  const sb = {
    DnrCore: D, console, document: { getElementById: el },
    escapeHtml: v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    renderDnrMap() {}, driverMap: {}, dnrMap: null,
    dnrResultData: []
  };
  vm.createContext(sb);
  vm.runInContext([extractVar('REASON_JA'), extractFn('translateReason'), extractFn('dnrDisplayDateTime'), extractFn('dnrDisplayReasonText'),
    extractFn('dnrDisplaySubBucket'), extractFn('renderDnrResults')].join('\n'), sb);
  const mk = (sub, reason, tid, cost) => ({ driverName: tid, delivery_date_jst: '2026-10-04 00:00:00', delivery_station_code: 'OFK3', provider_company_name: 'GDS', tracking_id: 'DA' + tid,
    shipment_reason: reason, sub_bucket: sub, address: '福岡', state: '福岡県', _units: 1, _cost: cost, _lat: 0, _lng: 0, transporter_id: tid });
  const data = [
    mk('No Item_front door', 'DELIVERED_TO_FRONT_DOOR', 'T1', 1000),
    mk('No Item_mail slot', 'DELIVERED_TO_MAIL_SLOT', 'T2', 2000),
    mk('No item_Others', 'DELIVERED_TO_HOUSEHOLD_MEMBER', 'T3', 3000),
    mk('No Item_delivery box', 'DELIVERED_TO_DELIVERY_BOX', 'T4', 4000),
    mk('Missing/Wrong Delivery Box Number or PIN code', 'DELIVERED_TO_DELIVERY_BOX', 'T5', 5000),
    mk('', 'DELIVERED_TO_DELIVERY_BOX', 'T6', 6000),
    mk(undefined, 'DELIVERED_TO_DELIVERY_BOX', 'T7', 7000),
    mk('宅配BOXに荷物なし', 'DELIVERED_TO_DELIVERY_BOX', 'T8', 8000),
    mk('Some_Unknown_Value', 'DELIVERED_TO_DELIVERY_BOX', 'T9', 9000)
  ];
  sb.dnrResultData = data;
  const before = JSON.stringify(data);
  vm.runInContext('renderDnrResults()', sb);
  const rows = els['dnr-detail-tbody'].innerHTML.split('</tr>').filter(x => x.indexOf('<td') >= 0);
  assert(rows.length === data.length, '明細行数は件数どおり: ' + rows.length);
  const cells = r => [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
  const sub = rows.map(r => cells(r)[6]);
  const reason = rows.map(r => cells(r)[5]);
  assert(sub.join('|') === [FRONT, MAIL, OTHERS, '宅配BOXに荷物なし', '宅配BOX番号/暗証番号間違い', '-', '-', '宅配BOXに荷物なし', 'Some Unknown Value'].join('|'), '詳細分類列: ' + sub);
  assert(reason.join('|') === ['玄関前置き', '郵便受け投函', '同居人渡し', '宅配ボックス投函', '宅配ボックス投函', '宅配ボックス投函', '宅配ボックス投函', '宅配ボックス投函', '宅配ボックス投函'].join('|'), '既存の配送理由列は残り変換も従来どおり: ' + reason);
  assert(rows.every(r => cells(r).length === 11), '各行11列（ヘッダーと一致）');
  // 件数・集計・所属判定は変更なし
  assert(els['dnr-total'].textContent === 9, '件数: ' + els['dnr-total'].textContent);
  assert(els['dnr-cost-total'].textContent === '¥' + (45000).toLocaleString(), '金額合計は不変: ' + els['dnr-cost-total'].textContent);
  assert(els['dnr-matched'].textContent === 9 && els['dnr-unmatched-count'].textContent === 0, '照合件数は不変');
  assert(JSON.stringify(data) === before, '内部データは変更されない（元の英語表記を保持）');
  // 理由ランキングの集計キーは shipment_reason のまま（詳細分類は集計に影響しない）
  assert(/DELIVERED_TO_DELIVERY_BOX|宅配ボックス投函/.test(els['dnr-reason-ranking'].innerHTML) && els['dnr-reason-ranking'].innerHTML.indexOf('玄関前に荷物なし') < 0, '理由ランキングは配送理由で集計');
  // Excelの列構成は従来どおり（詳細分類列は元から存在・列追加なし）
  const aoa = vm.runInContext('(function(){' + extractVar('DNR_KEEP_COLS') + extractVar('DNR_COL_LABELS') + extractFn('buildDnrAoa') + ' return buildDnrAoa([]); })()', Object.assign(sb, {}));
  assert(aoa[0].join() === 'ドライバー,配達日,DS,DSP名,TransportID,TrackingID,DNR理由,分類,詳細分類,都道府県,郵便番号,住所,緯度,経度,個数,金額(円)', 'Excelの列構成は変更なし');
}

const tests = [testCore, testTranslateReason, testExport, testUi, testServer, testDetailColumn];
for (const t of tests) { t(); console.log('PASS ' + t.name); }
console.log('dnr-detail-reason tests passed (' + tests.length + ')');
