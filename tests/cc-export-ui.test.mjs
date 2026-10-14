// Contact Compliance 画面の Excel 出力導線テスト（CC Logic Ver.1 と従来「べき架電／実架電」の分離）。
// index.html から実際の関数を抜き出して vm で実行する（DOM は最小限のモック）。
// CC 判定ロジック自体は contact-compliance-core.test.mjs が担当。
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const coreSource = readFileSync(join(root, 'contact-compliance-core.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

// 文字列リテラル・コメントを読み飛ばしながら { } を数えて関数全体を取り出す
function extractFunction(src, name) {
  var start = src.indexOf('    function ' + name + '(');
  assert(start >= 0, 'index.html に function ' + name + ' がある');
  var i = src.indexOf('{', start);
  var depth = 0;
  for (; i < src.length; i++) {
    var ch = src[i];
    if (ch === '"' || ch === "'") {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
    } else if (ch === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
    } else if (ch === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i) + 1;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unterminated function ' + name);
}

function extractVarObject(src, name) {
  var start = src.indexOf('var ' + name + ' = {');
  assert(start >= 0, 'index.html に var ' + name + ' がある');
  var end = src.indexOf('};', start);
  return src.slice(start, end + 2);
}

const FUNCTIONS = [
  'normalizeReportHeader', 'isTransporterHeader', 'mapAnalysisHeaderColumns', 'findAnalysisHeaderRow',
  'buildTidToNameLookup', 'updateCcExportUi', 'clearCcV1', 'showCcV1Error', 'ccV1RateHtml',
  'renderCcV1FromRows', 'renderCcV1', 'renderCcV1DriverTable', 'ccV1RateBarHtml', 'ccV1NcBarHtml', 'ccV1ReasonTableHtml',
  'ccV1StatTableHtml', 'ccV1SelectAff', 'ccV1SelectDa', 'ccV1NavTo', 'renderCcV1Affiliation', 'exportCcV1Result', 'processCcData',
  'translateReason', 'isCcCallRequired', 'isCcCallMade', 'calcCcCallRate', 'buildCcAoa',
  'styleQualityExportSheet', 'styleCcSheet', 'buildQualityAffiliationWorkbook',
  'groupQualityRecordsByAffiliation', 'toSafeExcelSheetName', 'exportCcResult'
];

function newElement(id) {
  var cls = { hidden: true };
  return {
    id: id, textContent: '', innerHTML: '', value: '', disabled: true,
    classList: {
      add: function (c) { cls[c] = true; },
      remove: function (c) { delete cls[c]; },
      contains: function (c) { return !!cls[c]; },
      toggle: function (c, on) { if (on) cls[c] = true; else delete cls[c]; }
    }
  };
}

function buildSandbox(master) {
  var elements = {};
  var alerts = [];
  var writes = [];
  var XLSXProxy = {
    utils: XLSX.utils,
    read: XLSX.read,
    write: XLSX.write,
    writeFile: function (wb, name) { writes.push({ wb: wb, name: name }); }
  };
  var sandbox = {
    console: console,
    XLSX: XLSXProxy,
    alert: function (m) { alerts.push(String(m)); },
    document: {
      getElementById: function (id) {
        if (!elements[id]) elements[id] = newElement(id);
        return elements[id];
      }
    },
    transportIDs: master || {},
    ccResultData: [],
    exportedQualityCounts: {},
    ccV1Result: null,
    ccV1MissingColumns: null,
    ccV1Nav: { aff: null, tid: null },
    ccV1AffView: [],
    ccV1DaView: [],
    getTodayJst: function () { return '2026-10-07'; },
    escapeHtml: function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
    latFormatDate: function (s) { return String(s || '').replace(/-/g, '/'); },
    resolveQualityAffiliationByKeys: function (name, tid) { return (sandbox.__affMaster || {})[tid] || ''; },
    renderCcResultsUI: function () { sandbox.__legacyRendered = true; } // 従来指標の描画（DOM）だけ省略
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(coreSource, sandbox);
  var depStart = html.indexOf('    var DEPARTMENTS = [');
  var code = html.slice(depStart, html.indexOf('];', depStart) + 2) + '\n'
    + extractVarObject(html, 'REASON_JA') + '\n'
    + extractVarObject(html, 'CC_V1_RATE_LEVEL_COLORS') + '\n';
  for (var i = 0; i < FUNCTIONS.length; i++) code += extractFunction(html, FUNCTIONS[i]) + '\n';
  vm.runInContext(code, sandbox);
  return { sandbox: sandbox, elements: elements, alerts: alerts, writes: writes };
}

function wk40Rows() {
  var csv = readFileSync(join(root, 'tests/fixtures/contact-compliance/wk40-ofk3-contact-compliance-sanitized.csv'), 'utf8');
  var wb = XLSX.read(csv, { type: 'string', raw: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
}

function dropColumns(rows, names) {
  var idx = [];
  rows[0].forEach(function (h, i) { if (names.indexOf(h) < 0) idx.push(i); });
  return rows.map(function (r) { return idx.map(function (i) { return r[i]; }); });
}

function roundTrip(wb) {
  return XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
}

function summaryOf(wb) {
  var rows = XLSX.utils.sheet_to_json(wb.Sheets['CCサマリー'], { header: 1, raw: true });
  var out = {};
  rows.forEach(function (r, i) {
    var cell = wb.Sheets['CCサマリー'][XLSX.utils.encode_cell({ r: i, c: 1 })];
    out[r[0]] = { v: r[1], w: cell ? cell.w : undefined };
  });
  return out;
}

// ---- 画面の導線（静的確認） ----
function testButtonsAreSeparated() {
  var header = html.slice(html.indexOf('id="panel-ftds"'), html.indexOf('<!-- Drop zones -->'));
  assert(/id="cc-v1-export-btn"[^>]*>📊 CC Ver\.1 Excel出力</.test(header), 'ヘッダーに「📊 CC Ver.1 Excel出力」');
  assert(/onclick="exportCcV1Result\(\)" id="cc-v1-export-btn" disabled/.test(header), 'CC Ver.1 ボタンは exportCcV1Result・初期は無効');
  assert(/onclick="exportCcResult\(\)" id="cc-export-btn" disabled[^>]*>📞 従来架電実績 Excel出力</.test(header), '旧ボタンは「📞 従来架電実績 Excel出力」');
  assert(header.indexOf('cc-v1-export-btn') < header.indexOf('cc-export-btn'), 'CC Ver.1 ボタンが主（先に配置）');
  assert(html.indexOf('>CC エクスポート<') < 0, '旧ラベル「CC エクスポート」は残っていない');
  assert((html.match(/id="cc-v1-export-btn"/g) || []).length === 1, 'CC Ver.1 ボタンは1つだけ');
  assert(html.indexOf("'ContactCompliance分析_' + getTodayJst() + '.xlsx'") < 0, '旧Excelを ContactCompliance分析_ の名前で出さない');
  var exportV1 = extractFunction(html, 'exportCcV1Result');
  assert(exportV1.indexOf('ccResultData') < 0 && exportV1.indexOf('buildCcAoa') < 0 && exportV1.indexOf('exportedQualityCounts') < 0,
    'CC Ver.1 出力は従来指標データを参照しない');
  assert(exportV1.indexOf('ContactComplianceCore.buildCcExportWorkbook') >= 0, 'CC Ver.1 出力は core の集計結果から作る');
}

// ---- Test 1/2/3/5: Wk40 raw → 画面とCC Ver.1 Excelが一致・5シート・NC 122行・ファイル名 ----
function testWk40ScreenAndV1Excel() {
  var t = buildSandbox({ 'テスト 太郎': 'A8JSA661WQ3ZH' });
  var status = t.sandbox.processCcData(wk40Rows());
  assert(status.legacyOk === true && status.v1.ok === true, 'Wk40 取込: 従来指標・CC Ver.1 とも成功');
  var screen = {
    rate: t.elements['cc-v1-rate'].innerHTML,
    total: String(t.elements['cc-v1-total'].textContent),
    compliant: String(t.elements['cc-v1-compliant'].textContent),
    nonCompliant: String(t.elements['cc-v1-noncompliant'].textContent)
  };
  assert(screen.rate === '78.78%' && screen.total === '575' && screen.compliant === '453' && screen.nonCompliant === '122',
    '画面 575/453/122/78.78%: ' + JSON.stringify(screen));
  assert(t.elements['cc-v1-export-btn'].disabled === false, 'raw data 取込後は CC Ver.1 ボタンが有効');
  assert(t.elements['cc-v1-export-status'].textContent.indexOf('出力可能') >= 0, '状態表示: 出力可能');

  t.sandbox.exportCcV1Result();
  assert(t.writes.length === 1, 'CC Ver.1 Excel を1ファイル出力');
  var v1Name = t.writes[0].name;
  assert(v1Name === 'CC_Ver1分析_2026-10-07.xlsx', 'CC Ver.1 ファイル名: ' + v1Name);
  var wb = roundTrip(t.writes[0].wb);
  assert(wb.SheetNames.join() === 'CCサマリー,所属別サマリー,所属別DA分析,理由別,DA別,日別,Non-Compliant明細', 'Test 2: 7シート ' + wb.SheetNames);
  var sum = summaryOf(wb);
  var excel = { rate: sum['CC率'].w, total: String(sum['CC対象件数'].v), compliant: String(sum['Compliant件数'].v), nonCompliant: String(sum['Non-Compliant件数'].v) };
  assert(JSON.stringify(excel) === JSON.stringify(screen), 'Test 1: 画面とExcelが一致 screen=' + JSON.stringify(screen) + ' excel=' + JSON.stringify(excel));
  assert(sum['Logic Version'].v === 'CC Logic Ver.1', 'Logic Version');
  var nc = XLSX.utils.sheet_to_json(wb.Sheets['Non-Compliant明細'], { header: 1, raw: true });
  assert(nc.length - 1 === 122, 'Test 3: Non-Compliant明細 122行, got ' + (nc.length - 1));
  console.log('  screen ' + JSON.stringify(screen) + ' / excel ' + JSON.stringify(excel) + ' / NC rows ' + (nc.length - 1));

  // Test 4/5: 同じ取込状態で旧Excelを出すと従来指標、ファイル名も別
  t.sandbox.exportCcResult();
  assert(t.writes.length === 2, '旧Excel も出力できる');
  var oldName = t.writes[1].name;
  assert(oldName === '従来架電実績分析_2026-10-07.xlsx', '旧Excel ファイル名: ' + oldName);
  assert(oldName !== v1Name, 'Test 5: 新旧のファイル名が異なる');
  var oldWb = roundTrip(t.writes[1].wb);
  assert(oldWb.SheetNames[0] === '全体データ', '旧Excel は従来どおり「全体データ」シートから');
  var oldHeader = XLSX.utils.sheet_to_json(oldWb.Sheets['全体データ'], { header: 1, raw: true })[0];
  assert(oldHeader.join() === 'ドライバー名,TransportID,べき架電,実架電,架電率(%),通話時間(秒),日付,配送理由内訳',
    'Test 4: 旧Excel は従来指標の列: ' + oldHeader);
  assert(oldWb.SheetNames.indexOf('CCサマリー') < 0, '旧Excel に CC Ver.1 シートは混ざらない');
}

// ---- Test 6: raw data 未読込なら CC Ver.1 Excel を出せない（従来指標データがあっても） ----
function testV1ExportBlockedWithoutRawData() {
  var t = buildSandbox();
  t.sandbox.ccResultData = [{ date: '2026-09-27', driverName: 'A', transporterId: 'T1', tracking: '', reason: 'CUSTOMER_UNAVAILABLE', method: '', contactType: 'Calls to Customer', duration: 10 }];
  t.sandbox.exportedQualityCounts = { A: { ccRequired: 3, ccActual: 2 } };
  t.sandbox.clearCcV1();
  assert(t.elements['cc-v1-export-btn'].disabled === true, '未読込ではボタン無効');
  assert(t.elements['cc-v1-export-status'].textContent.indexOf('Amazon Contact Compliance raw dataを読み込んでください') >= 0, '未読込の理由を表示');
  t.sandbox.exportCcV1Result();
  assert(t.writes.length === 0, 'Test 6: CC Ver.1 Excel を出力しない');
  assert(t.alerts.length === 1 && t.alerts[0].indexOf('raw dataを読み込んでください') >= 0, '理由をalert: ' + t.alerts[0]);
}

// ---- Test 7: 必須列不足時に従来指標へフォールバックしない ----
function testNoFallbackWhenColumnsMissing() {
  var t = buildSandbox();
  var status = t.sandbox.processCcData(dropColumns(wk40Rows(), ['Text Event', 'Destination Address ID']));
  assert(status.legacyOk === true && status.v1.ok === false, '従来指標は利用可能・CC Ver.1 は算出不可');
  assert(status.v1.missing.join() === 'Destination Address ID,Text Event', '不足列: ' + status.v1.missing);
  assert(t.sandbox.ccResultData.length > 0, '従来指標のデータは読み込まれている');
  assert(t.elements['cc-v1-export-btn'].disabled === true, 'CC Ver.1 ボタンは無効のまま');
  var st = t.elements['cc-v1-export-status'].textContent;
  assert(st.indexOf('必須列不足のため算出不可') >= 0 && st.indexOf('Text Event') >= 0, '状態表示: CC Ver.1 算出不可と不足列: ' + st);
  t.sandbox.exportCcV1Result();
  assert(t.writes.length === 0, 'Test 7: 従来指標の Excel を代わりに出さない');
  assert(t.alerts.length === 1 && t.alerts[0].indexOf('必須列不足') >= 0 && t.alerts[0].indexOf('Destination Address ID') >= 0, 'alert に不足列: ' + t.alerts[0]);

  // その後 raw data を読み込めば CC Ver.1 が使えるようになる
  t.sandbox.processCcData(wk40Rows());
  assert(t.elements['cc-v1-export-btn'].disabled === false && t.sandbox.ccV1MissingColumns === null, '正しいファイルで復帰');
}

// ---- 従来指標Excelの再取込（協力会社ダッシュボード一括読込）が新ファイル名でも CC 取込へ回る ----
function testBulkImportRoutesLegacyName() {
  var fn = extractFunction(html, 'handleTeamQualityBulkFiles');
  var end = fn.indexOf(') handleCcFile(file);');
  var begin = fn.lastIndexOf('else if (', end);
  assert(end > 0 && begin > 0, 'xlsx の CC ルーティング行がある');
  var test = new Function('fname', 'return ' + fn.slice(begin + 'else if ('.length, end) + ';');
  assert(test('従来架電実績分析_2026-10-07.xlsx'), '新しい旧指標ファイル名も CC 取込へ');
  assert(test('contactcompliance分析_2026-10-07.xlsx') && test('cc_ver1分析_2026-10-07.xlsx'), '既存の名前も従来どおり');
  assert(!test('ftds分析_2026-10-07.xlsx'), 'FTDS は対象外');
}

// ---- 所属別ドリルダウン（全体 → 所属 → DA → 理由 → 詳細）と Excel の一致 ----
function testAffiliationDrilldown() {
  var rows = wk40Rows();
  var tids = Array.from(new Set(rows.slice(1).map(function (r) { return r[5]; }))).filter(Boolean);
  var master = {}; var affMaster = {};
  tids.forEach(function (tid, i) {
    master['DA' + i] = tid;
    if (i % 3 !== 0) affMaster[tid] = i % 3 === 1 ? 'JHS' : 'AE物流'; // 3人に1人は所属マスタ無し
  });
  var t = buildSandbox(master);
  t.sandbox.__affMaster = affMaster;
  var res = t.sandbox.renderCcV1FromRows(wk40Rows());
  assert(res.ok, '算出成功');
  var r = t.sandbox.ccV1Result;
  assert(r.summary.total === 575 && r.summary.compliant === 453 && r.summary.nonCompliant === 122, 'Wk40の全体値は所属追加後も不変');
  var body = function () { return t.elements['cc-v1-aff-body'].innerHTML; };
  assert(/JHS/.test(body()) && /AE物流/.test(body()) && /所属未判定/.test(body()), 'ルート: 所属一覧に所属未判定を含む');
  assert(/一致/.test(t.elements['cc-v1-aff-check'].innerHTML), '整合性表示');
  assert(/<b>全体<\/b>/.test(t.elements['cc-v1-aff-crumb'].innerHTML), 'パンくず: 全体');

  t.sandbox.ccV1SelectAff(0);
  var first = t.sandbox.ccV1AffView[0];
  assert(first.nonCompliant === Math.max.apply(null, r.byAffiliation.map(function (a) { return a.nonCompliant; })), '先頭はNC最多の所属');
  assert(body().indexOf(first.drivers[0].transporterId) >= 0 && /DA別/.test(body()) && /所属内の配送理由別/.test(body()), '所属選択でDA一覧と理由別');
  assert(new RegExp('<b>' + first.affiliation + '</b>').test(t.elements['cc-v1-aff-crumb'].innerHTML), 'パンくず: 所属');

  t.sandbox.ccV1SelectDa(0);
  assert(/配送理由別/.test(body()) && /非適合明細/.test(body()), 'DA選択で理由別内訳と詳細');
  assert(body().indexOf('不在') >= 0 || body().indexOf('配達先アクセス不可') >= 0, '理由は日本語表示');
  var da = t.sandbox.ccV1DaView[0];
  assert(body().indexOf('非適合明細（' + da.nonCompliant + '件）') >= 0, 'DAの詳細件数=DA非適合件数');

  t.sandbox.ccV1NavTo('aff');
  assert(/DA別/.test(body()), '所属へ戻る');
  t.sandbox.ccV1NavTo('root');
  assert(/<b>全体<\/b>/.test(t.elements['cc-v1-aff-crumb'].innerHTML), '全体へ戻る');

  // 並び替え
  t.elements['cc-v1-aff-sort'].value = 'rateAsc';
  t.sandbox.renderCcV1Affiliation();
  var v = t.sandbox.ccV1AffView;
  for (var i = 1; i < v.length; i++) assert(v[i - 1].rate <= v[i].rate, 'CC率昇順');
}

var tests = [testButtonsAreSeparated, testWk40ScreenAndV1Excel, testV1ExportBlockedWithoutRawData, testNoFallbackWhenColumnsMissing, testBulkImportRoutesLegacyName, testAffiliationDrilldown];
for (var i = 0; i < tests.length; i++) {
  tests[i]();
  console.log('PASS ' + tests[i].name);
}
console.log('cc-export-ui tests passed (' + tests.length + ')');
