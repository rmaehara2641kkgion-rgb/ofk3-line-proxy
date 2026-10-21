/**
 * ローリングシフト アラート結果の保存（最新1件のみ）。
 * 既存の点呼同期・LINE未紐付けと同じ方式（一時ディスクのJSONファイル）。新規DBは作らない。
 * Renderの無料プランでは再デプロイでディスクが消えるため、ブラウザ側 localStorage も併用する（UI側）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(this, function () {
  'use strict';

  var Core = require('./rolling-alert-core.js');

  function createStore(deps) {
    var fs = deps.fs;
    var filePath = deps.filePath;
    var nowIso = deps.now || function () { return new Date().toISOString(); };
    var latest = null;

    function load() {
      try {
        if (fs.existsSync(filePath)) {
          var parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (Core.validateSnapshot(parsed).ok) latest = parsed;
        }
      } catch (e) {
        latest = null; // 壊れたファイルは無視して未保存扱い
      }
      return latest;
    }

    function persist() {
      var tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(latest), 'utf8');
      fs.renameSync(tmp, filePath);
    }

    function get() {
      return latest;
    }

    /**
     * @return {{status:'saved'|'unchanged'|'stale-rejected'|'invalid', snapshot?:object, reason?:string}}
     */
    function put(snapshot) {
      var v = Core.validateSnapshot(snapshot);
      if (!v.ok) return { status: 'invalid', reason: v.reason };
      if (latest) {
        // 古い取り込みで新しい結果を上書きしない
        var curImport = Date.parse(latest.dataImportedAt || latest.computedAt);
        var newImport = Date.parse(snapshot.dataImportedAt || snapshot.computedAt);
        var same = latest.inputFingerprint === snapshot.inputFingerprint && latest.targetDate === snapshot.targetDate;
        if (same) {
          // 同一データの再投入: 結果は置換も追加もしない。取り込み時刻だけ更新する。
          if (newImport > curImport) {
            latest = Object.assign({}, latest, { dataImportedAt: snapshot.dataImportedAt });
            persist();
          }
          return { status: 'unchanged', snapshot: latest };
        }
        if (newImport < curImport) return { status: 'stale-rejected', snapshot: latest };
      }
      latest = snapshot;
      persist();
      return { status: 'saved', snapshot: latest };
    }

    return { load: load, get: get, put: put, _now: nowIso };
  }

  return { createStore: createStore };
});
