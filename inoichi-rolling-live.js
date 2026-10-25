/**
 * Loads the local rolling snapshot into the INO-1 dashboard
 * and calls the existing collect endpoint. Display math stays in the snapshot.
 */
(function (root) {
  'use strict';

  var COLLECT_URL = 'http://127.0.0.1:3000/harvest/rolling60h/run';
  var SNAPSHOT_URL = '/local/inoichi-rolling-snapshot.json';
  var STATUS_URL = '/local/inoichi-rolling-snapshot-run-status.json';
  var busy = false;

  function dashboard() {
    return root.InoichiDashboard || null;
  }

  function failedView(message, previous) {
    var lastSuccess = null;
    if (previous && (previous.fetchStatus === 'success' || previous.fetchStatus === 'partial')) {
      lastSuccess = previous;
      lastSuccess.archivedLabel = '前回取得分';
    } else if (previous && previous.lastSuccess) {
      lastSuccess = previous.lastSuccess;
    }
    return {
      fetchStatus: 'failed',
      fetchLabel: '取得失敗',
      checkedAt: new Date().toISOString(),
      usable: false,
      counts: {
        driverCount: null,
        clearCount: null,
        exceedCount: null,
        approachCount: null,
        partialCount: null,
        undeterminedCount: null,
      },
      changes: {
        newExceed: 0,
        ongoingExceed: 0,
        resolvedExceed: 0,
        becameUndetermined: 0,
        dataUnchanged: 0,
      },
      history: {},
      alerts: [],
      approachNote: '',
      sent: false,
      channel: 'dry-run',
      lastSuccess: lastSuccess,
      notice: message || '回収に失敗しました',
    };
  }

  function apply(view) {
    var api = dashboard();
    if (api && typeof api.applyRollingView === 'function') api.applyRollingView(view);
  }

  function loadJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (res) {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('snapshot ' + res.status);
      return res.json();
    });
  }

  function withAttemptNotice(view, status) {
    if (!view || !status || status.ok !== false || status.snapshotKept !== true) return view;
    var shown = Object.assign({}, view);
    shown.notice = status.message || '最新の回収は失敗しました。表示している人数は、保存済みの前回成功分です。新しい集計ではありません。';
    shown.latestAttemptFailed = true;
    return shown;
  }

  function loadSnapshot() {
    return loadJson(SNAPSHOT_URL);
  }

  function refresh() {
    return Promise.all([
      loadJson(SNAPSHOT_URL),
      loadJson(STATUS_URL).catch(function () { return null; }),
    ]).then(function (pair) {
      var view = withAttemptNotice(pair[0], pair[1]);
      if (view) apply(view);
      return view;
    });
  }

  function collect() {
    if (busy) return Promise.resolve(null);
    busy = true;
    var previous = null;
    return loadSnapshot().then(function (view) {
      previous = view;
      return fetch(COLLECT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Harvest-Local': '1' },
        body: '{}',
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (res.status === 409 || (body && body.reason === 'already-running')) {
          if (previous) {
            var shown = Object.assign({}, previous);
            shown.notice = '回収は実行中です。重なった要求は拒否しました。';
            apply(shown);
          }
          return previous;
        }
        if (!res.ok) {
          if (previous) {
            var kept = Object.assign({}, previous);
            kept.notice = (body && body.message) || '回収に失敗しました。表示している人数は、保存済みの前回成功分です。新しい集計ではありません。';
            kept.latestAttemptFailed = true;
            apply(kept);
            return kept;
          }
          throw new Error((body && body.message) || ('collect ' + res.status));
        }
        return refresh();
      });
    }).catch(function (err) {
      var message = err && err.message ? err.message : '';
      if (!message || message === 'Failed to fetch') message = '回収先に接続できませんでした。HARVEST画面の「今すぐ回収」を実行してから、表示を更新してください。';
      if (previous && (previous.fetchStatus === 'success' || previous.fetchStatus === 'partial')) {
        var keptView = Object.assign({}, previous);
        keptView.notice = message;
        keptView.latestAttemptFailed = true;
        apply(keptView);
        return keptView;
      }
      apply(failedView(message, previous));
      return null;
    }).then(function (view) {
      busy = false;
      return view;
    });
  }

  function onClick(event) {
    var button = event.target && event.target.closest ? event.target.closest('[data-ino-rolling-action]') : null;
    if (!button) return;
    var action = button.getAttribute('data-ino-rolling-action');
    if (action === 'reload') refresh();
    if (action === 'collect') collect();
  }

  function start() {
    document.addEventListener('click', onClick);
    refresh().catch(function () {});
  }

  root.InoichiRollingLive = {
    start: start,
    refresh: refresh,
    collect: collect,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(typeof window !== 'undefined' ? window : this);
