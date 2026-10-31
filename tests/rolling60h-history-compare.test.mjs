// 架空データのみ。実データ・実履歴JSONには一切触れない（履歴は os.tmpdir() 配下の一時ファイル）。
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const Rolling = require('../rolling60h-core.js');
const Run = require('../harvest-rolling60h-run.js');
const History = require('../harvest-rolling60h-history.js');
const Harvest = require('../harvest-daily-manifest.js');
const DryRun = require('../inoichi-rolling-dryrun.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

const N = null;
const M = '○';
const R = '休';
const H = '❽';
const REF = '2026-10-18';
const D18_25 = ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];

function datesFrom(start, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(Rolling.addDays(start, i));
  return out;
}

function toDate(iso) {
  const p = iso.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

function writeBook(dir, name, sheets) {
  const wb = XLSX.utils.book_new();
  Object.keys(sheets).forEach(function (sheetName) {
    XLSX.utils.book_append_sheet(wb, Array.isArray(sheets[sheetName]) ? XLSX.utils.aoa_to_sheet(sheets[sheetName]) : sheets[sheetName], sheetName);
  });
  XLSX.writeFile(wb, path.join(dir, name));
}

// 各列に必ず勤務記号が入る補助行(FILL)を足し、空白を「混在列の空白＝未確定」にする。
// outsideColumns に入れた日付は FILL も空白にして「全員空白の列」にする。
function runCase(root, tag, spec) {
  const dates = spec.dates || D18_25;
  const dailyDir = path.join(root, 'daily-' + tag);
  const shiftDir = path.join(root, 'shift-' + tag);
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.mkdirSync(shiftDir, { recursive: true });
  const dailyRows = [['transporter_id', 'working_day', 'estimated_working_hour', 'station_code']].concat(spec.daily || []);
  writeBook(dailyDir, 'Daily_AMZL_JP_Working_Hour_2026-10-17_(FICTION).xlsx', { Report5_Daily_Data: dailyRows });
  // 既定では最終列を「全員空白の列」にする（outsideColumns: [] で無効化）
  const outside = spec.outsideColumns || [dates[dates.length - 1]];
  const fill = dates.map(function (d) { return outside.indexOf(d) >= 0 ? N : R; });
  const marks = Object.assign({ 'TID-FICTION-FILL': fill }, spec.marks);
  const aoa = [['社名', '名前', 'Transport ID'].concat(dates.map(toDate))];
  Object.keys(marks).forEach(function (tid, index) {
    aoa.push(['GDS', 'Fiction Driver ' + index, tid].concat(marks[tid]));
  });
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  // 数式の空文字: 保存値は '' の数式セル
  (spec.formulaEmpty || []).forEach(function (ref) { sheet[ref] = { t: 's', v: '', f: 'IF(1=1,"","x")' }; });
  writeBook(shiftDir, '10月DAシフト.xlsx', { GDS: sheet });
  return Run.run({ blankAsRest: false,
    fs: fs, path: path, xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
    dailyDir: dailyDir, shiftDir: shiftDir, historyFile: spec.historyFile, referenceDate: spec.referenceDate || REF,
  });
}

function exclusive(s) {
  return s.clearCount + s.exceedCount + s.approachCount + s.partialCount + s.undeterminedCount === s.driverCount;
}

function readHistory(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rolling-compare-'));

// ---------------------------------------------------------------- ケースA: 空白が後から埋まる
{
  const file = path.join(root, 'a.json');
  const first = runCase(root, 'a1', { historyFile: file, marks: { 'TID-FICTION-A': [M, M, M, M, M, N, N, N] } });
  assert(first.undeterminedCount === 1 && first.partialCount === 0 && first.exceedCount === 0, 'A1: 確定55h+空白2日は完全判定不能');
  assert(first.blankFilledWindows === 0, 'A1: 初回は比較対象なし');
  const second = runCase(root, 'a2', { historyFile: file, marks: { 'TID-FICTION-A': [M, M, M, M, M, M, M, N] } });
  assert(second.blankFilledWindows === 1 && second.blankFilledPersons === 1, 'A2: 空白→記号を1窓・1人として検出');
  assert(second.blankFilledToAlertWindows === 1 && second.exceedCount === 1 && second.undeterminedCount === 0, 'A2: 埋まった結果(77h)を再計算して超過にする');
  assert(second.normalToExceedWindows === 0, 'A2: 前回は正常ではないので「正常→超過」には数えない');
  assert(exclusive(second) && second.driverCount === first.driverCount, 'A2: 5分類は排他で母数不変');
  const third = runCase(root, 'a3', { historyFile: file, marks: { 'TID-FICTION-A': [M, M, M, M, M, M, M, N] } });
  assert(third.historyDuplicate === true && third.historyRuns === 2, 'A3: 同一内容の再実行は履歴を増やさず、予定変更も再計上しない');
  assert(third.blankFilledWindows === 0, 'A3: 重複実行では変更件数を出さない');
  // 一部だけ埋まる: 空白2日のうち1日だけ記号 → まだ未確定窓なので完全判定ではない
  const file2 = path.join(root, 'a-part.json');
  runCase(root, 'a4', { historyFile: file2, marks: { 'TID-FICTION-A': [M, M, M, M, M, N, N, N] } });
  const half = runCase(root, 'a5', { historyFile: file2, marks: { 'TID-FICTION-A': [M, M, M, M, M, M, N, N] } });
  assert(half.blankFilledWindows === 1 && half.partialCount === 1 && half.partialKnownOverCount === 1, 'A5: 一部だけ埋まって確定66hなら部分欠損の危険内訳');
  assert(half.exceedCount === 0, 'A5: 未確定が残る窓は超過にしない');
}

// ---------------------------------------------------------------- ケースB: 正常→60時間超
{
  const file = path.join(root, 'b.json');
  const first = runCase(root, 'b1', { historyFile: file, marks: { 'TID-FICTION-B': [M, M, M, M, M, R, R, N] } });
  assert(first.clearCount === 2 && first.exceedCount === 0, 'B1: 55hは正常');
  const second = runCase(root, 'b2', { historyFile: file, marks: { 'TID-FICTION-B': [M, M, M, M, M, M, R, N] } });
  assert(second.exceedCount === 1 && second.normalToExceedWindows === 1, 'B2: 66hへ更新で正常→超過を1窓追跡');
  assert(second.normalToExceedBySchedule === 1 && second.normalToExceedByDaily === 0 && second.blankFilledWindows === 0, 'B2: 原因は予定変更で、空白補完ではない');
  // 過去日のデイリー更新による正常→超過
  const week = datesFrom('2026-10-11', 7);
  const fileD = path.join(root, 'b-daily.json');
  const dailyAt = function (hours) { return week.map(function (d) { return ['TID-FICTION-D', d, hours, 'OFK3']; }); };
  const d1 = runCase(root, 'b3', { historyFile: fileD, dates: week, marks: { 'TID-FICTION-Z': week.map(function () { return R; }) }, daily: dailyAt(1) });
  assert(d1.clearCount >= 1 && d1.exceedCount === 0, 'B3: デイリー7h/週は正常');
  const d2 = runCase(root, 'b4', { historyFile: fileD, dates: week, marks: { 'TID-FICTION-Z': week.map(function () { return R; }) }, daily: dailyAt(10) });
  assert(d2.normalToExceedWindows === 1 && d2.normalToExceedByDaily === 1 && d2.normalToExceedBySchedule === 0, 'B4: デイリー更新による正常→超過は別枠で追跡');
}

// ---------------------------------------------------------------- ケースC: バージョン
{
  const file = path.join(root, 'c.json');
  const v3a = runCase(root, 'c1', { historyFile: file, marks: { 'TID-FICTION-C': [M, M, M, M, M, N, N, N] } });
  assert(v3a.logicVersion === 'rolling60h-predict-4' && v3a.historyRuns === 1, 'C1: 初回predict-3は履歴1件');
  // 旧版(predict-2)の実行を末尾に追加。同じ人・同じ窓で「超過」と「空白=0h」の旧表現を入れておく
  const store = readHistory(file);
  const key = store.runs[0].predictions[0];
  const legacy = {
    fingerprint: 'legacy-fp', logicId: 'legacy', logicVersion: 'rolling60h-predict-2', referenceDate: '2026-10-17',
    predictedAt: '2026-10-17T00:00:00.000Z', sources: {},
    predictions: [{
      subjectId: key.subjectId, start: key.start, end: key.end, predictedTotal: 80, level: 'exceed', future: true,
      days: key.days.map(function (d) { return { date: d.date, hours: 11, origin: 'roster-plan', future: true }; }),
    }],
  };
  store.runs.push(legacy);
  fs.writeFileSync(file, JSON.stringify(store));
  const before = JSON.stringify(readHistory(file).runs[1]);
  const v3b = runCase(root, 'c2', { historyFile: file, marks: { 'TID-FICTION-C': [M, M, M, M, M, M, M, N] } });
  assert(v3b.blankFilledWindows === 1, 'C2: 末尾が旧版でも、同じ版(predict-3)の直近履歴と比較する');
  assert(v3b.stillAlert === 0 && v3b.resolvedBySchedule + v3b.resolvedByDaily + v3b.resolvedByBoth + v3b.resolvedCauseUnknown === 0, 'C2: 旧版の超過記録とは照合しない');
  const after = readHistory(file);
  assert(after.runs.length === 3 && JSON.stringify(after.runs[1]) === before, 'C2: 旧版の履歴は保持され、新版が追記される');
  assert(after.runs.filter(function (r) { return r.logicVersion === 'rolling60h-predict-4'; }).length === 2, 'C2: predict-3は2件');
  // 旧版しか無い履歴 → 初回predict-3は比較なし
  const only = path.join(root, 'c-legacy.json');
  fs.writeFileSync(only, JSON.stringify({ version: 1, runs: [legacy], dailyArchive: {} }));
  const firstV3 = runCase(root, 'c3', { historyFile: only, marks: { 'TID-FICTION-C': [M, M, M, M, M, M, M, N] } });
  assert(firstV3.historyRuns === 2 && firstV3.blankFilledWindows === 0 && firstV3.normalToExceedWindows === 0, 'C3: 旧版のみの履歴では初回predict-3は比較対象なし');
  assert(firstV3.stillAlert === 0 && firstV3.verifyUndetermined === 0, 'C3: 旧版のアラートを引き継がない');
  assert(readHistory(only).runs[0].fingerprint === 'legacy-fp', 'C3: 旧版は削除されない');
  assert(History.RULE_VERSION === 'rolling60h-predict-4', 'C: 版定数');
}

// ---------------------------------------------------------------- ケースD: 境界値と不明値
{
  const file = path.join(root, 'd.json');
  const s = runCase(root, 'd1', {
    historyFile: file,
    marks: {
      'TID-FICTION-EXACT60': [M, M, M, M, H, H, R, N],
      'TID-FICTION-OVER61': [M, M, M, M, M, 'C1', R, N],
      'TID-FICTION-BLANK': [M, M, M, M, M, N, N, N],
      'TID-FICTION-FORMULA': [M, M, M, M, M, N, N, N],
      'TID-FICTION-REST': [R, R, R, R, R, R, R, N],
      'TID-FICTION-KNOWN': [M, M, M, M, M, M, N, N],
      'TID-FICTION-UNKNOWNSYM': [M, M, M, M, 'C2', R, R, N],
    },
    formulaEmpty: ['I6', 'J6'],
  });
  assert(s.approachCount === 1, 'D: ちょうど60hは接近');
  assert(s.exceedCount === 1, 'D: 61.5hは超過');
  assert(s.clearCount === 2, 'D: 休だけの週とFILLは正常(休は確定0h)');
  assert(s.partialCount === 1 && s.partialKnownOverCount === 1, 'D: 確定66h+空白は部分欠損の危険内訳');
  assert(s.undeterminedCount === 3, 'D: 空白・数式空文字(確定55h)と未定義記号は完全判定不能');
  assert(exclusive(s) && s.driverCount === 8, 'D: 5分類は排他で母数は8');
  assert(s.blankUnconfirmedPersonDays === 5, 'D: 未確定の空白は 本当の空白2+数式空文字2+KNOWN1=5人日。全員空白の期間外列は含めない');
  assert(s.outsidePeriodDateCount === 1, 'D: 全員空白の列(10-25)は期間外候補');
  assert(s.outsidePeriodKeptByDailyDays === 0, 'D: 過去デイリーが無ければ0');
  // 数式空文字と本当の空白は同じ結果（同じ分類・同じ内訳）
  const store = readHistory(file);
  const originOf = function (suffix) {
    return store.runs[0].predictions.filter(function (p) { return p.subjectId === 'TID-FICTION-' + suffix; })
      .map(function (p) { return p.level + ':' + p.predictedTotal + ':' + p.days.map(function (d) { return d.origin; }).join(','); }).join('|');
  };
  assert(originOf('BLANK') === originOf('FORMULA') && originOf('BLANK').indexOf('roster-unconfirmed') !== -1, 'D: 数式の空文字は本当の空白と同じ未確定');
  assert(originOf('REST').indexOf('roster-unconfirmed') === -1 && originOf('REST').indexOf('roster-plan') !== -1, 'D: 休は未確定ではなく確定の予定');
  // 不明記号は0hにしない
  const sym = store.runs[0].predictions.filter(function (p) { return p.subjectId === 'TID-FICTION-UNKNOWNSYM'; })[0];
  assert(sym.level === 'undetermined' && sym.days.some(function (d) { return d.origin === 'undefined' && d.hours === null; }), 'D: 不明記号は0hではなく未定義(hours=null)');
}
{
  // コア層: 閾値と7日連続窓
  const block = function (code, hours) { return [{ code: code, rawCode: code, source: 'roster', hours: hours, defined: true }]; };
  const mk = function (hoursList) {
    const byDate = {};
    hoursList.forEach(function (h, i) { byDate[Rolling.addDays('2026-10-01', i)] = block('X', h); });
    return Rolling.buildContinuousDailySeries(byDate, '2026-10-01', Rolling.addDays('2026-10-01', hoursList.length - 1));
  };
  const exact = Rolling.computeRolling60h(mk([10, 10, 10, 10, 10, 10, 0]), { limitHours: 60, warningHours: 60 })[0];
  const over = Rolling.computeRolling60h(mk([10, 10, 10, 10, 10, 10, 0.5]), { limitHours: 60, warningHours: 60 })[0];
  assert(exact.judgment === 'approach' && exact.over === false && over.judgment === 'exceed', 'D: 60.0h=接近、60.5h=超過');
  const win = Rolling.computeRolling60h(mk([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), { limitHours: 60 });
  assert(win.length === 4 && win.every(function (w) { return w.availableDays === 7; }), 'D: 10日なら7日窓は4つ（窓は短縮しない）');
  // 期間外の日付(レコード無し)を含む窓は短縮せず判定不能
  const gap = mk([1, 1, 1, 1, 1, 1, 1, 1]);
  gap[3] = Rolling.buildDayRecord(gap[3].date, []); gap[3].noData = true;
  const gapRes = Rolling.computeRolling60h(gap, { limitHours: 60 });
  assert(gapRes.every(function (w) { return w.judgment === 'undetermined' && w.complete === false; }), 'D: 期間外(データ無し)日を含む窓は7日のまま判定不能');
}

// ---------------------------------------------------------------- 集計単位: 人数 vs 窓
{
  const file = path.join(root, 'u.json');
  const dates = datesFrom('2026-10-18', 9); // 10-18..10-26
  // 超過窓(確定)と、確定66h超の未確定窓を同時に持つ人
  const s = runCase(root, 'u1', {
    historyFile: file, dates: dates, outsideColumns: [],
    marks: {
      'TID-FICTION-BOTH': [M, M, M, M, M, M, M, M, N],
      'TID-FICTION-KNOWNONLY': [M, M, M, M, M, M, N, N, N],
      'TID-FICTION-APPR': [M, M, M, M, H, H, R, N, N],
    },
  });
  assert(s.partialCount === 3 && s.clearCount === 1 && s.driverCount === 4, 'U: 部分欠損は人数で3（BOTH・KNOWNONLY・APPR）、FILLは正常');
  assert(s.partialExceedCount === 1 && s.partialApproachCount === 1, 'U: partialExceed=確定超過窓を持つ部分欠損者(BOTH)、partialApproach=60hちょうどの窓を持つ者(APPR)');
  assert(s.partialKnownOverCount === 2, 'U: partialKnownOver=確定分だけで60h超の未確定窓を持つ部分欠損者。BOTHと、確定超過窓を持たないKNOWNONLYの2人で、partialExceed(1)とは別の視点');
  assert(s.partialKnownOverCount <= s.partialCount && s.partialExceedCount + s.partialApproachCount <= s.partialCount, 'U: どちらも部分欠損の内数');
  assert(s.knownOverWindows >= s.partialKnownOverCount, 'U: knownOverWindows は窓単位、partialKnownOverCount は人数単位');
  assert(exclusive(s), 'U: 第6分類は存在せず、5分類の合計=driverCount');
  assert(s.confirmedActual === false && s.sent === false && s.channel === 'dry-run', 'U: confirmedActual=false・dry-runを維持');
}

// ---------------------------------------------------------------- 安全性
{
  const sources = ['harvest-rolling60h-run.js', 'harvest-rolling60h-history.js', 'inoichi-rolling-dryrun.js', 'rolling60h-core.js'].map(function (f) {
    return fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  }).join('\n');
  assert(sources.indexOf('wh60SendAlerts') === -1 && sources.indexOf('fetch(') === -1 && sources.indexOf('api.line.me') === -1, 'LINE送信・外部通信のコードを持たない');
  const real = path.join(process.cwd(), 'local', 'rolling60h-history.json');
  const touchedReal = fs.existsSync(real) && fs.statSync(real).mtimeMs > Date.now() - 60000;
  assert(!touchedReal, '実履歴JSONを変更していない');
}

console.log('rolling60h-history-compare.test.mjs: ALL TESTS PASSED');
