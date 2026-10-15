# INO-1 タスクバーアイコン

INO-1（人間道）の Windows タスクバー用アイコンです。検知ロジック、OFK3 本体、HARVEST ローカルアプリは変更しません。

## 現在の起動方式

`main` の INO-1 は OFK3 に読み込まれる検知モジュールです。独立した HTTP アプリ、PWA、`inoichi-launch.ps1` はありません。このチェックアウトだけではタスクバーから INO-1 単体を起動できません。

HARVEST は `harvest-local-server.js`（127.0.0.1:3100）と `assets/harvest.ico` を使います。INO-1 の手順は HARVEST を起動せず、HARVEST のファイルも書き換えません。

## ファイル

| ファイル | 内容 |
| --- | --- |
| `assets/inoichi-taskbar.ico` | Windows 用。16 / 24 / 32 / 48 / 64 / 128 / 256px |
| `assets/inoichi-taskbar-192.png` | 192×192 PNG |
| `assets/inoichi-taskbar-512.png` | 512×512 PNG |
| `assets/inoichi-taskbar-source.png` | 添付原画を PNG で保存したもの |

メイン画面用ロゴとは別ファイルです。`assets/inoichi-logo.png` と `assets/inoichi.ico` は作りません。

## ショートカット

このチェックアウトに起動スクリプトが無い場合、次のコマンドはショートカットを作らず終了します。

```powershell
powershell -ExecutionPolicy Bypass -File inoichi-taskbar-shortcut.ps1
```

Prototype 1 のように `inoichi-launch.ps1` がある別のチェックアウトを指すときだけ、デスクトップにショートカットを作ります。

```powershell
powershell -ExecutionPolicy Bypass -File inoichi-taskbar-shortcut.ps1 `
  -LaunchScript "C:\path\to\inoichi-launch.ps1" `
  -StopScript "C:\path\to\inoichi-stop.ps1"
```

- 既存の `.lnk` は、ターゲットが `powershell.exe` で、引数に指定スクリプトのフルパスが含まれるときだけアイコンを更新します。
- それ以外の同名ファイルは残し、`INO-1 起動(1).lnk` のように別名で作成します。
- スクリプトはサーバーを起動せず、タスクバーのピン留めもしません。

## タスクバーへの固定

デスクトップにできた「INO-1 起動」を右クリックし、「タスクバーにピン留めする」を自分で行ってください。ピン留めできない場合は、スタートメニューへピン留めしてからタスクバーへ移します。

## PWA

INO-1 用の web manifest はありません。この変更では追加しません。

## 確認

```powershell
npm run test:inoichi
node tests/inoichi-taskbar-icon.test.mjs
```

`npm run test:inoichi` の対象は従来の検知テストのままです。アイコンとショートカットの確認は別コマンドです。
