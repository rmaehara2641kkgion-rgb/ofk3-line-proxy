/**
 * OFK3 静的ファイル公開ポリシー（SEC-04）
 *
 * リポジトリルート全体を express.static で公開する方式を廃止し、
 * ブラウザが実際に必要とするファイルだけを「ファイル単位の許可リスト」で公開する（デフォルト拒否）。
 *
 * 方針:
 * - 拡張子単位・ディレクトリ単位の一括許可はしない。許可リストの完全一致のみ。
 * - リクエスト由来の文字列はファイルパスに使わない。許可リストの照合キーとしてのみ使い、
 *   実ファイルのパスは許可リスト側の定数から組み立てる。
 * - GET / HEAD のみ。未許可・不正・存在しないものは応答せず next() に渡す
 *   （既存APIルートや後続の404処理をそのまま動かす）。
 * - シンボリックリンク等で許可ファイル以外の実体を指している場合は配信しない。
 * - index.html は含めない（'/' と '/index.html' はサーバー側のHTML注入ルートが配信する）。
 *   管理者ログイン画面(/admin/login 等)も専用ルートで配信されるため含めない。
 */
'use strict';

var fs = require('fs');
var path = require('path');

/** 公開を許可するファイル（ルートからの相対パス・'/' 区切り）。追加は1ファイルずつ明示すること。 */
var PUBLIC_FILES = Object.freeze([
  // --- index.html が読み込むスクリプト ---
  'area-experience-core.js',
  'assign-support-core.js',
  'assign-support.js',
  'billing-reconcile-core.js',
  'contact-compliance-core.js',
  'cortex-13-priority-core.js',
  'cortex-13-priority.js',
  'cortex-route-sequence.js',
  'dnr-core.js',
  'driver-ability-import-core.js',
  'driver-cumulative-core.js',
  'driver-cumulative-ui.js',
  'driver-cumulative-xlsx.js',
  'duty-hours-format.js',
  'duty-risk-dashboard.js',
  'duty-risk-snapshot.js',
  'harvest-daily-manifest.js',
  'harvest-rolling60h-run.js',
  'lat-departure-core.js',
  'lat-timeline-core.js',
  'line-unlinked-core.js',
  'manual-assign-board-core.js',
  'manual-assign-board.js',
  'nearby-course-core.js',
  'ofk3-bag-sheet.js',
  'ofk3-cortex-priority-ui.js',
  'ofk3-delivery-map.js',
  'ofk3-map-cortex-overlay.js',
  'ofk3-nearby-course-ui.js',
  'qr-print-order-core.js',
  'rolling60h-board-ui.js',
  'rolling60h-core.js',
  'rolling60h-dispatch-ui.js',
  'rolling60h-dispatch.js',
  'rolling60h-local-board.js',
  'rolling60h-local-store.js',
  'rolling60h-prefix-view.js',
  'rolling60h-summary-bridge.js',
  'rolling60h-ui.js',
  'tenko-transport-audit-success.js',
  // --- サーバー(render-webhook-server.js)/起動スクリプト(inject-tenko-audit.js)が index.html に注入するスクリプト ---
  'tenko-transport-audit.js',
  'ofk3-time-window-board.js',
  'gds-fleet-audit-core.js',
  'ofk3-gds-fleet-audit-ui.js',
  'harvest-core.js',
  'harvest-collectors-cortex.js',
  'harvest-collector-rolling60h.js',
  'ofk3-harvest-ui.js',
  'inoichi-core.js',
  'inoichi-detection-core.js',
  'inoichi-detection-rules.js',
  'inoichi-time-window-adapter.js',
  'inoichi-quality-dryrun.js',
  'inoichi-rolling-dryrun.js',
  'ofk3-inoichi-ui.js',
  // --- ブラウザ向けサードパーティ（自社配信。SheetJS 0.20.3） ---
  'vendor/sheetjs/xlsx-0.20.3.full.min.js',
  // --- CSS・画像・動画 ---
  'ofk3-ops-console.css',
  'assets/gion-ofk3-logo.png',
  'logo-cityact.png',
  'logo-flex.png',
  'logo-gds.png',
  'ofk3-splash.mp4',
  // --- 単独で公開するHTML（LINE等で共有されるURLのため維持） ---
  'route-map.html'
]);

var MAX_PATH_LENGTH = 512;

/**
 * リクエストのパス部分（クエリ除く・未デコード）を検査し、デコード後の照合キーを返す。
 * 危険な形は null（=拒否）。
 *  - 不正なパーセントエンコード / 二重エンコード（デコード後に再び %XX が残る）
 *  - NUL・制御文字・バックスラッシュ（%00 %5c を含む）
 *  - '.' / '..' / 空 / 末尾がドットか空白のセグメント（Windowsが無視する表記）
 *  - ':'（ドライブ指定・NTFS代替データストリーム）
 */
function normalizeRequestPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > MAX_PATH_LENGTH) return null;
  if (rawPath.charAt(0) !== '/') return null;
  var decoded;
  try { decoded = decodeURIComponent(rawPath); } catch (e) { return null; }
  if (/%[0-9a-fA-F]{2}/.test(decoded)) return null; // 二重エンコード
  if (/[\u0000-\u001f\u007f\\:]/.test(decoded)) return null;
  var segs = decoded.split('/').slice(1);
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i];
    if (s === '' || s === '.' || s === '..') return null;
    if (/[. ]$/.test(s)) return null;
  }
  return decoded;
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Expressミドルウェアを作る。
 * opts.root  : 公開元ディレクトリ（既定: このファイルのあるディレクトリ）
 * opts.files : 許可リスト（既定: PUBLIC_FILES。テスト用に差し替え可）
 */
function createStaticPublicPolicy(opts) {
  opts = opts || {};
  var root = path.resolve(opts.root || __dirname);
  var files = opts.files || PUBLIC_FILES;
  var table = new Map(); // '/vendor/x.js' → 'vendor/x.js'
  files.forEach(function (rel) {
    if (typeof rel !== 'string' || !rel || rel.charAt(0) === '/' || /(^|\/)\.\.?(\/|$)|[\\:\u0000]/.test(rel) || /[*?]/.test(rel)) {
      throw new Error('static-public-policy: invalid allowlist entry');
    }
    table.set('/' + rel, rel);
  });

  return function staticPublicPolicy(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // req.path は未デコードのパス部分（クエリ文字列は含まない → ?v=... のキャッシュバスターは維持される）
    var key = normalizeRequestPath(req.path);
    if (key === null) return next();
    var rel = table.get(key);
    if (!rel) return next();

    var expected = path.join.apply(path, rel.split('/'));
    var abs = path.join(root, expected);
    fs.realpath(root, function (eRoot, realRoot) {
      if (eRoot) return next();
      fs.realpath(abs, function (eFile, realFile) {
        if (eFile) return next(); // 存在しない等 → 静的配信せず後続へ
        // 実体が「許可リストのそのファイル」であること（シンボリックリンクで別ファイルを指す場合は拒否）
        if (!samePath(realFile, path.join(realRoot, expected))) return next();
        fs.stat(realFile, function (eStat, st) {
          if (eStat || !st.isFile()) return next();
          res.sendFile(rel, { root: realRoot, dotfiles: 'deny' }, function (err) {
            if (err && !res.headersSent) next();
          });
        });
      });
    });
  };
}

module.exports = {
  PUBLIC_FILES: PUBLIC_FILES,
  createStaticPublicPolicy: createStaticPublicPolicy,
  normalizeRequestPath: normalizeRequestPath
};
