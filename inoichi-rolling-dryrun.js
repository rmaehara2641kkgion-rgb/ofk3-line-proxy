/**
 * INO-1 dry-run for rolling 60h.
 * 超過・接近だけを候補にする。判定不能はアラートにしない。
 * 同じ人・同じ7日間・同じ水準は再発報しない。
 * LINE を含む外部送信は行わない。policy-not-confirmed のまま返す。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.InoichiRollingDryRun = api;
})(this, function () {
  'use strict';

  var RULE_ID = 'rolling60h';

  function transportIdOf(driver) {
    if (!driver) return '';
    if (driver.transportId) return String(driver.transportId);
    if (driver.meta && driver.meta.transportId) return String(driver.meta.transportId);
    return '';
  }

  function alertKey(tid, window) {
    return [RULE_ID, tid, window.startDate, window.endDate, window.judgment].join('|');
  }

  function fromDrivers(drivers, options) {
    options = options || {};
    var seen = {};
    (options.previousKeys || []).forEach(function (key) {
      seen[key] = 'previous';
    });
    var alerts = [];
    var undetermined = [];
    (drivers || []).forEach(function (driver) {
      var tid = transportIdOf(driver);
      (driver.windows || []).forEach(function (window) {
        var undecided = window.judgment === 'undetermined' || window.complete === false || window.hasUndefinedHours;
        if (undecided) {
          undetermined.push({
            transportId: tid,
            startDate: window.startDate,
            endDate: window.endDate,
            knownHours: window.totalHours,
            reason: window.complete === false ? 'incomplete-window' : 'undefined-hours',
          });
          return;
        }
        if (window.judgment !== 'exceed' && window.judgment !== 'approach') return;
        if (!tid) {
          undetermined.push({
            transportId: '',
            startDate: window.startDate,
            endDate: window.endDate,
            knownHours: window.totalHours,
            reason: 'missing-transport-id',
          });
          return;
        }
        var key = alertKey(tid, window);
        var repeat = !!seen[key];
        seen[key] = true;
        alerts.push({
          alertKey: key,
          ruleId: RULE_ID,
          transportId: tid,
          level: window.judgment,
          status: repeat ? 'ONGOING' : 'OPEN',
          sent: false,
          channel: 'dry-run',
          suppressionReason: 'policy-not-confirmed',
          evidence: {
            transportId: tid,
            startDate: window.startDate,
            endDate: window.endDate,
            totalHours: window.totalHours,
            limitHours: window.limitHours,
            hoursKind: driver.hoursKind || window.hoursKind || 'estimated_working_hour',
          },
        });
      });
    });
    return {
      sent: false,
      channel: 'dry-run',
      suppressionReason: 'policy-not-confirmed',
      alerts: alerts,
      undetermined: undetermined,
    };
  }

  return {
    RULE_ID: RULE_ID,
    fromDrivers: fromDrivers,
  };
});
