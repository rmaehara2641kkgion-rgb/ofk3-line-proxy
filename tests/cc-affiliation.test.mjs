// CC 所属別分析・配送理由内訳・Not Attempt 日本語表示のテスト。
// W41（CC対象678 / Compliant 506 / Non-Compliant 172 / CC率74.63%）の実データはリポジトリに無いため、
// 同じ件数・同じ構成（4理由 × 複数所属 × 所属未判定）を再現した決定的な合成データで回帰確認する。
// 実W41ファイルでの確認は、画面に表示される「合計は全体集計と一致」表示と上記4値の目視で行う。
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Cc = require('../contact-compliance-core.js');
const XLSX = require('xlsx');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

function assert(c, m) { if (!c) throw new Error('FAIL: ' + m); }

const HEADER = ['Event Date', 'Scannable ID', 'Destination Address ID', 'Transporter ID', 'Shipment Reason', 'Call Event', 'Text Event'];
const REASONS = Cc.CC_ELIGIBLE_REASONS;
const AFFS = { T01: 'GDSダイレクト', T02: 'GDSダイレクト', T03: 'JHS', T04: 'JHS', T05: 'AE物流', T06: 'AE物流' }; // T07,T08 はマスタに無い

// 対象678件（Compliant 506 / NC 172）を 8 DA × 4 理由に決定的に割り振る + 対象外（Not Attempt含む）
function w41LikeRows() {
  const rows = [HEADER];
  const tids = ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08'];
  let n = 0;
  for (let i = 0; i < 678; i++) {
    const tid = tids[(i * 7 + (i >> 3)) % 8];
    const reason = REASONS[(i * 3 + (i >> 2)) % 4];
    const nc = i % 678 < 172 * 1 && (i % 4 === 0 || i < 40) ? true : false; // 後で件数を補正
    rows.push(['2026-10-0' + (1 + (i % 7)), 'S' + (n++), 'D' + i, tid, reason, nc ? '' : 'Calls to Customer', '']);
  }
  // NC をちょうど172件に補正
  let ncCount = rows.slice(1).filter(r => r[5] === '').length;
  for (let i = 1; i < rows.length && ncCount !== 172; i++) {
    if (ncCount < 172 && rows[i][5] !== '') { rows[i][5] = ''; ncCount++; }
    else if (ncCount > 172 && rows[i][5] === '') { rows[i][5] = 'Calls to Customer'; ncCount--; }
  }
  // 対象外行（判定に影響しない）。Not Attempt は表記ゆれ込み
  ['Not Attempt', 'NOT_ATTEMPT', 'DELIVERED_TO_FRONT_DOOR'].forEach((rs, k) => {
    for (let j = 0; j < 5; j++) rows.push(['2026-10-01', 'X' + k + j, 'XD' + k + j, 'T0' + (1 + j), rs, '', '']);
  });
  return rows;
}

const resolveName = tid => ({ T01: '田中', T02: '佐藤', T03: '鈴木', T04: '高橋', T05: '伊藤', T06: '渡辺', T07: '山本' }[tid] || '');
const resolveAff = tid => AFFS[tid] || '';

function sum(list, k) { return list.reduce((a, x) => a + x[k], 0); }

function testW41Regression() {
  const rows = w41LikeRows();
  const base = Cc.analyzeCcRows(rows, resolveName);               // 所属なし（従来呼び出し）
  const withAff = Cc.analyzeCcRows(rows, resolveName, resolveAff); // 所属あり
  for (const r of [base, withAff]) {
    assert(r.summary.total === 678 && r.summary.compliant === 506 && r.summary.nonCompliant === 172, 'W41 678/506/172: ' + JSON.stringify(r.summary));
    assert(Cc.formatCcRate(r.summary.rate) === '74.63%', 'CC率74.63%: ' + Cc.formatCcRate(r.summary.rate));
    assert(r.summary.notEligible === 15, '対象外15行（Not Attempt含む）は集計されない');
  }
  assert(JSON.stringify(base.summary) === JSON.stringify(withAff.summary), '所属指定の有無でsummaryが変わらない');
  assert(JSON.stringify(base.byReason) === JSON.stringify(withAff.byReason), '所属指定の有無でbyReasonが変わらない');
  assert(JSON.stringify(base.byDriver) === JSON.stringify(withAff.byDriver), '所属指定の有無でbyDriverが変わらない');
  assert(JSON.stringify(base.byDate) === JSON.stringify(withAff.byDate), '所属指定の有無でbyDateが変わらない');
  assert(base.byAffiliation.length === 1 && base.byAffiliation[0].affiliation === '所属未判定', '所属resolver無しは全件「所属未判定」');
  return withAff;
}

