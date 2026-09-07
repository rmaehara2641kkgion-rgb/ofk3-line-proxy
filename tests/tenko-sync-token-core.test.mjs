import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const TenkoSyncTokenCore = require('../tenko-sync-token-core.js');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

function runNormalizeTests() {
  var n = TenkoSyncTokenCore.normalizeSyncToken;

  // E: 前後の半角空白
  assert(n('  abc123  ') === 'abc123', 'trims leading/trailing regular spaces');
  // F: 改行付きpaste（末尾）
  assert(n('abc123\n') === 'abc123', 'trims trailing LF');
  assert(n('\r\nabc123\r\n') === 'abc123', 'trims leading/trailing CRLF');
  // 全角空白
  assert(n('　abc123　') === 'abc123', 'trims leading/trailing full-width space (U+3000)');
  // 混在
  assert(n('  \n　abc123　\n  ') === 'abc123', 'trims mixed whitespace types together');
  // I: 内部の文字は変更しない（内部空白があってもそのまま）
  assert(n('  abc 123  ') === 'abc 123', 'internal characters (including internal space) are preserved untouched');
  // 空文字/空白のみ
  assert(n('') === '', 'empty string stays empty');
  assert(n('   ') === '', 'whitespace-only becomes empty');
  assert(n('\n　 \t') === '', 'mixed whitespace-only becomes empty');
  // 非文字列
  assert(n(null) === '', 'null -> empty string, no throw');
  assert(n(undefined) === '', 'undefined -> empty string, no throw');
  // 既に正規化済み
  assert(n('abc123') === 'abc123', 'already-clean token is unchanged');

  console.log('tenko-sync-token-core.test.mjs: normalizeSyncToken tests passed');
}

function runFingerprintTests() {
  var fp = TenkoSyncTokenCore.tokenFingerprint;

  // S: fingerprintからtoken本体が推測できない
  var token = 'super-secret-tenko-token-value-123';
  var f1 = fp(token);
  assert(typeof f1 === 'string' && f1.length === 12, 'fingerprint is a 12-char hex string, got: ' + f1);
  assert(/^[0-9a-f]{12}$/.test(f1), 'fingerprint is lowercase hex only: ' + f1);
  assert(token.toLowerCase().indexOf(f1) === -1, 'fingerprint does not literally contain the token');

  // 決定論的（同じ入力 -> 同じ出力）
  assert(fp(token) === f1, 'fingerprint is deterministic for the same token');

  // 異なるtoken -> 異なるfingerprint
  var f2 = fp(token + 'X');
  assert(f2 !== f1, 'different tokens produce different fingerprints');

  // G/H: 前後の空白付きtokenは正規化後と同じfingerprintになる（client/server仕様一致の裏付け）
  assert(fp('  ' + token + '\n') === f1, 'fingerprint is computed on the normalized token (whitespace-insensitive at the edges)');

  // 空/未設定
  assert(fp('') === null, 'empty token -> null fingerprint');
  assert(fp('   ') === null, 'whitespace-only token -> null fingerprint');

  console.log('tenko-sync-token-core.test.mjs: tokenFingerprint tests passed');
}

runNormalizeTests();
runFingerprintTests();
