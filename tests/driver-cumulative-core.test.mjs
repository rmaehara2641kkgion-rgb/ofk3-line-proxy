// ドライバー別配送データ 累計データ作成モード（driver-cumulative-core / -xlsx）
// 個人名は使わず、テスト内で生成した合成データのみを使う。実サンプルでの回帰は
// 環境変数 DRIVER_CUM_SAMPLE_DIR（基準累計・追加週・期待累計のxlsxを置いたフォルダ）がある場合のみ実行する。
import { createRequire } from 'module';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const C = require(join(root, 'driver-cumulative-core.js'));
const W = require(join(root, 'driver-cumulative-xlsx.js'));
const JSZip = require('jszip');
const XLSX = require('xlsx');

const MAIN_H = ['配達アソシエート', '集計対象稼働日数', '総稼働時間(h)', '配送個数合計\n(集計対象日)', '1時間あたり配送個数', '参考:期間中配送個数\n(全日合計)', '総走行距離(km)', '回収/正配依頼\n(件数)', '誤配回収/正配依頼\n(件数)', '正配依頼\n合計', '誤配率', '配管率%\n(平均)'];
const SIMPLE_H = ['配達アソシエート', '稼働日数', '総稼働時間(h)\n(ログイン～ログアウト)', '配送個数合計', '1時間あたり配送個数', '総走行距離(km)', '回収/正配依頼\n(件数)', '誤配回収/正配依頼\n(件数)', '正配依頼\n合計', '配管率%\n(平均)'];

