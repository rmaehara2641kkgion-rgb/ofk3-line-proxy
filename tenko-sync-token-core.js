/**
 * OFK3 点呼同期キー — トークン正規化・fingerprint計算コア（DOM非依存の純粋関数のみ）
 *
 * render-webhook-server.js（TENKO_SYNC_TOKENの読み込み・/tenko-syncの認証・
 * /tenko-sync/statusのfingerprint応答）から利用する。index.html側は同じ正規化仕様
 * （trim()のみ・前後除去のみ）をブラウザ内で個別に実装する（Web Crypto APIの都合上、
 * fingerprint計算自体は非同期になるためこのファイルをそのまま読み込んではいない。
 * 他のOFK3の *-core.js ファイル同様、index.html側の実装はこのファイルの仕様と
 * 一致させることを前提にコメントで明記している）。
 *
 * ここでの「正規化」は意図的に最小限に留めている：
 *   - String.prototype.trim() で前後の空白文字だけを除去する。trim()はECMAScript仕様上、
 *     半角スペース・タブ・改行(CR/LF)に加え、全角スペース(U+3000)等のUnicode空白文字も
 *     前後から取り除く。
 *   - トークン内部の文字（内部に空白が含まれる場合も含む）は一切変更しない。
 *     これは「Render環境変数への貼り付け事故（末尾改行・前後空白）」を吸収するためだけの
 *     ものであり、既存の運用中tokenとの後方互換性を壊さないことを最優先にしている。
 *
 * fingerprint仕様: 正規化後の文字列のSHA-256ハッシュの先頭12桁(hex)のみを使用する。
 * トークン本体を推測できる情報は一切含まない（呼び出し側は絶対にtoken本体をログ・
 * レスポンスへ含めないこと）。
 */
'use strict';

var nodeCrypto = null;
try { nodeCrypto = require('crypto'); } catch (e) { nodeCrypto = null; }

// 前後の空白（半角・全角・CR/LF等）だけを除去する。トークン内部は変更しない。
function normalizeSyncToken(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

// 正規化後の文字列からSHA-256の先頭12桁(hex)を返す。空文字/未設定はnull。
// Node専用（サーバー側のみで使用。ブラウザ側はWeb Crypto APIで別途計算する）。
function tokenFingerprint(token) {
  if (!nodeCrypto) throw new Error('tokenFingerprint requires Node crypto module');
  var normalized = normalizeSyncToken(token);
  if (!normalized) return null;
  return nodeCrypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
}

var TenkoSyncTokenCore = {
  normalizeSyncToken: normalizeSyncToken,
  tokenFingerprint: tokenFingerprint
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TenkoSyncTokenCore;
}
