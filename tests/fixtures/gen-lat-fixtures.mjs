/**
 * LAT検証用 DSP(CSV) + LAT(xlsx) フィクスチャ生成
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const outDir = path.resolve(import.meta.dirname, 'lat-verify');
fs.mkdirSync(outDir, { recursive: true });

const dspRows = [
  ['route_id', 'employee_id', 'date', 'planned_arrival', 'planned_departure', 'route_actual_departure', 'beacon_entrance', 'diff_plan_vs_actual_mins'],
  ['R001', 'T001', '2026/07/26', '08:30', '09:00', '08:55', '08:22', '-'],
  ['R002', 'T002', '2026/07/26', '08:45', '09:15', '09:14', '08:40', '-'],
  ['R003', 'T003', '2026/07/26', '09:00', '09:30', '09:38', '08:55', 'N/A'],
  ['R004', 'T004', '2026/07/26', '09:15', '09:45', '09:38', '09:08', '-7'],
  ['R005', 'T005', '2026/07/26', '10:00', '10:30', '10:45', '09:55', '15'],
];

const latRows = [
  ['route_id', 'employee_id', 'date', 'beacon_arrival', 'beacon_entrance', 'beacon_firstpackagescan', 'beacon_lastpackagescan', 'beacon_departure', 'beacon_exit'],
  ['R001', 'T001', '2026/07/26', '08:20', '08:22', '08:35', '08:48', '08:55', '08:58'],
  ['R002', 'T002', '2026/07/26', '08:38', '08:40', '08:50', '09:02', '09:14', '09:18'],
  ['R003', 'T003', '2026/07/26', '08:52', '08:55', '09:05', '09:18', '09:38', '09:42'],
  ['R004', 'T004', '2026/07/26', '09:05', '09:08', '09:20', '09:35', '09:38', '09:42'],
  ['R005', 'T005', '2026/07/26', '09:52', '09:55', '10:05', '10:20', '10:45', '10:50'],
];

const dspCsv = dspRows.map((r) => r.join(',')).join('\n');
const dspPath = path.join(outDir, 'dsp-lat-verify.csv');
fs.writeFileSync(dspPath, '\uFEFF' + dspCsv, 'utf8');

const latWb = XLSX.utils.book_new();
const latWs = XLSX.utils.aoa_to_sheet(latRows);
XLSX.utils.book_append_sheet(latWb, latWs, 'LAT');
const latPath = path.join(outDir, 'lat-lat-verify.xlsx');
XLSX.writeFile(latWb, latPath);

console.log('Generated:', dspPath);
console.log('Generated:', latPath);
