/**
 * ローリングシフト アラート結果の保存（最新1件のみ）。
 * 既存の点呼同期・LINE未紐付けと同じ方式（一時ディスクのJSONファイル）。新規DBは作らない。
 * Renderの無料プランでは再デプロイでディスクが消えるため、ブラウザ側の保存を併用する（UI側）。
 *
 * 競合は端末の時計ではなく、サーバー採番のリビジョンで判定する。
 *   - 保存時に「最後に見たリビジョン(baseRevision)」を送る。サーバーの最新と違えば conflict で
 *     既存結果を壊さず返す（別端末が先に更新した場合など）。明示的な overwrite のときだけ上書きする。
 *   - リビジョンは「ストアID.連番」。ファイル消失（再デプロイ）後は新しいストアIDになり、
 *     古いリビジョンを持つ端末が新世代へ黙って上書きすることはない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(this, function () {
  'use strict';

  var Core = require('./rolling-alert-core.js');
  var crypto = require('crypto');

  function createStore(deps) {
    var fs = deps.fs;
    var filePath = deps.filePath;
    var clock = deps.now || function () { return Date.now(); };
    var storeId = crypto.randomBytes(4).toString('hex');
    var seq = 0;
    var latest = null; // { revision, savedAt, snapshot }

    function load() {
      try {
        if (fs.existsSync(filePath)) {
          var f = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          var v = f && Core.sanitizeSnapshot(f.snapshot, { now: clock() });
          if (v && v.ok && /^[0-9a-f]{8}$/.test(f.storeId || '') && Number.isInteger(f.seq) && f.seq >= 1) {
            storeId = f.storeId;
            seq = f.seq;
            latest = { revision: storeId + '.' + seq, savedAt: f.savedAt, snapshot: v.snapshot };
          }
        }
      } catch (e) {
        latest = null; // 壊れたファイルは未保存扱い（上書きもしない: 次の正常な保存まで触らない）
      }
      return latest;
    }

    function persist() {
      var tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ storeId: storeId, seq: seq, savedAt: latest.savedAt, snapshot: latest.snapshot }), 'utf8');
      fs.renameSync(tmp, filePath); // 途中で失敗しても既存ファイルは壊れない
    }

    function get() {
      return latest;
    }

    /**
     * @param {Object} snapshot
     * @param {{baseRevision?:string|null, overwrite?:boolean}} [opts]
     * @return {{status:'saved'|'unchanged'|'conflict'|'invalid', current?:Object, reason?:string}}
     */
    function put(snapshot, opts) {
      opts = opts || {};
      var v = Core.sanitizeSnapshot(snapshot, { now: clock() });
      if (!v.ok) return { status: 'invalid', reason: v.reason };
      var snap = v.snapshot;
      if (latest) {
        if (latest.snapshot.inputFingerprint === snap.inputFingerprint && latest.snapshot.targetDate === snap.targetDate) {
          // 同一データの再投入: 結果は置換も追記もしない（リビジョンも変えない）。
          return { status: 'unchanged', current: latest };
        }
        if (!opts.overwrite && opts.baseRevision !== latest.revision) {
          return { status: 'conflict', current: latest };
        }
      }
      var prev = latest;
      var prevSeq = seq;
      seq += 1;
      latest = { revision: storeId + '.' + seq, savedAt: new Date(clock()).toISOString(), snapshot: snap };
      try {
        persist();
      } catch (e) {
        latest = prev; // 書き込み失敗時はメモリも元に戻す
        seq = prevSeq;
        throw e;
      }
      return { status: 'saved', current: latest };
    }

    return { load: load, get: get, put: put };
  }

  return { createStore: createStore };
});
