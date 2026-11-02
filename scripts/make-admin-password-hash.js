#!/usr/bin/env node
// 使い方: node scripts/make-admin-password-hash.js   (パスワードを標準入力で受け取り、ハッシュだけを表示)
// 出力した値を Render の環境変数 ADMIN_PASSWORD_HASH に手動で設定する。パスワード自体は保存・表示しない。
'use strict';
var AdminSession = require('../admin-session.js');
var chunks = [];
process.stdin.on('data', function (c) { chunks.push(c); });
process.stdin.on('end', function () {
  var pw = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (pw.length < 12) { console.error('パスワードは12文字以上にしてください。'); process.exit(1); }
  console.log(AdminSession.hashPassword(pw));
});
