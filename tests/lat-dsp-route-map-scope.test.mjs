import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const LDC = require('../lat-departure-core.js');
const __dirname = dirname(fileURLToPath(import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseCsvRows(text) {
  return text
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
    .map(function (line) {
      return line.split(',');
    });
}

function runTests() {
  // Scope bug regression: reassignment breaks lexical alias used by mergeAndRender
  var host = { dspRouteMap: {} };
  var lexical = host.dspRouteMap;
  host.dspRouteMap = { R001: { plannedDeparture: '09:00' } };
  assert(Object.keys(lexical).length === 0, 'reassign breaks lexical alias');

  LDC.latAssignDspRouteMap(host, { R001: { plannedDeparture: '09:00' }, R002: { plannedDeparture: '09:15' } });
  assert(lexical === host.dspRouteMap, 'in-place assign keeps same object reference');
  assert(Object.keys(lexical).length === 2, 'lexical map populated via latAssignDspRouteMap');
  assert(lexical.R001.plannedDeparture === '09:00', 'route data readable from lexical alias');

  // Fixture parse + judgment chain
  var csv = readFileSync(join(__dirname, 'fixtures/lat-verify/dsp-lat-verify.csv'), 'utf8');
  var rows = parseCsvRows(csv);
  var parsed = LDC.parseLatDspRows(rows);
  assert(parsed.count === 5, 'fixture route count');
  assert(parsed.plannedDepartureCount === 5, 'fixture plannedDeparture count');
  assert(parsed.map.R001.plannedDeparture === '09:00', 'R001 plannedDeparture');
  assert(parsed.map.R001.actualDeparture === '08:55', 'R001 actualDeparture');

  var diff = LDC.latResolveDiffMin(parsed.map.R001.diffMins, parsed.map.R001.actualDeparture, parsed.map.R001.plannedDeparture);
  var judgment = LDC.latResolveJudgment(diff);
  assert(diff === -5, 'R001 diffMin from times');
  assert(judgment === '定刻', 'R001 judgment');

  diff = LDC.latResolveDiffMin(parsed.map.R005.diffMins, parsed.map.R005.actualDeparture, parsed.map.R005.plannedDeparture);
  judgment = LDC.latResolveJudgment(diff);
  assert(diff === 15, 'R005 diffMin prefers DSP column');
  assert(judgment === '遅延', 'R005 judgment');

  console.log('lat-dsp-route-map-scope.test.mjs: all tests passed');
}

runTests();
