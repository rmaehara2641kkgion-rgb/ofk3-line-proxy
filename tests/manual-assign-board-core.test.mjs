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

// Mirrors the real 点呼表 (roll-call) sheet layout confirmed against real data:
// row0 = title with the date, row1 = header (name/course/Roman/TransportID for
// the 乗務前 block, then a duplicate 名前/Roman/TransportID block for 乗務後
// further right), row2 = sub-header junk ("character"/"Route" labels),
// data rows follow, with trailing dummy rows carrying TransportID literal "0".
function buildTenkoRosterRows(dateLabel, people) {
  var rows = [];
  rows.push([dateLabel, '', '', '', '', '', '', '', '', '', '', '', '', '']);
  rows.push(['', '', 'Affiliation', '名前　/　車両番号', '勤務コース', '着車\r\n時間', 'Roman', 'Transport ID', 'C2', '出庫\r\n時間',
    '', '名前　/　車両番号', 'Roman', 'Transport ID', 'Phone']);
  rows.push(['', '', '', '', '', '', ' character', '', 'Route', '', '', '', ' character', '', '']);
  for (var i = 0; i < people.length; i++) {
    var p = people[i];
    rows.push([String(i + 1), p.name, 'GDS', p.name, p.shiftCode, '9:00', p.amazonName, p.tid, '', '9:10',
      '', p.name, p.amazonName, p.tid, '']);
  }
  // trailing dummy rows seen in the real file
  rows.push(['', '', '', '', '', '', '', '0', '', '', '', '', '', '', '']);
  rows.push(['', '', '', '', '', '', '', '0', '', '', '', '', '', '', '']);
  return rows;
}

