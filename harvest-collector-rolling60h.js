/**
 * HARVEST Collector: ローリング60h。
 * ブラウザは G: を読まない。ローカルAPIの集計結果だけを受け取る。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HarvestCollectorRolling60h = api;
})(this, function () {
  'use strict';

  var COLLECTOR_ID = 'rolling60h';

  function num(value) {
    var n = Number(value);
    return isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  function fileName(value) {
    var name = String(value || '').split(/[/\\]/).pop();
    if (name.length > 180) name = name.slice(0, 180);
    return name;
  }

  function createCollector(env) {
    env = env || {};
    var request = typeof env.request === 'function' ? env.request : function () {
      return fetch('/harvest/rolling60h/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Harvest-Local': '1' },
        body: '{}',
      }).then(function (res) {
        return res.json().then(function (body) {
          return { status: res.status, body: body };
        });
      });
    };

    return {
      id: COLLECTOR_ID,
      label: 'ローリング60h',
      dependsOn: [],
      trigger: {
        kind: 'human-external',
        instruction: 'このPCのHARVEST画面から「今すぐ回収」を押す',
      },
      probe: function () {
        return request();
      },
      normalize: function (raw) {
        raw = raw || {};
        var body = raw.body || {};
        var denied = raw.status === 403;
        var failed = denied || raw.status >= 400 || body.ok === false && !body.dailyFile && !body.shiftFile;
        var status = denied ? 'error' : failed ? 'awaiting-data' : (num(body.fileFailure) > 0 ? 'partial' : 'ok');
        if (body.ok === true && num(body.fileFailure) === 0) status = 'ok';
        if (body.ok === true && num(body.fileFailure) > 0) status = 'partial';
        return {
          status: status,
          counts: {
            success: num(body.fileSuccess),
            failure: num(body.fileFailure),
            total: num(body.fileSuccess) + num(body.fileFailure),
          },
          errors: denied ? [{ code: 'local-only', message: 'このPC以外からは実行できません' }] : [],
          details: {
            dailyFile: fileName(body.dailyFile),
            shiftFile: fileName(body.shiftFile),
            driverCount: num(body.driverCount),
            clearCount: num(body.clearCount),
            exceedCount: num(body.exceedCount),
            approachCount: num(body.approachCount),
            partialCount: num(body.partialCount),
            partialExceedCount: num(body.partialExceedCount),
            partialApproachCount: num(body.partialApproachCount),
            undeterminedCount: num(body.undeterminedCount),
            unmatchedCount: num(body.unmatchedCount),
            resolvedBySchedule: num(body.resolvedBySchedule),
            resolvedByDaily: num(body.resolvedByDaily),
            resolvedByBoth: num(body.resolvedByBoth),
            resolvedCauseUnknown: num(body.resolvedCauseUnknown),
            stillAlert: num(body.stillAlert),
            verifyUndetermined: num(body.verifyUndetermined),
            resolvedWithFuture: num(body.resolvedWithFuture),
            futureOpenWindows: num(body.futureOpenWindows),
            estimateCoveredWindows: num(body.estimateCoveredWindows),
            reusedArchiveDays: num(body.reusedArchiveDays),
            historyRuns: num(body.historyRuns),
            historyCreated: num(body.historyCreated),
            confirmedActual: false,
            sent: false,
            channel: 'dry-run',
          },
        };
      },
      summarize: function (result) {
        var d = result.details || {};
        var c = result.counts || {};
        return [
          'デイリー ' + (d.dailyFile || 'なし'),
          'シフト ' + (d.shiftFile || 'なし'),
          '取得 成功' + (c.success || 0) + ' 失敗' + (c.failure || 0),
          '対象' + (d.driverCount || 0) + '人',
          '正常' + (d.clearCount || 0) + '人',
          '超過' + (d.exceedCount || 0) + '人',
          '接近' + (d.approachCount || 0) + '人',
          '部分欠損' + (d.partialCount || 0) + '人',
          '完全判定不能' + (d.undeterminedCount || 0) + '人',
          '未照合' + (d.unmatchedCount || 0) + '件',
          '予測解消 予定変更' + (d.resolvedBySchedule || 0),
          'デイリー更新' + (d.resolvedByDaily || 0),
          '両方' + (d.resolvedByBoth || 0),
          '原因判定不能' + (d.resolvedCauseUnknown || 0),
          '継続警戒' + (d.stillAlert || 0),
          '検証不能' + (d.verifyUndetermined || 0),
          '未来日が残る窓' + (d.futureOpenWindows || 0) + '（予定を含む）',
          '推定時間で揃った窓' + (d.estimateCoveredWindows || 0) + '（アプリ稼働の推定であり法的な労働時間ではない）',
        ].join(' / ');
      },
      handoff: function () {
        return { payloadReference: 'rolling60h' };
      },
    };
  }

  function register(hub, env) {
    return hub.register(createCollector(env));
  }

  return {
    COLLECTOR_ID: COLLECTOR_ID,
    createCollector: createCollector,
    register: register,
  };
});
