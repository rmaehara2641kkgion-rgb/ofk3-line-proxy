#!/usr/bin/env node
/**
 * ローリングアラート判定の照合レポート（読み取り専用・架空データ）。
 *   node scripts/rolling-alert-scenarios-report.mjs
 *       … rolling-alert-v1 の区分を一覧表示する
 *   node scripts/rolling-alert-scenarios-report.mjs --engine <path> [--fn evaluate]
 *       … 別エンジン（例: HARVEST prefix6-margin11）を差し込んで区分を突き合わせる。
 *         関数は { id, pastHours:[6件|null], todaySymbol, todayHours|null } を受け取り、
 *         区分名（exceed_confirmed / exceed_forecast / approach / schedule_unconfirmed /
 *         undetermined / day_off / normal のいずれか）の文字列を返すこと。
 *         区分名が違う場合は、呼び出し側で上記7区分へ対応付けるアダプタを噛ませる。
 * 他エンジンが未入手の間は「一致」と判断しない。差分は DIFF、関数が無い/例外は ERROR と表示する。
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const AC = require('../rolling-alert-core.js');
const { TARGET, makeDriver, SCENARIOS } = await import('../tests/fixtures/rolling-alert-fixtures.mjs');

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
let external = null;
if (opt('--engine')) {
  const mod = require(path.resolve(opt('--engine')));
  external = mod[opt('--fn') || 'evaluate'];
  if (typeof external !== 'function') { console.error('engine function not found'); process.exit(2); }
}
const HOURS = { '○': 11, '❽': 8, b1: 5, '休': 0 };

let diffs = 0;
console.log('| シナリオ | rolling-alert-v1 | ' + (external ? '外部エンジン | 判定 |' : '') );
console.log('|---|---|' + (external ? '---|---|' : ''));
SCENARIOS.forEach((sc) => {
  const mine = AC.evaluateDriver(makeDriver('X', { pastActual: sc.past, today: sc.today }), { targetDate: TARGET }).alertClass;
  let line = '| ' + sc.id + ' | ' + mine + ' |';
  if (external) {
    let other, verdict;
    try {
      other = external({ id: sc.id, pastHours: sc.past, todaySymbol: sc.today, todayHours: sc.today === undefined || sc.today === '' ? null : HOURS[sc.today] });
      verdict = other === mine ? 'SAME' : 'DIFF';
    } catch (e) { other = String(e.message); verdict = 'ERROR'; }
    if (verdict !== 'SAME') diffs++;
    line += ' ' + other + ' | ' + verdict + ' |';
  }
  console.log(line);
});
if (external) { console.log('\n差分/エラー: ' + diffs + ' 件'); process.exit(diffs ? 1 : 0); }