// d = {name, days, hours, pkg, allPkg, km, kaishu, gohai, rate}
function mainRow(d) {
  const seihai = (d.kaishu ?? 0) + (d.gohai ?? 0);
  return [d.name, d.days, d.hours, d.pkg, d.hours > 0 ? d.pkg / d.hours : 0, d.allPkg ?? d.pkg, d.km, d.kaishu ?? 0, d.gohai ?? 0, seihai,
    d.pkg > 0 ? seihai / d.pkg : 0, d.rate === undefined ? null : d.rate];
}
function simpleRow(d) {
  const seihai = (d.kaishu ?? 0) + (d.gohai ?? 0);
  return [d.name, d.days, d.hours, d.pkg, d.hours > 0 ? d.pkg / d.hours : 0, d.km, d.kaishu ?? 0, d.gohai ?? 0, seihai, d.rate === undefined ? null : d.rate];
}
function weeklyFile(fileName, week, dates, drivers, opts = {}) {
  return C.parseWorkbook({
    fileName, fileHash: opts.hash || createHash('sha256').update(fileName + JSON.stringify(drivers)).digest('hex'),
    sheetNames: ['ドライバー別集計', '簡易版(ログイン-ログアウトのみ)', '算出方法・注記'],
    aoa: {
      'ドライバー別集計': [MAIN_H, ...drivers.map(mainRow)],
      '簡易版(ログイン-ログアウトのみ)': [SIMPLE_H, ...(opts.simple || drivers).map(simpleRow)],
      '算出方法・注記': [['集計期間', `${dates}（GDS明細の全日付。Concessions週: ${week}、週数: 1）`]]
    }
  });
}
function cumulativeFile(fileName, periodText, drivers, opts = {}) {
  const note = [['対象期間', periodText], ['基準ファイル', 'x'], ['追加ファイル', 'y']].concat(opts.noteExtra || []);
  return C.parseWorkbook({
    fileName, fileHash: opts.hash || createHash('sha256').update(fileName + periodText).digest('hex'),
    sheetNames: ['ドライバー別集計', '簡易版(ログイン-ログアウトのみ)', '検証・算出方法'],
    aoa: { 'ドライバー別集計': [MAIN_H, ...drivers.map(mainRow)], '簡易版(ログイン-ログアウトのみ)': [SIMPLE_H, ...drivers.map(simpleRow)], '検証・算出方法': note }
  });
}
const D = (name, o) => Object.assign({ name, days: 2, hours: 10, pkg: 200, km: 100, kaishu: 0, gohai: 0, rate: 98 }, o || {});
const ack = { acknowledgeInsufficientHistory: true };
const byName = (plan, role, name) => plan.rows[role].find(r => r.name === name);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} != ${b}`);

let passed = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; console.log('ok -', name); }); }

function makeBase() {
  return cumulativeFile('base.xlsx', 'W22〜W40', [
    D('DA-A', { days: 10, hours: 40, pkg: 1000, allPkg: 1200, km: 500, kaishu: 1, gohai: 2, rate: 99 }),
    D('DA-B', { days: 4, hours: 16, pkg: 300, km: 80, rate: 95 }),
    D('DA-ONLY-BASE', { days: 3, hours: 9, pkg: 90, km: 30, rate: null })
  ]);
}
function makeAdd() {
  return weeklyFile('w41.xlsx', 'W41', '2026/10/4 〜 2026/10/10', [
    D('DA-A', { days: 5, hours: 25, pkg: 500, allPkg: 700, km: 250, kaishu: 0, gohai: 1, rate: 97 }),
    D('DA-B', { days: 1, hours: 5, pkg: 60, km: 20, rate: null }),
    D('DA-NEW', { days: 2, hours: 8, pkg: 160, km: 40, rate: 96.5 })
  ]);
}

await test('加算・再計算・加重平均・新規追加・基準のみ保持（両シート）', () => {
  const plan = C.planMerge(makeBase(), [makeAdd()], ack);
  assert.equal(plan.errorCount, 0);
  assert.equal(plan.canGenerate, true);
  assert.equal(plan.periodLabel, 'W22〜W41');
  const a = byName(plan, 'main', 'DA-A').v;
  assert.equal(a.days, 15); near(a.hours, 65); assert.equal(a.pkg, 1500); assert.equal(a.allPkg, 1900);
  assert.equal(a.km, 750); assert.equal(a.kaishu, 1); assert.equal(a.gohai, 3); assert.equal(a.seihai, 4);
  near(a.pph, 1500 / 65, 'pph は累計個数÷累計時間');
  assert.notEqual(a.pph, (40 / 40 * 25 + 20) / 2);            // 週別効率の単純平均ではない
  near(a.mis, 4 / 1500, '誤配率=正配依頼合計÷配送個数');
  near(a.rate, (99 * 10 + 97 * 5) / 15, '配管率=稼働日数の加重平均');
  const s = byName(plan, 'simple', 'DA-A').v;
  assert.equal(s.days, 15); near(s.rate, (99 * 10 + 97 * 5) / 15);
  assert.equal(s.mis, undefined);                              // 簡易版に誤配率列はない
  assert.equal(byName(plan, 'main', 'DA-B').v.rate, 95);       // 追加側が空欄 → 基準の値を保持
  assert.equal(byName(plan, 'main', 'DA-NEW').fromBase, false);
  near(byName(plan, 'main', 'DA-NEW').v.rate, 96.5);
  const only = byName(plan, 'main', 'DA-ONLY-BASE');
  assert.equal(only.touched, false); assert.equal(only.v.pkg, 90); assert.equal(only.v.rate, null);
  assert.equal(plan.rows.main.length, 4); assert.equal(plan.rows.simple.length, 4);
  assert.equal(plan.summary.sheets.main.merged, 2); assert.equal(plan.summary.sheets.main.added, 1); assert.equal(plan.summary.sheets.main.baseOnly, 1);
});

await test('複数の追加ファイルを順に統合でき、順序に依存しない', () => {
  const w42 = weeklyFile('w42.xlsx', 'W42', '2026/10/11 〜 2026/10/17', [D('DA-A', { days: 3, hours: 12, pkg: 240, km: 60, rate: 90 })]);
  const p1 = C.planMerge(makeBase(), [makeAdd(), w42], ack);
  const p2 = C.planMerge(makeBase(), [w42, makeAdd()], ack);
  assert.equal(p1.periodLabel, 'W22〜W42');
  near(byName(p1, 'main', 'DA-A').v.rate, (99 * 10 + 97 * 5 + 90 * 3) / 18);
  near(byName(p1, 'main', 'DA-A').v.rate, byName(p2, 'main', 'DA-A').v.rate);
  assert.equal(byName(p1, 'main', 'DA-A').v.pkg, 1740);
});

await test('0と空欄を区別し、0除算しない', () => {
  const base = cumulativeFile('b.xlsx', 'W1〜W2', [D('X', { days: 0, hours: 0, pkg: 0, km: 0, rate: 0 })]);
  base.main.rows[0].v.allPkg = null;                       // 空欄
  const add = weeklyFile('a.xlsx', 'W3', '2026/1/1 〜 2026/1/7', [D('X', { days: 0, hours: 0, pkg: 0, km: 0, rate: 50 })]);
  add.main.rows[0].v.allPkg = null;
  const plan = C.planMerge(base, [add], ack);
  const x = byName(plan, 'main', 'X').v;
  assert.equal(x.allPkg, null, '両方空欄なら空欄のまま');
  assert.equal(x.pph, 0); assert.equal(x.mis, 0);
  assert.equal(x.rate, null, '重み0の配管率は推測せず空欄');
  assert.ok(plan.issues.some(i => i.code === 'RATE_WEIGHT_ZERO'));
  // 片側だけ数値なら空欄を0にせずその値
  add.main.rows[0].v.allPkg = 7;
  assert.equal(byName(C.planMerge(base, [add], ack), 'main', 'X').v.allPkg, 7);
  // 時間・個数が空欄なら個/時間・誤配率も空欄
  const b2 = cumulativeFile('b.xlsx', 'W1', [D('Y')]); b2.main.rows[0].v.hours = null;
  const a2 = weeklyFile('a.xlsx', 'W2', '2026/1/1 〜 2026/1/7', [D('Y')]); a2.main.rows[0].v.hours = null;
  assert.equal(byName(C.planMerge(b2, [a2], ack), 'main', 'Y').v.pph, null);
});

await test('二重追加の防止（期間重複・同一内容・累計の再利用）', () => {
  // 同じ週を再度追加
  const dup = weeklyFile('w41-again.xlsx', 'W41', '2026/10/4 〜 2026/10/10', [D('DA-A')]);
  const generated = (() => {
    const plan = C.planMerge(makeBase(), [makeAdd()], ack);
    return plan;
  })();
  const out = C.buildOutputModel(generated, { nowIso: '2026-10-25T00:00:00.000Z' });
  const asBase = C.parseWorkbook({
    fileName: out.fileName, fileHash: 'h-out', sheetNames: out.sheets.map(s => s.name),
    aoa: Object.fromEntries(out.sheets.map(s => [s.name, s.kind === 'note' ? s.rows : [s.columns.map(c => c.header), ...s.rows]]))
  });
  assert.equal(asBase.note.historyLevel, 'full');
  const p = C.planMerge(asBase, [dup], {});
  assert.equal(p.canGenerate, false);
  assert.ok(p.issues.some(i => i.code === 'PERIOD_OVERLAP' && /差し替え/.test(i.cause)), '差し替え手順の案内');
  assert.ok(p.issues.some(i => i.code === 'DATE_OVERLAP'));
  // 内容同一（ハッシュ）
  const same = makeAdd();
  const w42 = weeklyFile('w42.xlsx', 'W42', '2026/10/11 〜 2026/10/17', [D('DA-A')], { hash: same.fileHash });
  const p2 = C.planMerge(asBase, [w42], {});
  assert.ok(p2.issues.some(i => i.code === 'DUPLICATE_FILE'));
  assert.equal(p2.canGenerate, false);
  // 履歴付き累計に新しい週は追加でき、確認不要
  const w43 = weeklyFile('w43.xlsx', 'W43', '2026/10/18 〜 2026/10/24', [D('DA-A')]);
  const p3 = C.planMerge(asBase, [w43], {});
  assert.equal(p3.canGenerate, true);
  assert.equal(p3.periodLabel, 'W22〜W41,W43');
  assert.ok(p3.issues.some(i => i.code === 'PERIOD_GAP' && /W42/.test(i.cause)), '欠週は警告');
  // 追加ファイル同士の重複
  const p4 = C.planMerge(makeBase(), [makeAdd(), weeklyFile('copy.xlsx', 'W41', '2026/10/4 〜 2026/10/10', [D('DA-A')])], ack);
  assert.equal(p4.canGenerate, false);
});

await test('履歴が不十分な基準はファイル名だけで安全と断定せず、確認を要求する', () => {
  const plan = C.planMerge(makeBase(), [makeAdd()], {});
  assert.equal(plan.needsAck, true); assert.equal(plan.canGenerate, false);
  assert.ok(plan.issues.some(i => i.code === 'HISTORY_INSUFFICIENT'));
  // 期間が読めない基準は停止
  const noPeriod = cumulativeFile('累計W22-W40.xlsx', '', [D('A')]);
  const p = C.planMerge(noPeriod, [makeAdd()], ack);
  assert.ok(p.issues.some(i => i.code === 'BASE_PERIOD_UNKNOWN')); assert.equal(p.canGenerate, false);
  // 手入力の基準期間なら進められる（要確認）
  const p2 = C.planMerge(noPeriod, [makeAdd()], { baseWeeksOverride: 'W22〜W40', acknowledgeInsufficientHistory: true });
  assert.equal(p2.canGenerate, true);
  // 追加側の週が読めない場合も停止し、指定で解消できる
  const unknown = weeklyFile('x.xlsx', 'Wxx', '2026/10/4 〜 2026/10/10', [D('DA-A')]);
  assert.ok(C.planMerge(makeBase(), [unknown], ack).issues.some(i => i.code === 'ADD_PERIOD_UNKNOWN'));
  assert.equal(C.planMerge(makeBase(), [unknown], Object.assign({ weekOverrides: { 'x.xlsx': 'W41' } }, ack)).canGenerate, true);
});

await test('ドライバー名: 空白・全角半角・英字大小は統合、順序違いは別人として警告、手動確認で統合', () => {
  const base = cumulativeFile('b.xlsx', 'W1〜W2', [D('Ｔａｒｏ　Ｙａｍａ'), D('Hanako Sato'), D('姓 名')]);
  const add = weeklyFile('a.xlsx', 'W3', '2026/1/1 〜 2026/1/7', [D('taro  yama'), D('Sato Hanako'), D('姓名'), D('Other One')]);
  const plan = C.planMerge(base, [add], ack);
  assert.equal(byName(plan, 'main', 'Ｔａｒｏ　Ｙａｍａ').touched, true, '全角・大小・空白の揺れは統合');
  assert.equal(byName(plan, 'main', '姓 名').touched, true, '空白有無のみの違いは統合');
  assert.equal(plan.rows.main.length, 5, 'Hanako Sato / Sato Hanako は別人として追加');
  const amb = plan.issues.filter(i => i.code === 'NAME_AMBIGUOUS');
  assert.equal(amb.length, 2); assert.equal(plan.needsReview, true);
  assert.ok(amb[0].file && amb[0].driver && amb[0].field && amb[0].cause);
  const merged = C.planMerge(base, [add], Object.assign({ manualMappings: { [C.normalizeName('Sato Hanako')]: 'Hanako Sato' } }, ack));
  assert.equal(byName(merged, 'main', 'Hanako Sato').touched, true);
  assert.equal(merged.rows.main.length, 4);
});

await test('同一ファイル内の重複・数値不正・必須列欠落はエラーで停止し、出力を作らない', () => {
  const dupFile = weeklyFile('a.xlsx', 'W3', '2026/1/1 〜 2026/1/7', [D('P'), D('P')]);
  assert.equal(dupFile.ok, false);
  const plan = C.planMerge(makeBase(), [dupFile], ack);
  assert.equal(plan.canGenerate, false);
  assert.throws(() => C.buildOutputModel(plan), /出力できません/);
  const bad = C.parseWorkbook({ fileName: 'bad.xlsx', sheetNames: ['ドライバー別集計', '簡易版(ログイン-ログアウトのみ)'], aoa: {
    'ドライバー別集計': [MAIN_H, ['P', 'abc', 1, 1, 1, 1, 1, 0, 0, 0, 0, 1]], '簡易版(ログイン-ログアウトのみ)': [SIMPLE_H.slice(0, 5), ['P', 1, 1, 1, 1]] } });
  assert.ok(bad.issues.some(i => i.code === 'VALUE_INVALID' && i.driver === 'P' && i.file === 'bad.xlsx'));
  assert.ok(bad.issues.some(i => i.code === 'COLUMN_MISSING'));
  assert.equal(bad.ok, false);
  assert.equal(C.planMerge(makeBase(), [], ack).canGenerate, false);
});

await test('入力を書き換えない', () => {
  const base = makeBase(), add = makeAdd();
  const snap = JSON.stringify([base.main.rows, base.simple.rows, add.main.rows, add.simple.rows]);
  C.planMerge(base, [add], ack);
  assert.equal(JSON.stringify([base.main.rows, base.simple.rows, add.main.rows, add.simple.rows]), snap);
});

await test('出力xlsx: 3シート・見出し・書式・精度を既存レイアウトどおりに書き出す', async () => {
  const plan = C.planMerge(makeBase(), [makeAdd()], ack);
  const model = C.buildOutputModel(plan, { nowIso: '2026-10-25T00:00:00.000Z', addedFiles: [{ name: 'w41.xlsx', hash: 'abc' }] });
  assert.equal(model.fileName, 'ドライバー別配送データ_累計W22-W41.xlsx');
  const bytes = await W.buildXlsx(model, JSZip);
  const wb = XLSX.read(Buffer.from(bytes), { type: 'buffer', cellStyles: true });
  assert.deepEqual(wb.SheetNames, ['ドライバー別集計', '簡易版(ログイン-ログアウトのみ)', '検証・算出方法']);
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets['ドライバー別集計'], { header: 1, defval: null });
  assert.deepEqual(aoa[0], MAIN_H);
  assert.equal(aoa.length, 5);
  const a = aoa.find(r => r[0] === 'DA-A');
  assert.equal(a[2], 40 + 25); assert.equal(a[4], 1500 / 65); assert.equal(a[10], 4 / 1500);
  const simple = XLSX.utils.sheet_to_json(wb.Sheets['簡易版(ログイン-ログアウトのみ)'], { header: 1, defval: null });
  assert.deepEqual(simple[0], SIMPLE_H);
  const note = XLSX.utils.sheet_to_json(wb.Sheets['検証・算出方法'], { header: 1, defval: null });
  assert.deepEqual(note[0], ['対象期間', 'W22〜W41']);
  assert.ok(note.some(r => r[0] === '統合履歴(JSON)') && note.some(r => r[0] === 'ファイル識別情報(SHA-256)' && /abc/.test(r[1])));
  // 空欄は空欄のまま（0にしない）
  const only = aoa.find(r => r[0] === 'DA-ONLY-BASE');
  assert.equal(only[11], null);
  // 書式: ヘッダー色、固定ペイン、0.00_ 表示形式
  const zip = await JSZip.loadAsync(bytes);
  const styles = await zip.file('xl/styles.xml').async('string');
  assert.ok(styles.includes('FF17365D') && styles.includes('0.00_ '));
  const sheet1 = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.ok(sheet1.includes('state="frozen"') && sheet1.includes('width="24"'));
  // 出力をそのまま次回の基準にでき、再読込しても集計値が変わらない
  const reread = C.parseWorkbook({ fileName: model.fileName, fileHash: 'h', sheetNames: wb.SheetNames,
    aoa: Object.fromEntries(wb.SheetNames.map(n => [n, XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null })])) });
  assert.equal(reread.ok, true); assert.equal(reread.note.historyLevel, 'full');
  assert.deepEqual(reread.note.weeks.length, 20);
});

await test('index.html: 通常モードの要素を維持したまま累計モードが追加されている', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  for (const id of ['driver-file-input', 'driver-table-body', 'driver-db-persist-status', 'bulk-line-panel', 'driver-normal-mode', 'driver-cumulative-mode']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.includes('driver-cumulative-core.js') && html.includes('driver-cumulative-xlsx.js'));
  assert.ok(html.includes('handleDriverDataUpload(event)'), '既存の単一ファイル取込は維持');
});

// ---- 実サンプル回帰（任意） ----
const sampleDir = process.env.DRIVER_CUM_SAMPLE_DIR;
if (sampleDir && existsSync(sampleDir)) {
  const files = readdirSync(sampleDir).filter(f => f.endsWith('.xlsx'));
  const load = (f) => {
    const buf = readFileSync(join(sampleDir, f));
    const wb = XLSX.read(buf, { type: 'buffer' });
    return C.parseWorkbook({ fileName: f, fileHash: createHash('sha256').update(buf).digest('hex'), sheetNames: wb.SheetNames,
      aoa: Object.fromEntries(wb.SheetNames.map(n => [n, XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null })])) });
  };
  await test('[実サンプル] W22-W40 + W41 → 期待 W22-W41（誤配率の既知差分のみ）', () => {
    // ファイル名ではなく内容（対象期間・種別）で役割を判定する
    const parsed = files.map(load);
    const cum = parsed.filter(p => p.note.kind === 'cumulative');
    const base = cum.find(p => Math.max(...p.note.weeks) === 40);
    const exp = cum.find(p => Math.max(...p.note.weeks) === 41);
    const add = parsed.find(p => p.note.kind === 'weekly');
    assert.ok(base && exp && add, '基準・期待・追加の3ファイルが必要');
    const plan = C.planMerge(base, [add], ack);
    assert.equal(plan.canGenerate, true);
    assert.equal(plan.periodLabel, 'W22〜W41');
    for (const role of ['main', 'simple']) {
      const e = new Map(exp[role].rows.map(r => [r.key, r]));
      assert.equal(plan.rows[role].length, exp[role].rows.length);
      let misDiff = 0;
      for (const r of plan.rows[role]) {
        const x = e.get(r.key);
        assert.ok(x, '期待ファイルに存在');
        for (const k of Object.keys(r.v)) {
          const a = r.v[k], b = x.v[k];
          if (a == null && b == null) continue;
          if (k === 'mis' && Math.abs(a - b) > 1e-12) {
            // 期待ファイルは誤配回収/正配依頼 ÷ 配送個数で計算している行がある（基準・週次ファイルの定義と不一致）
            near(b, x.v.gohai / x.v.pkg, '期待側は誤配回収÷配送個数'); near(a, x.v.seihai / x.v.pkg, '本実装は正配依頼合計÷配送個数');
            misDiff++; continue;
          }
          near(a, b, `${role}.${k}`);
        }
      }
      console.log(`   ${role}: 誤配率の既知差分 ${misDiff} 行`);
    }
    // 二重追加防止
    const out = C.buildOutputModel(plan, {});
    const re = C.parseWorkbook({ fileName: out.fileName, fileHash: 'x', sheetNames: out.sheets.map(s => s.name),
      aoa: Object.fromEntries(out.sheets.map(s => [s.name, s.kind === 'note' ? s.rows : [s.columns.map(c => c.header), ...s.rows]])) });
    assert.equal(C.planMerge(re, [add], {}).canGenerate, false);
  });
} else {
  console.log('skip - 実サンプル回帰（DRIVER_CUM_SAMPLE_DIR 未設定）');
}

console.log(`\n${passed} tests passed`);
