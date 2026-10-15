/**
 * INOICHI timeWindow quality dry-run (Step 3) — pure function.
 *
 * Glue for a manual, on-screen check:
 *   P0 timeWindow envelope -> time-window adapter -> detection engine (ONE rule) -> result object.
 *
 * - Evaluates ONLY time-window-data-freshness-v1. The fleet-capacity rule is never evaluated.
 * - The rule definition stays enabled:false. The engine skips disabled rules, so a private
 *   deep copy with enabled:true is evaluated for this dry-run only; the shared definition
 *   (Rules.TIME_WINDOW_DATA_FRESHNESS_V1) and DEFAULT_RULES are never touched.
 * - No clock (opts.now is required and passed through), no network, no storage, no notification,
 *   no write. Alerts live only in the returned object (and in opts.existingAlerts, which the
 *   caller keeps in memory) so repeated runs de-duplicate instead of creating new alerts.
 * - Never throws.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./inoichi-time-window-adapter.js'),
      require('./inoichi-detection-core.js'),
      require('./inoichi-detection-rules.js')
    );
  } else {
    root.InoichiQualityDryRun = factory(root.InoichiTimeWindowAdapter, root.InoichiDetectionCore, root.InoichiDetectionRules);
  }
}(typeof self !== 'undefined' ? self : this, function (Adapter, Detect, Rules) {
  'use strict';

  var RULE_ID = 'time-window-data-freshness-v1';

  function dependenciesOk() {
    return !!(Adapter && typeof Adapter.adaptTimeWindow === 'function' &&
      Detect && typeof Detect.detect === 'function' &&
      Rules && typeof Rules.getTimeWindowDataFreshnessRule === 'function');
  }

  // opts: { now (required), freshnessThresholdMinutes?, targetLocalDate?, existingAlerts? }
  function evaluateTimeWindowQuality(envelope, opts) {
    var o = opts && typeof opts === 'object' ? opts : {};
    var out = {
      dryRun: true,
      written: false,
      notified: false,
      ruleId: RULE_ID,
      ruleDefinitionEnabled: null,
      error: null,
      adapterOutput: null,
      alerts: [],
      detection: null,
      timestampsFromEngineClock: false
    };
    try {
      if (!dependenciesOk()) {
        out.error = 'dependency-missing';
        return out;
      }
      var definition = Rules.getTimeWindowDataFreshnessRule();
      out.ruleDefinitionEnabled = definition.enabled === true;

      var adapted = Adapter.adaptTimeWindow(envelope, {
        now: o.now,
        freshnessThresholdMinutes: o.freshnessThresholdMinutes,
        targetLocalDate: o.targetLocalDate
      });
      out.adapterOutput = adapted;

      // Dry-run only: evaluate a private enabled copy of this single rule.
      var runRule = JSON.parse(JSON.stringify(definition));
      runRule.enabled = true;
      var detectOpts = { existingAlerts: Array.isArray(o.existingAlerts) ? o.existingAlerts : [] };
      if (adapted.now) detectOpts.now = adapted.now;
      var det = Detect.detect(adapted, [runRule], detectOpts);
      out.detection = { diagnostics: det.diagnostics, detectedAt: det.detectedAt };
      out.alerts = det.alerts;
      // Without a valid opts.now the engine falls back to its own clock for timestamps only.
      // That fallback never feeds the quality judgement (the adapter output above is already
      // final), and it must not look like a real evaluation time: blank the timestamps.
      out.timestampsFromEngineClock = false;
      if (!adapted.now) {
        out.timestampsFromEngineClock = true;
        out.detection.detectedAt = null;
        out.alerts = det.alerts.map(function (a) {
          var c = JSON.parse(JSON.stringify(a));
          c.detectedAt = null;
          c.updatedAt = null;
          return c;
        });
      }
    } catch (e) {
      out.error = String(e && e.message ? e.message : e);
    }
    return out;
  }

  return {
    RULE_ID: RULE_ID,
    evaluateTimeWindowQuality: evaluateTimeWindowQuality
  };
}));
