// 架空データのみ。ローリングアラートの各テストで共有する。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const RC = require('../../rolling60h-core.js');

export const TARGET = '2026-10-21'; // 過去6日 = 10-15..10-20
export const PAST = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'];
export const NOW = Date.parse('2026-10-21T12:00:00Z'); // 検証用の固定時刻

/**
 * 実アプリと同じ経路（実績＋予定の合成 → 連続系列）で架空ドライバーの日次系列を作る。
 * pastActual: 過去6日の実績時間（null は実績なし） / pastRoster: 実績が無い日の予定記号
 * today: 当日の予定記号（undefined = データなし、'' = 空白セル）
 */
export function makeDriver(key, { pastActual = [], pastRoster = {}, today, name }) {
  const actualRecords = [];
  PAST.forEach((date, i) => {
    if (pastActual[i] !== undefined && pastActual[i] !== null) actualRecords.push({ transportId: key, date, hours: pastActual[i], hoursOk: true });
  });
  const actual = RC.groupActualRecordsByTransportId(actualRecords)[key] || {};
  const roster = {};
  Object.keys(pastRoster).forEach((d) => { roster[d] = RC.parseShiftCellToBlocks(pastRoster[d], 'roster').blocks; });
  if (today !== undefined) roster[TARGET] = RC.parseShiftCellToBlocks(today, 'roster').blocks;
  const dates = Object.keys(roster).concat(Object.keys(actual)).concat([PAST[0], TARGET]).sort();
  const blended = RC.mergeActualAndRoster(actual, roster, TARGET);
  const series = RC.buildContinuousDailySeries(blended, dates[0], dates[dates.length - 1]);
  return { key, meta: { name: name || 'テスト' + key, transportId: key, company: 'DSP' }, series };
}

export const fleet = () => [
  makeDriver('A1', { pastActual: [11, 11, 11, 11, 11, 11], today: '休' }),
  makeDriver('A2', { pastActual: [9, 9, 9, 9, 9, 9], today: '○' }),
  makeDriver('B1', { pastActual: [8.5, 8.5, 8.5, 8.5, 8.5, 8.5], today: '❽' }),
  makeDriver('E1', { pastActual: [8.5, 8.5, 8.5, 8.5, 8.5, 8.5], today: '' }),
  makeDriver('D1', { pastActual: [8.5, 8.5, 8.5, 8.5, 8.5, 8.5], today: '休' }),
  makeDriver('F1', { pastActual: [8, 8, 8, 8, 8, null], today: '○' }),
  makeDriver('N1', { pastActual: [5, 5, 5, 5, 5, 5], today: '❽' }),
];

/**
 * 照合用シナリオ（rolling-alert-v1 の期待区分）。HARVEST 側エンジンとの差分確認に使う。
 * past: 過去6日の実績時間 / today: 当日の予定記号（'' = 空白, undefined = データなし）
 */
export const SCENARIOS = [
  { id: 'confirmed', past: [11, 11, 11, 11, 11, 11], today: '休', expect: 'exceed_confirmed' },
  { id: 'forecast', past: [9, 9, 9, 9, 9, 9], today: '○', expect: 'exceed_forecast' },
  { id: 'approach', past: [8.5, 8.5, 8.5, 8.5, 8.5, 8.5], today: '❽', expect: 'approach' },
  { id: 'approach-lower-bound-49', past: [8, 8, 8, 8, 8, 9], today: 'b1', expect: 'approach' },
  { id: 'below-band-48.5', past: [8, 8, 8, 8, 8, 8.5], today: 'b1', expect: 'normal' },
  { id: 'total-exactly-60', past: [8, 8, 8, 8, 8, 9], today: '○', expect: 'approach' },
  { id: 'past6-exactly-60-today-off', past: [10, 10, 10, 10, 10, 10], today: '休', expect: 'day_off' },
  { id: 'past6-exactly-60-today-work', past: [10, 10, 10, 10, 10, 10], today: 'b1', expect: 'exceed_forecast' },
  { id: 'today-off', past: [8.5, 8.5, 8.5, 8.5, 8.5, 8.5], today: '休', expect: 'day_off' },
  { id: 'today-blank', past: [8.5, 8.5, 8.5, 8.5, 8.5, 8.5], today: '', expect: 'schedule_unconfirmed' },
  { id: 'today-no-data', past: [8.5, 8.5, 8.5, 8.5, 8.5, 8.5], today: undefined, expect: 'schedule_unconfirmed' },
  { id: 'past-day-missing', past: [8, 8, 8, 8, 8, null], today: '○', expect: 'undetermined' },
];
