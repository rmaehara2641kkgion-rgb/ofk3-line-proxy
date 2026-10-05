/**
 * HARVEST Collector for Mentor Active Snapshots.
 * Reads the snapshot already stored by OFK3MentorActive. Does not call Mentor.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HarvestCollectorsMentor = api;
})(this, function () {
  'use strict';

  var TRIGGER_INSTRUCTION = 'Mentor画面の診断パネルで「HARVESTへ送る」を実行';

  function errMsg(e) {
    return String(e && e.message ? e.message : e).slice(0, 200);
  }

  function asDrivers(snapshot) {
    return snapshot && Array.isArray(snapshot.drivers) ? snapshot.drivers : [];
  }

  function createMentorCollectors(env) {
    env = env || {};
    var getApi = typeof env.getApi === 'function' ? env.getApi : function () {
      return typeof window !== 'undefined' ? window.OFK3MentorActive : null;
    };

    function probe() {
      var api = getApi();
      if (!api || typeof api.load !== 'function' || typeof api.getSnapshot !== 'function') {
        return Promise.resolve({ available: false });
      }
      var loadError = null;
      return Promise.resolve().then(function () {
        return api.load();
      }).catch(function (e) {
        loadError = errMsg(e);
      }).then(function () {
        var snapshot = null;
        try { snapshot = api.getSnapshot(); } catch (e2) { snapshot = null; }
        return {
          available: true,
          loadError: loadError || (typeof api.getLoadError === 'function' ? api.getLoadError() : ''),
          snapshot: snapshot && typeof snapshot === 'object' ? snapshot : null
        };
      });
    }

    var mentorActive = {
      id: 'mentorActive',
      label: 'Mentor Active',
      dependsOn: [],
      affectsOverall: false,
      trigger: { kind: 'human-external', instruction: TRIGGER_INSTRUCTION },
      probe: probe,
      normalize: function (raw) {
        if (!raw || !raw.available) {
          return {
            status: 'error',
            counts: { success: 0, failure: 0, total: 0 },
            errors: [{ code: 'mentor-api-missing', message: 'OFK3MentorActive が見つかりません' }],
            details: {}
          };
        }
        if (raw.loadError) {
          return {
            status: 'error',
            counts: { success: 0, failure: 0, total: 0 },
            errors: [{ code: 'load-exception', message: 'Mentor snapshot の読込に失敗しました' }],
            details: {}
          };
        }
        var snapshot = raw.snapshot;
        if (!snapshot || snapshot.source !== 'mentor' || !Array.isArray(snapshot.drivers)) {
          return {
            status: 'awaiting-data',
            counts: { success: 0, failure: 0, total: 0 },
            errors: [{ code: 'no-mentor-snapshot', message: 'Mentor Active Snapshot がありません' }],
            details: {}
          };
        }
        var drivers = [];
        var grouped = {};
        var missingStaff = 0;
        asDrivers(snapshot).forEach(function (row) {
          if (!row || typeof row !== 'object') return;
          function text(value) {
            if (typeof value === 'number' && isFinite(value)) return String(value);
            return typeof value === 'string' ? value : '';
          }
          var driver = {
            driverId: text(row.driverId),
            realStaffNumber: text(row.realStaffNumber),
            firstName: text(row.firstName),
            lastName: text(row.lastName),
            shiftStartTime: typeof row.shiftStartTime === 'number' && isFinite(row.shiftStartTime) ? row.shiftStartTime : null,
            vehicleIdentifier: typeof row.vehicleIdentifier === 'string' && row.vehicleIdentifier ? row.vehicleIdentifier : null
          };
          drivers.push(driver);
          if (!driver.realStaffNumber) {
            missingStaff += 1;
            return;
          }
          if (!grouped[driver.realStaffNumber]) grouped[driver.realStaffNumber] = { driverIds: {}, sample: driver };
          grouped[driver.realStaffNumber].driverIds[driver.driverId] = true;
        });
        var byRealStaffNumber = {};
        var staffConflicts = 0;
        var conflictedRows = 0;
        var success = 0;
        Object.keys(grouped).forEach(function (staff) {
          var group = grouped[staff];
          var ids = Object.keys(group.driverIds);
          var rowCount = 0;
          drivers.forEach(function (driver) {
            if (driver.realStaffNumber === staff) rowCount += 1;
          });
          if (ids.length > 1) {
            staffConflicts += 1;
            conflictedRows += rowCount;
            return;
          }
          success += rowCount;
          byRealStaffNumber[staff] = {
            driverId: group.sample.driverId,
            firstName: group.sample.firstName,
            lastName: group.sample.lastName,
            shiftStartTime: group.sample.shiftStartTime,
            vehicleIdentifier: group.sample.vehicleIdentifier
          };
        });
        var total = drivers.length;
        var failure = missingStaff + conflictedRows;
        var errors = [];
        if (missingStaff) errors.push({ code: 'missing-real-staff-number', message: 'realStaffNumber のない Active 行', count: missingStaff });
        if (staffConflicts) errors.push({ code: 'staff-number-conflict', message: '同一 realStaffNumber に複数 driverId', count: staffConflicts });
        var status = 'ok';
        if (failure > 0 && success === 0) status = 'error';
        else if (failure > 0) status = 'partial';
        return {
          status: status,
          counts: { success: success, failure: failure, total: total },
          errors: errors,
          details: {
            capturedAt: snapshot.capturedAt || null,
            receivedAt: snapshot.receivedAt || null,
            source: 'mentor',
            activeCount: total,
            matchKey: 'realStaffNumber',
            mentorKey: 'driverId',
            missingStaff: missingStaff,
            staffConflicts: staffConflicts,
            drivers: drivers,
            byRealStaffNumber: byRealStaffNumber
          }
        };
      },
      summarize: function (result) {
        var d = result.details || {};
        if (result.status === 'awaiting-data') return 'Mentor Active Snapshot 待ち';
        return 'Active ' + (d.activeCount || 0) + '名 / 照合可 ' + (result.counts ? result.counts.success : 0);
      },
      handoff: function (result) {
        var d = result && result.details ? result.details : {};
        return {
          payloadReference: {
            via: 'window.OFK3MentorActive',
            getter: 'getSnapshot',
            matchKey: 'realStaffNumber',
            mentorKey: 'driverId',
            capturedAt: d.capturedAt || null,
            activeCount: d.activeCount || 0,
            note: '保存済み Snapshot を getter から読む。Mentor の再取得はしない。'
          }
        };
      }
    };

    return { mentorActive: mentorActive, list: [mentorActive] };
  }

  function registerMentorCollectors(hub, env) {
    var cols = createMentorCollectors(env);
    cols.list.forEach(function (c) { hub.register(c); });
    return cols;
  }

  return {
    TRIGGER_INSTRUCTION: TRIGGER_INSTRUCTION,
    createMentorCollectors: createMentorCollectors,
    registerMentorCollectors: registerMentorCollectors
  };
});
