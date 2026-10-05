import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
function read(name) { return readFileSync(join(repo, name), 'utf8'); }
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }

const Store = require(join(repo, 'mentor-active-store.js'));
const Core = require(join(repo, 'harvest-core.js'));
const MentorCols = require(join(repo, 'harvest-collectors-mentor.js'));
const CortexCols = require(join(repo, 'harvest-collectors-cortex.js'));

const mentorSrc = read('cortex-capture-extension/mentor-capture.js');
const sandbox = {
  console: console,
  URL: URL,
  AbortController: AbortController,
  setTimeout: function () {},
  document: { documentElement: null, addEventListener: function () {}, getElementById: function () { return null; } }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(mentorSrc, sandbox, { filename: 'mentor-capture.js' });
const MC = sandbox.OFK3MentorCapture;

const secretName = 'Yamada Taro';
const secretId = 'DA-SECRET-42';
const secretStaff = 'STF-7788';
const snap = MC.buildActiveSnapshot({
  data: [
    {
      driverId: secretId,
      realStaffNumber: secretStaff,
      firstName: 'Yamada',
      lastName: 'Taro',
      shiftStartTime: 1791160800000,
      shiftEndTime: 'N/A',
      vrmStatus: 'Active',
      vehicleIdentifier: 'VH-1',
      device: { id: 'phone-secret' },
      fpId: 'SECRET-FLEET',
      authorization: 'Bearer SECRET'
    },
    {
      driverId: 'DA-IDLE',
      realStaffNumber: 'STF-IDLE',
      firstName: 'Idle',
      lastName: 'Person',
      shiftEndTime: 'N/A',
      vrmStatus: 'Idle'
    },
    {
      driverId: 'DA-CLOSED',
      realStaffNumber: 'STF-CLOSED',
      firstName: 'Closed',
      lastName: 'Person',
      shiftEndTime: 1791170000000,
      vrmStatus: 'Active'
    }
  ]
}, '2026-10-05T13:00:00.000Z');
assert(snap.source === 'mentor' && snap.activeCount === 1 && snap.drivers.length === 1, 'only Active and N/A rows enter the snapshot');
assert(snap.drivers[0].driverId === secretId && snap.drivers[0].realStaffNumber === secretStaff, 'mentor key and harvest key are kept');
assert(snap.drivers[0].firstName === 'Yamada' && snap.drivers[0].lastName === 'Taro', 'display name parts are kept');
assert(snap.drivers[0].shiftStartTime === 1791160800000 && snap.drivers[0].vehicleIdentifier === 'VH-1', 'start and vehicle are kept');
assert(Object.keys(snap.drivers[0]).sort().join(',') === 'driverId,firstName,lastName,realStaffNumber,shiftStartTime,vehicleIdentifier', 'snapshot driver has only the allowlisted fields');
const snapCopy = JSON.stringify(snap);
assert(snapCopy.indexOf('phone-secret') < 0 && snapCopy.indexOf('SECRET-FLEET') < 0 && snapCopy.indexOf('Bearer') < 0, 'snapshot drops device, fleet, and credential-like fields');
assert(snapCopy.indexOf('Idle') < 0 && snapCopy.indexOf('Closed') < 0, 'non-active rows are omitted');

const observed = MC.applyObservation({
  metaCaptured: false,
  shiftsCaptured: false,
  lastResponse: null
}, 'shifts', {
  pathname: '/reports/driver/shifts',
  method: 'GET',
  status: 200,
  type: 'cors',
  ok: true,
  contentType: 'application/json',
  clone: 'SUCCESS',
  textStatus: 'SUCCESS',
  text: JSON.stringify({
    data: [{
      driverId: secretId,
      realStaffNumber: secretStaff,
      firstName: secretName,
      lastName: 'Taro',
      shiftStartTime: 1791160800000,
      shiftEndTime: 'N/A',
      vrmStatus: 'Active',
      vehicleIdentifier: 'VH-1'
    }]
  })
});
assert(observed.activeSnapshot && observed.activeSnapshot.activeCount === 1, 'accepted shifts body builds an active snapshot');
const diagnostic = JSON.stringify(MC.buildDiagnostic(observed));
assert(diagnostic.indexOf(secretName) < 0 && diagnostic.indexOf(secretId) < 0 && diagnostic.indexOf(secretStaff) < 0, 'diagnostic JSON still omits driver values');
assert(diagnostic.indexOf('"activeSnapshotCount":1') >= 0, 'diagnostic keeps only the active count');

assert(mentorSrc.indexOf('var panelCollapsed = true') >= 0, 'diagnostic panel starts collapsed');
assert(mentorSrc.indexOf('HARVESTへ送る') >= 0 && mentorSrc.indexOf('OFK3_MENTOR') >= 0, 'send uses the Mentor message channel');
assert(mentorSrc.indexOf('/mentor-active') < 0 && mentorSrc.indexOf('mis-api.edriving.com') < 0, 'page hook does not fetch Mentor or OFK3');
assert(mentorSrc.indexOf('detachableSignal') >= 0 && mentorSrc.indexOf('bridge.detach()') >= 0, 'abort detach remains');
assert(mentorSrc.indexOf('localStorage') < 0 && mentorSrc.indexOf('document.cookie') < 0 && mentorSrc.indexOf('Authorization') < 0, 'sensor still does not read credentials');

const saved = Store.createMentorActiveStore().save({
  capturedAt: '2026-10-05T13:00:00.000Z',
  source: 'mentor',
  activeCount: 9,
  drivers: [
    {
      driverId: secretId,
      realStaffNumber: secretStaff,
      firstName: 'Yamada',
      lastName: 'Taro',
      shiftStartTime: 1791160800000,
      vehicleIdentifier: 'VH-1',
      device: 'phone-secret',
      authorization: 'Bearer SECRET',
      fpId: 'SECRET-FLEET'
    },
    { driverId: '', realStaffNumber: '', firstName: 'Nobody' }
  ]
}, '2026-10-05T13:01:00.000Z');
assert(saved.ok && saved.snapshot.activeCount === 1, 'store keeps only drivers with an identifier');
assert(saved.snapshot.drivers[0].driverId === secretId, 'store keeps the allowlisted identifier');
assert(JSON.stringify(saved.snapshot).indexOf('phone-secret') < 0, 'store drops fields outside the payload');
assert(JSON.stringify(saved.snapshot).indexOf('Bearer') < 0, 'store drops credential-like values');
assert(Store.sanitizeMentorActiveSnapshot({ source: 'cortex', drivers: [] }).ok === false, 'cortex payloads are rejected');

const hub = Core.createHub({ now: function () { return '2026-10-05T13:02:00.000Z'; } });
CortexCols.registerCortexCollectors(hub, {
  getApi: function () {
    return {
      load: function () { return Promise.resolve(); },
      getEntry: function () { return { localDate: '2026-10-05' }; },
      getPackages: function () { return [{ routeCode: 'R1', trackingId: 'T1', plannedEndTime: 1 }]; },
      getPackageAssistIndex: function () { return [{ routeCode: 'R1', trackingId: 'T1', bagStatus: 'captured_null' }]; },
      getPackageAssistDiagnostics: function () { return null; },
      getPackageSequenceIndex: function () { return []; },
      getPackageSequenceDiagnostics: function () { return null; },
      getRouteStops: function () { return []; },
      getStops: function () { return []; }
    };
  },
  todayIso: function () { return '2026-10-05'; }
});
MentorCols.registerMentorCollectors(hub, {
  getApi: function () {
    return {
      load: function () { return Promise.resolve(); },
      getSnapshot: function () { return null; },
      getLoadError: function () { return ''; }
    };
  }
});
const all = await hub.runAll();
assert(all.overall === 'COMPLETE', 'a missing Mentor snapshot does not change the Cortex overall result');
assert(hub.getState('mentorActive').status === 'awaiting-data', 'Mentor collector reports that no snapshot is stored');

const mentorHub = Core.createHub({ now: function () { return '2026-10-05T13:03:00.000Z'; } });
MentorCols.registerMentorCollectors(mentorHub, {
  getApi: function () {
    return {
      load: function () { return Promise.resolve(); },
      getSnapshot: function () {
        return {
          capturedAt: '2026-10-05T13:00:00.000Z',
          source: 'mentor',
          drivers: [
            { driverId: 'D1', realStaffNumber: 'S1', firstName: 'A', lastName: 'One', shiftStartTime: 11, vehicleIdentifier: 'V1' },
            { driverId: 'D1', realStaffNumber: 'S1', firstName: 'A', lastName: 'One', shiftStartTime: 11, vehicleIdentifier: 'V1' },
            { driverId: 'D2', realStaffNumber: 'S1', firstName: 'B', lastName: 'Two', shiftStartTime: 12, vehicleIdentifier: null },
            { driverId: 'D4', realStaffNumber: 'S2', firstName: 'D', lastName: 'Four', shiftStartTime: 14, vehicleIdentifier: 'V4' },
            { driverId: 'D3', realStaffNumber: '', firstName: 'C', lastName: 'Three', shiftStartTime: 13, vehicleIdentifier: 'V3' }
          ]
        };
      },
      getLoadError: function () { return ''; }
    };
  }
});
await mentorHub.runCollector('mentorActive');
const mentorState = mentorHub.getState('mentorActive');
assert(mentorState.status === 'partial', 'missing staff or a staff conflict is partial');
assert(mentorState.details.byRealStaffNumber.S2.driverId === 'D4', 'a one-to-one staff number stays in the match index');
assert(mentorState.details.byRealStaffNumber.S1 == null, 'a staff number with two driverIds is not comparable');
assert(mentorState.counts.success === 1 && mentorState.counts.failure === 4, 'conflicted rows are not counted as comparable');
assert(mentorState.details.staffConflicts === 1 && mentorState.details.missingStaff === 1, 'conflicts are counts');
assert(mentorState.details.matchKey === 'realStaffNumber' && mentorState.details.mentorKey === 'driverId', 'normalized keys are explicit');
const handoff = mentorHub.handoff('mentorActive');
assert(handoff.ok && handoff.record.payloadReference.getter === 'getSnapshot', 'handoff points at the stored snapshot');
assert(JSON.stringify(handoff.record).indexOf('D1') < 0, 'handoff record does not copy driver values');

const bg = read('cortex-capture-extension/background.js');
const bridge = read('cortex-capture-extension/bridge.js');
const mentorBridge = read('cortex-capture-extension/mentor-bridge.js');
assert(bg.indexOf("'/cortex-priority/import'") >= 0, 'Cortex import endpoint remains');
assert(bg.indexOf("'/mentor-active/import'") >= 0, 'Mentor import uses its own endpoint');
assert(bridge.indexOf('OFK3_MENTOR') < 0 && bridge.indexOf('mentor-active') < 0, 'Cortex bridge is unchanged');
assert(mentorBridge.indexOf('OFK3_MENTOR') >= 0 && mentorBridge.indexOf('mentor-active-import') >= 0, 'Mentor bridge is separate');
assert(mentorBridge.indexOf('document.cookie') < 0 && mentorBridge.indexOf('Authorization') < 0, 'Mentor bridge does not read credentials');

const manifest = JSON.parse(read('cortex-capture-extension/manifest.json'));
assert(manifest.content_scripts.some(function (cs) {
  return cs.world === 'ISOLATED' && (cs.js || []).indexOf('bridge.js') >= 0 &&
    (cs.matches || []).indexOf('https://logistics.amazon.co.jp/*') >= 0;
}), 'Amazon isolated bridge remains');
assert(manifest.content_scripts.some(function (cs) {
  return cs.world === 'ISOLATED' && (cs.js || []).indexOf('mentor-bridge.js') >= 0 &&
    (cs.matches || []).length === 1 && cs.matches[0] === 'https://vrm-mentor.edriving.com/*';
}), 'Mentor bridge is limited to the Mentor origin');
assert((manifest.host_permissions || []).indexOf('https://mis-api.edriving.com/*') < 0, 'API host permission is not added');

const client = read('ofk3-mentor-active.js');
assert(client.indexOf("fetch('/mentor-active'") >= 0, 'OFK3 reads the Mentor store');
assert(client.indexOf('mis-api.edriving.com') < 0 && client.indexOf('/reports/driver/shifts') < 0, 'OFK3 client does not call Mentor');
const collectorSrc = read('harvest-collectors-mentor.js');
assert(collectorSrc.indexOf('fetch(') < 0 && collectorSrc.indexOf('mis-api.edriving.com') < 0, 'HARVEST collector does not fetch');
assert(read('cortex-capture-extension/phase1-runner.js').indexOf('mentor-active') < 0, 'Cortex runner is untouched');
assert(read('cortex-capture-extension/phase1-core.js').indexOf('mentor-active') < 0, 'Cortex core is untouched');
assert(read('render-webhook-server.js').indexOf("app.post('/cortex-priority/import'") >= 0, 'Cortex import route remains');
assert(read('render-webhook-server.js').indexOf("app.post('/mentor-active/import'") >= 0, 'Mentor import route is separate');
assert(read('render-webhook-server.js').indexOf('/harvest-collectors-mentor.js?v=') < read('render-webhook-server.js').indexOf('/ofk3-harvest-ui.js?v='), 'Mentor scripts load before the HARVEST UI');

console.log('mentor-sensor-v1 tests passed');