function testAffiliationAggregation(r) {
  assert(r.aggregationCheck.ok, '集計整合性: ' + r.aggregationCheck.errors.join('; '));
  assert(Cc.verifyCcAggregation(r).ok, 'verifyCcAggregation');
  const names = r.byAffiliation.map(a => a.affiliation);
  assert(['GDSダイレクト', 'JHS', 'AE物流', '所属未判定'].every(n => names.indexOf(n) >= 0), '所属4グループ: ' + names);
  const unk = r.byAffiliation.filter(a => a.affiliation === '所属未判定')[0];
  assert(unk && unk.total > 0 && unk.drivers.length === 2, '所属不明DA(T07,T08)は除外せず「所属未判定」に集計');
  assert(sum(r.byAffiliation, 'total') === 678 && sum(r.byAffiliation, 'nonCompliant') === 172 && sum(r.byAffiliation, 'compliant') === 506, '所属合計=全体');
  for (let i = 0; i < 4; i++) {
    assert(sum(r.byAffiliation.map(a => a.byReason[i]), 'total') === r.byReason[i].total, '所属別理由合計=全体理由別 ' + REASONS[i]);
    assert(sum(r.byAffiliation.map(a => a.byReason[i]), 'nonCompliant') === r.byReason[i].nonCompliant, '所属別理由NC合計=全体 ' + REASONS[i]);
  }
  // DA別内訳
  r.byAffiliation.forEach(a => a.drivers.forEach(d => {
    assert(sum(d.byReason, 'total') === d.total && sum(d.byReason, 'nonCompliant') === d.nonCompliant, 'DA理由合計=DA ' + d.transporterId);
    assert(d.affiliation === a.affiliation, 'DAの所属');
  }));
  // 既定の並び: NC降順
  for (let i = 1; i < r.byAffiliation.length; i++) assert(r.byAffiliation[i - 1].nonCompliant >= r.byAffiliation[i].nonCompliant, '所属はNC降順');
  r.byAffiliation.forEach(a => { for (let i = 1; i < a.drivers.length; i++) assert(a.drivers[i - 1].nonCompliant >= a.drivers[i].nonCompliant, 'DAはNC降順'); });
  const byRate = Cc.sortCcAffiliationStats(r.byAffiliation, 'rateAsc');
  for (let i = 1; i < byRate.length; i++) assert(byRate[i - 1].rate <= byRate[i].rate, 'CC率昇順');
  const byTotal = Cc.sortCcAffiliationStats(r.byAffiliation, 'totalDesc');
  for (let i = 1; i < byTotal.length; i++) assert(byTotal[i - 1].total >= byTotal[i].total, '対象件数降順');
  // 整合性チェックは壊れた集計を検出できる
  const broken = JSON.parse(JSON.stringify(r));
  broken.byAffiliation[0].drivers[0].nonCompliant += 1;
  assert(!Cc.verifyCcAggregation(broken).ok, '不整合を検出する');
}

