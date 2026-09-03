import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const MAB = require('../manual-assign-board-core.js');
const AssignSupportCore = require('../assign-support-core.js');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

function runTests() {
  // ---- classifyCycle ----
  assert(MAB.classifyCycle('DCX3') === 'C1', 'DCX -> C1');
  assert(MAB.classifyCycle('DMX7') === 'C2', 'DMX -> C2');
  assert(MAB.classifyCycle('DSX22') === 'C3', 'DSX -> C3');
  assert(MAB.classifyCycle('DSMRA1') === '', 'unknown prefix -> unclassified, not an error');

  // ---- naturalRouteCompare / sort ----
  var codes = ['DSX2', 'DSX10', 'DSX1', 'DSX11', 'DSX3'];
  codes.sort(MAB.naturalRouteCompare);
  assert(codes.join(',') === 'DSX1,DSX2,DSX3,DSX10,DSX11', 'natural sort DSX1..DSX11, got ' + codes.join(','));

  // ---- buildBoardRoutesFromManifestRoutes: takes the EXISTING
  // assign-support-core.js#parseManifestWorkbook() output shape directly
  // (routeCode/packages/stops/areas/daNumbers) — no independent re-parsing.
  var fakeManifestRoutes = [
    { routeCode: 'DCX1', packages: 5, stops: 5, areas: [], daNumbers: ['DA1000000', 'DA1000001', 'DA1000002', 'DA1000003', 'DA1000004'] },
    { routeCode: 'DMX3', packages: 7, stops: 7, areas: [], daNumbers: ['DA2000000', 'DA2000001', 'DA2000002', 'DA2000003', 'DA2000004', 'DA2000005', 'DA2000006'] },
    { routeCode: 'DSX2', packages: 4, stops: 4, areas: [], daNumbers: ['DA3000000', 'DA3000001', 'DA3000002', 'DA3000003'] },
    { routeCode: 'DSX10', packages: 2, stops: 2, areas: [], daNumbers: ['DA4000000', 'DA4000001'] },
    { routeCode: 'ZZZ1', packages: 1, stops: 1, areas: [], daNumbers: ['DA5000000'] } // unknown prefix, must still work
  ];
  var boardRoutes = MAB.buildBoardRoutesFromManifestRoutes(fakeManifestRoutes);
  var routeCodes = boardRoutes.map(function (r) { return r.routeCode; });
  assert(routeCodes.join(',') === 'DCX1,DMX3,DSX2,DSX10,ZZZ1', 'routes sorted naturally across mixed prefixes: ' + routeCodes.join(','));

  var byCode = {};
  boardRoutes.forEach(function (r) { byCode[r.routeCode] = r; });
  assert(byCode.DCX1.cycle === 'C1', 'DCX1 cycle C1');
  assert(byCode.DMX3.cycle === 'C2', 'DMX3 cycle C2');
  assert(byCode.DSX2.cycle === 'C3', 'DSX2 cycle C3');
  assert(byCode.ZZZ1.cycle === '', 'ZZZ1 (unknown prefix) unclassified, not erroring');
  assert(byCode.DCX1.count === 5, 'DCX1 count 5 (matches daNumbers.length)');
  assert(byCode.DMX3.count === 7, 'DMX3 count 7');
  assert(byCode.DSX10.count === 2, 'DSX10 count 2');
  assert(byCode.DCX1.daNumbers.every(function (d) { return d.indexOf('DA1') === 0; }), 'DCX1 only has its own DA numbers (no cross-route mixing)');

  // route with no routeCode must not appear (defensive)
  var withJunk = MAB.buildBoardRoutesFromManifestRoutes(fakeManifestRoutes.concat([{ routeCode: '', packages: 0, daNumbers: [] }, null]));
  assert(withJunk.length === boardRoutes.length, 'entries without routeCode are dropped, not crashing');

  // ---- groupRoutesByCycle: C1/C2/C3 first, then unknown prefixes ----
  var groups = MAB.groupRoutesByCycle(boardRoutes);
  var groupKeys = groups.map(function (g) { return g.key; });
  assert(groupKeys.join(',') === 'C1,C2,C3,ZZZ', 'group order C1,C2,C3,ZZZ got ' + groupKeys.join(','));
  assert(groups[2].routes.length === 2, 'C3 group has DSX2+DSX10 = 2 routes');

  // ---- formatDaListForClipboard ----
  var clip = MAB.formatDaListForClipboard(['DA1', 'DA2', 'DA3']);
  assert(clip === 'DA1\nDA2\nDA3', 'newline-joined clipboard text, got ' + JSON.stringify(clip));
  assert(clip.split('\n').length === 3, 'split by newline reproduces original count');
  assert(MAB.formatDaListForClipboard([]) === '', 'empty list -> empty string');
  assert(MAB.formatDaListForClipboard(undefined) === '', 'undefined -> empty string, no crash');

  // ---- Integration: real assign-support-core.js#parseManifestWorkbook()
  // shape sanity-checked directly (no XLSX/browser needed) — confirms the
  // daNumbers field this module depends on exists and packages===daNumbers.length.
  assert(typeof AssignSupportCore.parseManifestWorkbook === 'function', 'AssignSupportCore.parseManifestWorkbook exists (reused, not reimplemented)');
  var fakeWorkbook = {
    SheetNames: ['sequencedRoute_DSX5'],
    Sheets: {
      'sequencedRoute_DSX5': 'STUB' // XLSX.utils.sheet_to_json is stubbed below to ignore the sheet value
    }
  };
  var originalXLSX = global.XLSX;
  global.XLSX = {
    utils: {
      sheet_to_json: function () {
        return [
          ['Route for DSX5   ', '', '', '', '', '', '', '', '', '', '', '', '', ''],
          ['Stop', 'Tracking ID', 'Time (min)', 'Arrival', 'Time Window', 'Address', 'Postal', 'Signature', 'Customer Notes', '', '', '', '', ''],
          ['', '', '', '', '', 'OFK3', '', '', '', '', '', '', '', ''],
          ['1', 'DA0000000001', '5', '9:00', '9:00-13:00', 'アドレスA', '819-0000', '', '', '', '', '', '', ''],
          ['2', 'DA0000000002', '5', '9:05', '9:00-13:00', 'アドレスB', '819-0000', '', '', '', '', '', '', ''],
          ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
          ['', '', '', '', '', '', '', '', '', '', '', '', '', '']
        ];
      }
    }
  };
  try {
    var realParsed = AssignSupportCore.parseManifestWorkbook(fakeWorkbook);
    assert(realParsed.length === 1, 'parseManifestWorkbook returns 1 route');
    assert(realParsed[0].daNumbers.join(',') === 'DA0000000001,DA0000000002', 'daNumbers additive field present and correct: ' + JSON.stringify(realParsed[0].daNumbers));
    assert(realParsed[0].packages === realParsed[0].daNumbers.length, 'packages count still matches daNumbers.length (existing field unaffected)');

    var boardFromReal = MAB.buildBoardRoutesFromManifestRoutes(realParsed);
    assert(boardFromReal[0].routeCode === 'DSX5', 'board route built from real parseManifestWorkbook output');
    assert(boardFromReal[0].count === 2, 'board route count matches');
    assert(boardFromReal[0].cycle === 'C3', 'board route cycle classified from reused parser output');
  } finally {
    global.XLSX = originalXLSX;
  }

  console.log('manual-assign-board-core.test.mjs: all tests passed');
}

runTests();