function runAmazonNameTests() {
  // ---- isTenkoRosterSheetName ----
  assert(MAB.isTenkoRosterSheetName('点呼表') === true, '点呼表 sheet recognized');
  assert(MAB.isTenkoRosterSheetName('点呼表_9-3') === true, 'date-suffixed variant recognized (prefix match)');
  assert(MAB.isTenkoRosterSheetName('メイン') === false, 'unrelated sheet name not recognized');

  // ---- extractShiftDateLabel ----
  var withDate = buildTenkoRosterRows('2026/9/3', []);
  assert(MAB.extractShiftDateLabel(withDate) === '2026-09-03', 'date parsed from title cell, got ' + MAB.extractShiftDateLabel(withDate));
  assert(MAB.extractShiftDateLabel([['no date here']]) === '', 'no date -> empty string, not a guess');

  // ---- parseTenkoRosterRows: mirrors real structure, including the
  // duplicate Roman/TransportID header block for 乗務後 (after-duty), which
  // must NOT be picked over the first (乗務前) one; blank shiftCode (day off)
  // and TID literal "0" junk rows must be excluded.
  var people = [
    { name: '持田 裕司', shiftCode: 'bike', amazonName: '裕司 持田', tid: 'ARBVAARDVO3D7' },
    { name: '矢野　勝幸', shiftCode: '○', amazonName: '勝幸 矢野', tid: 'A1GKOXURY2BDIZ' },
    { name: '休み太郎', shiftCode: '', amazonName: '太郎 休み', tid: 'ARESTDAY0000001' }, // 休み: shiftCode blank -> excluded
    { name: '未解決花子', shiftCode: '❽', amazonName: '', tid: 'AUNRESOLVED0001' } // Amazon Name未登録
  ];
  var rows = buildTenkoRosterRows('2026/9/3', people);
  var parsed = MAB.parseTenkoRosterRows(rows);
  assert(parsed.count === 3, 'roster excludes the blank-shiftCode (day off) row, got ' + parsed.count);
  var byTid = {};
  parsed.entries.forEach(function (e) { byTid[e.transportId] = e; });
  assert(byTid['ARBVAARDVO3D7'].amazonName === '裕司 持田', 'Amazon Name matches real user example format (given-family order)');
  assert(byTid['A1GKOXURY2BDIZ'].amazonName === '勝幸 矢野', 'no row-shift from the duplicate 乗務後 Roman/TID block');
  assert(byTid['ARESTDAY0000001'] === undefined, '休み (blank shiftCode) row excluded entirely');
  assert(byTid['AUNRESOLVED0001'].amazonName === '', 'missing Amazon Name kept as empty string, not guessed');
  assert(byTid['AUNRESOLVED0001'].shiftCode === '❽', 'shiftCode still captured for the unresolved-name row');

  // duplicate TransportID within the sheet
  var dupPeople = people.slice(0, 2).concat([{ name: '別名だが同一TID', shiftCode: 'bike', amazonName: 'X Y', tid: 'ARBVAARDVO3D7' }]);
  var dupParsed = MAB.parseTenkoRosterRows(buildTenkoRosterRows('2026/9/3', dupPeople));
  assert(dupParsed.count === 2, 'duplicate TransportID collapsed to first occurrence, got ' + dupParsed.count);
  assert(dupParsed.duplicateCount === 1, 'duplicateCount reports 1');

  // missing required columns -> explicit error, not a silent empty success
  var noCols = MAB.parseTenkoRosterRows([['foo', 'bar']]);
  assert(noCols.error === 'columns_not_found', 'missing Roman/TransportID/勤務コース columns reported as error');

  // ---- parseTenkoRosterWorkbook: multiple 点呼表-named sheets, unrelated sheets ignored ----
  var fakeWb = {
    SheetNames: ['点呼表', 'メイン', '点呼表_9-4'],
    Sheets: {
      '点呼表': buildTenkoRosterRows('2026/9/3', people.slice(0, 2)),
      'メイン': [['unrelated', 'sheet']],
      '点呼表_9-4': buildTenkoRosterRows('2026/9/4', people.slice(0, 1))
    }
  };
  var fakeXLSXForRoster = { utils: { sheet_to_json: function (sheet) { return sheet; } } };
  var tenkoSheets = MAB.parseTenkoRosterWorkbook(fakeWb, fakeXLSXForRoster);
  assert(tenkoSheets.length === 2, 'only 点呼表-named sheets picked up, メイン ignored, got ' + tenkoSheets.length);
  assert(tenkoSheets.some(function (s) { return s.dateLabel === '2026-09-03' && s.count === 2; }), '2026-09-03 sheet has 2 entries');
  assert(tenkoSheets.some(function (s) { return s.dateLabel === '2026-09-04' && s.count === 1; }), '2026-09-04 sheet has 1 entry (separate date, not merged)');

  // ---- buildAmazonNameRosterForCycle: reuses the EXISTING
  // assign-support-core.js shift-token -> Cycle eligibility definitions
  // (CYCLE_SHIFT_ELIGIBILITY), no new mapping table defined here.
  var cycleEntries = [
    { transportId: 'T1', name: 'A', amazonName: 'Amazon A', shiftCode: 'bike' }, // C1+C2
    { transportId: 'T2', name: 'B', amazonName: 'Amazon B', shiftCode: '〇' }, // ○(maru) -> C1+C3
    { transportId: 'T3', name: 'C', amazonName: 'Amazon C', shiftCode: '❽' }, // ❽(hachi) -> C2 only
    { transportId: 'T4', name: 'D', amazonName: 'Amazon D', shiftCode: 'C3' }, // c3 -> C3 only
    { transportId: 'T5', name: 'E', amazonName: '', shiftCode: '〇' } // unresolved name, still C1+C3 eligible
  ];
  var c1 = MAB.buildAmazonNameRosterForCycle(cycleEntries, 'C1', AssignSupportCore.filterWorkersByCycleEligibility);
  assert(c1.cycleClassified === true, 'C1 classified');
  var c1Ids = c1.roster.map(function (r) { return r.transportId; }).sort();
  assert(c1Ids.join(',') === 'T1,T2,T5', 'C1 eligible = bike + maru tokens (existing CYCLE_SHIFT_ELIGIBILITY), got ' + c1Ids.join(','));
  var t5 = c1.roster.find(function (r) { return r.transportId === 'T5'; });
  assert(t5.resolved === false && t5.amazonName === '', 'unresolved Amazon Name surfaced, not silently dropped');

  var c2 = MAB.buildAmazonNameRosterForCycle(cycleEntries, 'C2', AssignSupportCore.filterWorkersByCycleEligibility);
  assert(c2.roster.map(function (r) { return r.transportId; }).sort().join(',') === 'T1,T3', 'C2 eligible = bike + hachi, got ' + c2.roster.map(function (r) { return r.transportId; }).join(','));

  var c3 = MAB.buildAmazonNameRosterForCycle(cycleEntries, 'C3', AssignSupportCore.filterWorkersByCycleEligibility);
  assert(c3.roster.map(function (r) { return r.transportId; }).sort().join(',') === 'T2,T4,T5', 'C3 eligible = maru + c3, got ' + c3.roster.map(function (r) { return r.transportId; }).join(','));

  // unknown-prefix Route group (e.g. DSMRA) must NOT be forced into a Cycle
  var unclassified = MAB.buildAmazonNameRosterForCycle(cycleEntries, 'DSMRA', AssignSupportCore.filterWorkersByCycleEligibility);
  assert(unclassified.cycleClassified === false, 'unknown prefix group is not force-classified into C1/C2/C3');
  assert(unclassified.roster.length === 0, 'no roster guessed for an unclassified Route group');

  // sort order: by Amazon Name (ja locale)
  var sortedNames = c1.roster.map(function (r) { return r.amazonName || r.name; });
  var expectedSorted = sortedNames.slice().sort(function (a, b) { return a.localeCompare(b, 'ja'); });
  assert(sortedNames.join(',') === expectedSorted.join(','), 'roster sorted by Amazon Name');

  // ---- Integration: real assign-support-core.js#filterWorkersByCycleEligibility
  // is genuinely being called (not reimplemented) — stats field passthrough proves it.
  assert(c1.stats && c1.stats.eligibleCount === 3, 'stats passed through from the real reused eligibility function');

  console.log('manual-assign-board-core.test.mjs: Amazon Name (right pane) tests passed');
}

runTests();
runAmazonNameTests();
