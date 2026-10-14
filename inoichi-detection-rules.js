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

  function getDefaultRules() {
    return JSON.parse(JSON.stringify(DEFAULT_RULES));
  }

  function getSampleFleetCapacityRule() {
    return JSON.parse(JSON.stringify(SAMPLE_FLEET_CAPACITY_SHORTAGE_V1));
  }

  return {
    DEFAULT_RULES: DEFAULT_RULES,
    SAMPLE_FLEET_CAPACITY_SHORTAGE_V1: SAMPLE_FLEET_CAPACITY_SHORTAGE_V1,
    getDefaultRules: getDefaultRules,
    getSampleFleetCapacityRule: getSampleFleetCapacityRule
  };
}));
