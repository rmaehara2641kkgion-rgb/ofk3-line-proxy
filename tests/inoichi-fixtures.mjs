// INOICHI テスト用 fixture。実データ形状 (サーバー sanitize 済み) に基づく。
export const NOW = '2026-10-03T01:00:00.000Z';
export const LOCAL_DATE = '2026-10-03';

export function makePackages() {
  return [
    { routeCode: 'DCX47', routeId: 'R-47', stop: 3, driverName: 'DRIVER-A', trackingId: 'TBA000000001', plannedEndTime: 1759460400000, plannedEndClock: '11:00', windowLabel: '09:00-11:00', address: 'ADDR-1', latitude: 35.1, longitude: 139.1 },
    { routeCode: 'DCX47', routeId: 'R-47', stop: 4, driverName: 'DRIVER-A', trackingId: 'TBA000000002', plannedEndTime: 1759467600000, plannedEndClock: '13:00', windowLabel: '11:00-13:00', address: 'ADDR-2', latitude: null, longitude: null },
    { routeCode: 'DCX12', routeId: 'R-12', stop: 1, driverName: 'DRIVER-B', trackingId: 'TBA000000003', plannedEndTime: 1759471200000, plannedEndClock: '14:00', windowLabel: '12:00-14:00', address: 'ADDR-3', latitude: 35.2, longitude: 139.2 },
    { routeCode: 'DCX12', routeId: 'R-12', stop: null, driverName: 'DRIVER-B', trackingId: 'TBA000000004', plannedEndTime: null, plannedEndClock: '', windowLabel: '', address: '', latitude: null, longitude: null }
  ];
}

export function makeSequenceIndex() {
  return [
    { routeCode: 'DCX47', trackingId: 'TBA000000001', sequenceNumber: 7 },
    { routeCode: 'DCX47', trackingId: 'TBA000000002', sequenceNumber: 8 },
    { routeCode: 'DCX12', trackingId: 'TBA000000003', sequenceNumber: 2 },
    { routeCode: 'DCX12', trackingId: 'TBA000000005', sequenceNumber: 9 }
  ];
}

function bagRow(routeCode, trackingId, extra) {
  return Object.assign({
    routeCode: routeCode, trackingId: trackingId, referenceId: null, driverAid: null,
    bagName: null, bagScannableId: null, bagColorCode: null, bagColor: null,
    bagNumber: null, bagDisplay: null, bagStatus: null, bagSource: null
  }, extra || {});
}

export function makeAssistIndex() {
  return [
    bagRow('DCX47', 'TBA000000001', { referenceId: 'REF-1', driverAid: 'A1', bagName: 'BAG-X', bagScannableId: 'SC1', bagColorCode: 'C1', bagColor: 'red', bagNumber: '12', bagDisplay: 'BAG-X #12', bagStatus: 'captured', bagSource: 'trDetails' }),
    bagRow('DCX47', 'TBA000000002', { bagStatus: 'captured_null', bagSource: 'trDetails' }),
    bagRow('DCX12', 'TBA000000003', { bagStatus: 'not_attempted' }),
    bagRow('DCX12', 'TBA000000004', { bagStatus: 'timeout', bagSource: 'stop_dom' }),
    bagRow('DCX12', 'TBA000000099', { bagStatus: 'captured_null', bagSource: 'stop_dom' })
  ];
}

export function makeAssistDiagnostics() {
  return {
    trDetailsCaptured: 2, trDetailsMissing: 1, assistMatched: 4, assistUnmatched: 1,
    skippedMissingTrackingId: 0, skippedMissingReferenceId: 1, indexCount: 5,
    byRoute: { DCX47: { captured: 2, missing: 0 }, DCX12: { captured: 0, missing: 3 } }
  };
}

export function makeSequenceDiagnostics() {
  return {
    skippedMissingTrackingId: 0, skippedMissingSequence: 1, skippedEmptyTasks: 0,
    duplicateTrackingIdConflicts: [{ routeCode: 'DCX47', trackingId: 'TBA-DUP' }],
    indexCount: 4, byRoute: { DCX47: { indexed: 2 }, DCX12: { indexed: 2 } }
  };
}

export function makeEntry() {
  return { localDate: LOCAL_DATE, source: 'cortex-capture-extension', receivedAt: '2026-10-03T00:30:00.000Z', stopCount: 4, packageCount: 4 };
}

export function makeHandoff(source, overrides) {
  return Object.assign({
    source: source, collectedAt: '2026-10-03T00:40:00.000Z', status: 'ok', successCount: 4, failureCount: 0, errors: [],
    payloadReference: { via: 'window.OFK3Cortex13', getters: ['getEntry', 'getPackages'], localDate: LOCAL_DATE, note: 'ref only' },
    schemaVersion: '0.1', harvestConfirmed: true, confirmedAt: '2026-10-03T00:41:00.000Z'
  }, overrides || {});
}

export function makeHarvestState(id, overrides) {
  return Object.assign({
    id: id, label: id, status: 'ok', counts: { success: 4, failure: 0, total: 4 },
    checkedAt: '2026-10-03T00:40:00.000Z', errors: [], details: {}, summary: ''
  }, overrides || {});
}

export function makeInput(overrides) {
  return Object.assign({
    handoffRecords: { timeWindow: makeHandoff('timeWindow'), bag: makeHandoff('bag') },
    harvestStates: { timeWindow: makeHarvestState('timeWindow'), bag: makeHarvestState('bag') },
    entry: makeEntry(),
    packages: makePackages(),
    routeStops: [],
    packageSequenceIndex: makeSequenceIndex(),
    packageSequenceDiagnostics: makeSequenceDiagnostics(),
    packageAssistIndex: makeAssistIndex(),
    packageAssistDiagnostics: makeAssistDiagnostics(),
    sequenceRouteCount: 2,
    now: NOW
  }, overrides || {});
}

export function makeFakeApi(input) {
  input = input || makeInput();
  return {
    getEntry: function () { return input.entry; },
    getPackages: function () { return input.packages; },
    getRouteStops: function () { return input.routeStops; },
    getPackageSequenceIndex: function () { return input.packageSequenceIndex; },
    getPackageSequenceDiagnostics: function () { return input.packageSequenceDiagnostics; },
    getPackageAssistIndex: function () { return input.packageAssistIndex; },
    getPackageAssistDiagnostics: function () { return input.packageAssistDiagnostics; }
  };
}
