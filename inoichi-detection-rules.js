(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.InoichiDetectionRules = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_RULES = [];

  var SAMPLE_FLEET_CAPACITY_SHORTAGE_V1 = {
    ruleId: 'fleet-capacity-shortage-v1',
    category: 'fleet-capacity',
    inputType: 'fleet-capacity-canonical',
    enabled: false,
    version: '0.1.0',
    condition: {
      operator: 'less-than',
      left: { path: 'actual' },
      right: { path: 'expected' }
    },
    severity: {
      mapping: {
        cases: [
          {
            condition: {
              operator: 'greater-than-or-equal',
              left: { path: 'shortage' },
              right: { value: 3 }
            },
            severity: 'critical'
          },
          {
            condition: {
              operator: 'greater-than-or-equal',
              left: { path: 'shortage' },
              right: { value: 1 }
            },
            severity: 'warning'
          }
        ],
        default: 'info'
      }
    },
    messageTemplate: {
      title: '欠車リスク検出',
      summary: '{localDate} / {block} / 必要{expected}台 / 計画{actual}台 / 不足{shortage}台'
    }
  };

  // Data-quality rule for the 'time-window-canonical' input produced by inoichi-time-window-adapter.js.
  // Judges the reliability of the captured timeWindow data only; it never means delivery lateness.
  // Details of each issue are in the adapter output (issues[]); the alert only flags the state.
  var TIME_WINDOW_DATA_FRESHNESS_V1 = {
    ruleId: 'time-window-data-freshness-v1',
    category: 'data-quality',
    inputType: 'time-window-canonical',
    enabled: false,
    version: '0.1.0',
    condition: {
      operator: 'greater-than',
      left: { path: 'issueCount' },
      right: { value: 0 }
    },
    severity: {
      mapping: {
        cases: [
          {
            condition: {
              operator: 'greater-than',
              left: { path: 'blockingCount' },
              right: { value: 0 }
            },
            severity: 'warning'
          }
        ],
        default: 'info'
      }
    },
    messageTemplate: {
      title: '時間指定データの信頼性確認',
      summary: '対象日 {localDate}: 時間指定データの品質に注意があります。再取得の確認を推奨します(配送遅延の判定ではありません)'
    }
  };

  function getDefaultRules() {
    return JSON.parse(JSON.stringify(DEFAULT_RULES));
  }

  function getSampleFleetCapacityRule() {
    return JSON.parse(JSON.stringify(SAMPLE_FLEET_CAPACITY_SHORTAGE_V1));
  }

  function getTimeWindowDataFreshnessRule() {
    return JSON.parse(JSON.stringify(TIME_WINDOW_DATA_FRESHNESS_V1));
  }

  return {
    DEFAULT_RULES: DEFAULT_RULES,
    TIME_WINDOW_DATA_FRESHNESS_V1: TIME_WINDOW_DATA_FRESHNESS_V1,
    getTimeWindowDataFreshnessRule: getTimeWindowDataFreshnessRule,
    SAMPLE_FLEET_CAPACITY_SHORTAGE_V1: SAMPLE_FLEET_CAPACITY_SHORTAGE_V1,
    getDefaultRules: getDefaultRules,
    getSampleFleetCapacityRule: getSampleFleetCapacityRule
  };
}));