function testWk40Unchanged() {
  const csv = readFileSync(join(root, 'tests/fixtures/contact-compliance/wk40-ofk3-contact-compliance-sanitized.csv'), 'utf8');
  const wb = XLSX.read(csv, { type: 'string', raw: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
  const tids = Array.from(new Set(rows.slice(1).map(r => r[5])));
  const aff = tid => (tids.indexOf(tid) % 3 === 0 ? '' : 'GROUP' + (tids.indexOf(tid) % 3));
  const r = Cc.analyzeCcRows(rows, null, aff);
  assert(r.summary.total === 575 && r.summary.compliant === 453 && r.summary.nonCompliant === 122, 'Wk40 575/453/122 不変');
  assert(Cc.formatCcRate(r.summary.rate) === '78.78%', 'Wk40 78.78% 不変');
  assert(r.aggregationCheck.ok, 'Wk40 集計整合性');
}

function testNotAttempt() {
  assert(Cc.CC_ELIGIBLE_REASONS.length === 4 && Cc.CC_ELIGIBLE_REASONS.indexOf('NOT_ATTEMPT') < 0, 'Not AttemptはCC対象理由に追加していない');
  ['Not Attempt', 'NOT_ATTEMPT', 'not attempt', 'Not-Attempt'].forEach(v => assert(Cc.getCcReasonLabel(v) === '配達未試行', 'core表示: ' + v));
  assert(Cc.getCcReasonLabel('CUSTOMER_UNAVAILABLE') === '不在' && Cc.getCcReasonLabel('UNKNOWN_X') === 'UNKNOWN_X', '既存ラベル・未知コードは従来どおり');
  assert(Cc.getCcStatus({ shipmentReason: 'Not Attempt', callEvent: '', textEvent: '' }) === 'NOT_ELIGIBLE', 'Not Attemptは対象外のまま');
  assert(Cc.getCcStatus({ shipmentReason: 'Not Attempt', callEvent: 'Calls to Customer', textEvent: '' }) === 'NOT_ELIGIBLE', 'Contactがあっても対象外のまま');

  // FTDS画面/Excelの変換（index.html の実コードをvmで実行）。元コードは内部データに保持される。
  const start = html.indexOf('    var REASON_JA = {');
  const reasonJa = html.slice(start, html.indexOf('};', start) + 2);
  function extractFn(name) {
    const st = html.indexOf('    function ' + name + '(');
    let i = html.indexOf('{', st), depth = 0;
    for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}' && --depth === 0) break; }
    return html.slice(st, i + 1);
  }
  const sb = { XLSX, console };
  vm.createContext(sb);
  vm.runInContext(reasonJa + '\n' + extractFn('translateReason') + '\n' + extractFn('buildFtdsAoa'), sb);
  ['Not Attempt', 'NOT_ATTEMPT', 'not attempt'].forEach(v => assert(sb.translateReason(v) === '配達未試行', 'FTDS表示: ' + v));
  assert(sb.translateReason('CUSTOMER_UNAVAILABLE') === '不在', 'FTDS既存変換は不変');
  const records = [
    { driverName: 'A', transporterId: 'T1', reason: 'Not Attempt', date: '2026-10-01', cycle: '', route: '', tracking: 'TR1', zip: '' },
    { driverName: 'A', transporterId: 'T1', reason: 'Not Attempt', date: '2026-10-02', cycle: '', route: '', tracking: 'TR2', zip: '' },
    { driverName: 'B', transporterId: 'T2', reason: 'CUSTOMER_UNAVAILABLE', date: '2026-10-02', cycle: '', route: '', tracking: 'TR3', zip: '' }
  ];
  const aoa = sb.buildFtdsAoa(records);
  const flat = JSON.stringify(aoa);
  assert(flat.indexOf('配達未試行:2') >= 0, 'DA別集計（Excel）に「配達未試行:2」: ' + flat);
  assert(flat.indexOf('Not Attempt') < 0, 'Excel出力に原文が漏れない（詳細・集計とも日本語）');
  assert(records[0].reason === 'Not Attempt', '内部データの元コードは保持');
}

function testExcel(r) {
  const wb = XLSX.read(XLSX.write(Cc.buildCcExportWorkbook(XLSX, r, 'nonCompliantDesc', ['GDSダイレクト', 'JHS', 'AE物流']), { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  assert(wb.SheetNames.join() === '全体,GDSダイレクト,JHS,AE物流,所属未判定,CCサマリー,所属別サマリー,所属別DA分析,理由別,DA別,日別,Non-Compliant明細', 'シート順: ' + wb.SheetNames);
  const aoa = n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: true });
  const a = aoa('所属別サマリー');
  assert(a[0].join() === '所属,DA数,対象件数,Compliant,Non-Compliant,CC率', '所属別サマリー見出し');
  const total = a[a.length - 1];
  assert(total[0] === '合計' && total[2] === 678 && total[3] === 506 && total[4] === 172 && total[5] === 74.63, '所属別サマリー合計行: ' + total);
  const body = a.slice(1, -1);
  assert(sum(body.map(x => ({ v: x[2] })), 'v') === 678 && sum(body.map(x => ({ v: x[4] })), 'v') === 172, '所属行の合計=全体');
  for (let i = 1; i < body.length; i++) assert(body[i - 1][4] >= body[i][4], '所属別サマリーはNC降順');

  const d = aoa('所属別DA分析');
  assert(d[0].join() === '所属,DA名,Transporter ID,配送理由,Shipment Reason（原文コード）,対象件数,Compliant,Non-Compliant,CC率,DA合計 対象件数,DA合計 Non-Compliant,DA合計 CC率,所属候補（競合時）', '所属別DA分析見出し');
  const dBody = d.slice(1);
  assert(sum(dBody.map(x => ({ v: x[5] })), 'v') === 678 && sum(dBody.map(x => ({ v: x[7] })), 'v') === 172, '所属別DA分析の合計=全体');
  assert(dBody.every(x => REASONS.indexOf(x[4]) >= 0 && x[3] === Cc.getCcReasonLabel(x[4])), '配送理由は日本語＋原文コード別列');
  assert(dBody.some(x => x[0] === '所属未判定'), '所属未判定を出力');
  assert(/^\d+\.\d\d%$/.test(wb.Sheets['所属別DA分析'][XLSX.utils.encode_cell({ r: 1, c: 8 })].w), 'CC率の表示形式（0.00%）');

  const reason = aoa('理由別');
  assert(reason.length === 5 && sum(reason.slice(1).map(x => ({ v: x[2] })), 'v') === 678, '理由別合計=全体');
  const nc = aoa('Non-Compliant明細');
  assert(nc.length === 173 && nc[0][10] === '所属', 'NC明細172件＋所属列');
}

function testTabView(r) {
  const order = ['GDSダイレクト', 'JHS', 'AE物流'];
  const tabs = Cc.buildCcAffiliationTabs(r, order);
  assert(tabs.map(x => x.label).join() === '全体,GDSダイレクト,JHS,AE物流,所属未判定', 'タブ順（マスタ順→所属未判定）: ' + tabs.map(x => x.label));
  assert(tabs[0].key === Cc.CC_TAB_ALL_KEY && tabs[0].total === 678 && tabs[0].compliant === 506 && tabs[0].nonCompliant === 172, '全体タブ=全体集計');
  assert(tabs.slice(1).reduce((a, x) => a + x.total, 0) === 678 && tabs.slice(1).reduce((a, x) => a + x.nonCompliant, 0) === 172, '所属タブの合計=全体');
  // マスタ順外の所属は後ろ、競合・未判定は最後
  const withOther = JSON.parse(JSON.stringify(r));
  withOther.byAffiliation.push({ affiliation: 'ZZ社', identified: true, total: 0, compliant: 0, nonCompliant: 0, rate: null, drivers: [], byReason: [] });
  withOther.byAffiliation.push({ affiliation: '所属競合', identified: false, conflict: true, total: 0, compliant: 0, nonCompliant: 0, rate: null, drivers: [], byReason: [] });
  assert(Cc.buildCcAffiliationTabs(withOther, order).map(x => x.label).join() === '全体,GDSダイレクト,JHS,AE物流,ZZ社,所属競合,所属未判定', '未知の所属→所属競合→所属未判定の順');
  assert(Cc.buildCcAffiliationTabs(withOther, order)[5].kind === 'conflict', '競合タブのkind');
  // 全体タブ: 全DA、各所属タブ: その所属のDAのみ
  const all = Cc.buildCcTabRows(r, Cc.CC_TAB_ALL_KEY, 'nonCompliantDesc');
  assert(all.length === r.byDriver.length && all.every(d => d.affiliation), '全体タブに全DA＋所属');
  for (let i = 1; i < all.length; i++) assert(all[i - 1].nonCompliant >= all[i].nonCompliant, '全体タブはNC降順');
  tabs.slice(1).forEach(tab => {
    const rows = Cc.buildCcTabRows(r, tab.key, 'nonCompliantDesc');
    assert(rows.length === tab.driverCount && rows.every(d => d.affiliation === tab.key), 'タブのDAは当該所属のみ: ' + tab.key);
    assert(rows.reduce((a, d) => a + d.total, 0) === tab.total && rows.reduce((a, d) => a + d.compliant, 0) === tab.compliant && rows.reduce((a, d) => a + d.nonCompliant, 0) === tab.nonCompliant, 'DA合計=タブ上部の所属合計: ' + tab.key);
    for (let q = 0; q < 4; q++) {
      assert(rows.reduce((a, d) => a + d.byReason[q].total, 0) === r.byAffiliation.filter(g => g.affiliation === tab.key)[0].byReason[q].total, '理由別合計=所属の理由別: ' + tab.key + REASONS[q]);
    }
    rows.forEach(d => assert(d.byReason.map(x => x.reason).join() === REASONS.join(), '理由の列順は固定'));
  });
  assert(all.reduce((a, d) => a + d.total, 0) === 678, '全体タブのDA合計=678');
  // 表示ビューは集計を変えない
  assert(JSON.stringify(r.summary) === JSON.stringify(Cc.analyzeCcRows(w41LikeRows(), resolveName, resolveAff).summary), 'ビュー生成後もsummary不変');
}

// ---- Excel 所属別シート（画面の所属別タブと同一）: 並び・内容・合計一致・シート名安全化 ----
function wk41LikeConflictResult() {
  const rows = w41LikeRows();
  // T08 を競合にして「所属競合」「所属未判定」の両方を作る
  const aff = tid => (tid === 'T08' ? { conflict: true, candidates: ['AE物流', 'JHS'] } : (AFFS[tid] || ''));
  return Cc.analyzeCcRows(rows, resolveName, aff);
}

function testAffiliationSheets() {
  const r = wk41LikeConflictResult();
  const order = ['GDSダイレクト', 'JHS', 'AE物流'];
  const wb = XLSX.read(XLSX.write(Cc.buildCcExportWorkbook(XLSX, r, 'nonCompliantDesc', order), { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const names = wb.SheetNames;
  assert(names.join() === '全体,GDSダイレクト,JHS,AE物流,所属競合,所属未判定,CCサマリー,所属別サマリー,所属別DA分析,理由別,DA別,日別,Non-Compliant明細', 'シート順: ' + names);
  const tabs = Cc.buildCcAffiliationTabs(r, order);
  assert(tabs.map(t => t.label).join() === names.slice(0, tabs.length).join(), '画面のタブ順とExcelのシート順が一致');
  const aoa = n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: true });
  const REASON_JA = REASONS.map(c => Cc.getCcReasonLabel(c));
  let allSum = null;
  const sums = { total: 0, compliant: 0, nonCompliant: 0, das: 0 };
  tabs.forEach(tab => {
    const a = aoa(tab.label);
    assert(a[0][0] === '所属' && a[0][1] === tab.label, '所属名: ' + tab.label);
    assert(a[1].slice(0, 5).join() === 'DA数,対象,Compliant,Non-Compliant,CC率', '所属合計の見出し');
    assert(a[2][0] === tab.driverCount && a[2][1] === tab.total && a[2][2] === tab.compliant && a[2][3] === tab.nonCompliant, '所属合計: ' + tab.label + JSON.stringify(a[2]));
    const isAll = tab.kind === 'all';
    const hd = a[4];
    const expectHead = ['DA名', 'Transporter ID'].concat(isAll ? ['所属'] : [], ['対象件数', 'Compliant', 'Non-Compliant', 'CC率'], REASON_JA, (isAll || tab.kind === 'conflict') ? ['所属候補（競合時）'] : []);
    assert(hd.join() === expectHead.join(), '列構成(' + tab.label + '): ' + hd);
    const body = a.slice(5, -1), total = a[a.length - 1];
    assert(total[0] === '合計', '末尾に合計行: ' + tab.label);
    const o = isAll ? 1 : 0;
    assert(body.length === tab.driverCount, 'DA行数=DA数: ' + tab.label);
    const sumCol = c => body.reduce((s, x) => s + x[c], 0);
    assert(sumCol(2 + o) === tab.total && sumCol(3 + o) === tab.compliant && sumCol(4 + o) === tab.nonCompliant, 'DA行の合計=所属合計: ' + tab.label);
    assert(total[2 + o] === tab.total && total[3 + o] === tab.compliant && total[4 + o] === tab.nonCompliant, '合計行=所属合計: ' + tab.label);
    // 理由別セル: 「件数（NC n）」。行合計=DA合計
    body.forEach(x => {
      let t = 0, n = 0;
      for (let q = 0; q < 4; q++) {
        const cell = x[6 + o + q];
        const m = /^(\d+)（NC (\d+)）$/.exec(cell);
        assert(cell === '-' || m, '理由別セル形式: ' + cell);
        if (m) { t += +m[1]; n += +m[2]; }
      }
      assert(t === x[2 + o] && n === x[4 + o], 'DAの理由別合計=DA合計: ' + x[0]);
    });
    for (let q = 0; q < 4; q++) {
      const re = /^(\d+)（NC (\d+)）$/;
      const tt = total[6 + o + q];
      assert(re.test(tt), '合計行の理由別形式');
    }
    if (tab.kind === 'conflict') {
      assert(body.length > 0 && body.every(x => x[x.length - 1] === 'AE物流 / JHS'), '所属競合シートは候補所属を併記');
    }
    if (isAll) {
      allSum = { total: total[2 + o], compliant: total[3 + o], nonCompliant: total[4 + o], das: body.length };
      assert(body.every(x => x[2] && x[2] !== ''), '全体シートは所属列あり');
      assert(body.some(x => x[2] === '所属競合' && x[x.length - 1] === 'AE物流 / JHS'), '全体シートでも競合DAに候補併記');
    } else {
      sums.total += total[2]; sums.compliant += total[3]; sums.nonCompliant += total[4]; sums.das += body.length;
    }
  });
  assert(allSum.total === 678 && allSum.compliant === 506 && allSum.nonCompliant === 172, '全体シート=678/506/172');
  assert(sums.total === allSum.total && sums.compliant === allSum.compliant && sums.nonCompliant === allSum.nonCompliant && sums.das === allSum.das, '全体と所属別（競合・未判定含む）の合計が一致');
  // CC率の表示形式
  assert(/^\d+\.\d\d%$/.test(wb.Sheets['全体'][XLSX.utils.encode_cell({ r: 2, c: 4 })].w), '所属合計のCC率書式');
  // 既存の分析シートは削除されていない
  ['CCサマリー', '所属別サマリー', '所属別DA分析', '理由別', 'DA別', '日別', 'Non-Compliant明細'].forEach(n => assert(names.indexOf(n) >= 0, '既存シート維持: ' + n));
  assert(aoa('Non-Compliant明細').length === 173 && aoa('DA別').length - 1 === r.byDriver.length, '既存シートの内容は従来どおり');
  // 並び替えが画面の選択に追従
  const wb2 = Cc.buildCcExportWorkbook(XLSX, r, 'rateAsc', order);
  const all2 = XLSX.utils.sheet_to_json(wb2.Sheets['全体'], { header: 1, defval: '', raw: true }).slice(5, -1);
  for (let i = 1; i < all2.length; i++) assert((typeof all2[i - 1][6] === 'number' ? all2[i - 1][6] : Infinity) <= (typeof all2[i][6] === 'number' ? all2[i][6] : Infinity), '全体シートはCC率昇順');
}

function testSheetNameSafety() {
  const used = {};
  assert(Cc.ccSafeSheetName('A/B\\C?D*E[F]G:H', {}) === 'A_B_C_D_E_F_G_H', '禁止文字を置換');
  assert(Cc.ccSafeSheetName("'quoted'", {}) === 'quoted', '前後のアポストロフィ除去');
  assert(Cc.ccSafeSheetName('', {}) === 'Sheet', '空名');
  const long = 'あ'.repeat(40);
  const a = Cc.ccSafeSheetName(long, used), b = Cc.ccSafeSheetName(long, used);
  assert(a.length === 31 && b.length <= 31 && a !== b, '31文字超は切詰め、重複は連番: ' + a + ' / ' + b);
  assert(Cc.ccSafeSheetName('ABC', used) !== Cc.ccSafeSheetName('abc', used), '大文字小文字違いも別名（Excelは区別しない）');
  assert(Cc.ccSafeSheetName('History', {}) !== 'History', '予約名Historyを避ける');

  // 所属名が固定シート名・全体と衝突/禁止文字/長すぎる場合でもブックが生成でき、全シート名が一意
  const rows = [['Event Date', 'Scannable ID', 'Destination Address ID', 'Transporter ID', 'Shipment Reason', 'Call Event', 'Text Event']];
  const depts = { A1: '理由別', A2: 'JHS/本部:第1', A3: 'JHS／本部：第1', A4: 'あ'.repeat(35) + 'X', A5: 'あ'.repeat(35) + 'Y', A6: 'jhs/本部:第1' };
  Object.keys(depts).forEach((t, i) => { rows.push(['2026-10-04', 'S' + i, 'D' + i, t, 'CUSTOMER_UNAVAILABLE', i % 2 ? 'Calls to Customer' : '', '']); });
  const r = Cc.analyzeCcRows(rows, null, t => depts[t] || '');
  const wb = Cc.buildCcExportWorkbook(XLSX, r, 'nonCompliantDesc', []);
  const names = wb.SheetNames;
  assert(new Set(names.map(n => n.toLowerCase())).size === names.length, 'シート名が一意（大文字小文字無視）: ' + names);
  assert(names.every(n => n.length <= 31 && !/[\\\/\?\*\[\]:]/.test(n)), 'シート名は31文字以内で禁止文字なし');
  assert(names.filter(n => n === '理由別').length === 1 && names.indexOf('理由別_2') >= 0, '所属名が固定シート名と衝突しても固定シートは維持し所属側を連番に');
  const tabs = Cc.buildCcAffiliationTabs(r, []);
  assert(names.length === tabs.length + 7, 'タブ数＋7分析シート: ' + names.length);
  // 切詰め・変換された所属の元の名前はシート内（所属行）とCCサマリーに残る
  const sum = XLSX.utils.sheet_to_json(wb.Sheets['CCサマリー'], { header: 1, defval: '' });
  assert(sum.some(x => x[0] === 'シート名変換' && /JHS\/本部:第1 → JHS_本部_第1/.test(x[1])), 'CCサマリーにシート名変換を記録');
  const tabSheet = XLSX.utils.sheet_to_json(wb.Sheets[names[names.indexOf('理由別_2')]], { header: 1, defval: '' });
  assert(tabSheet[0][1] === '理由別', 'シート内に元の所属名を保持');
  // 合計一致
  const tot = names.slice(1, tabs.length).reduce((s, n) => s + XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: true })[2][1], 0);
  assert(tot === r.summary.total, '安全化後も所属シート合計=全体: ' + tot);
}

const r = testW41Regression(); console.log('PASS testW41Regression');
testAffiliationAggregation(r); console.log('PASS testAffiliationAggregation');
testWk40Unchanged(); console.log('PASS testWk40Unchanged');
testNotAttempt(); console.log('PASS testNotAttempt');
testExcel(r); console.log('PASS testExcel');
testTabView(r); console.log('PASS testTabView');
testAffiliationSheets(); console.log('PASS testAffiliationSheets');
testSheetNameSafety(); console.log('PASS testSheetNameSafety');
console.log('cc-affiliation tests passed (8)');
