# legacy/

Phase 3–4（2026-08）で **Legacy アプリコードは完全解体済み**。

| Phase | 内容 |
|-------|------|
| Phase 3 | git 追跡 Legacy 削除 + GAS 救出（`gas/`） |
| Phase 4 | untracked 残存物の仕分け + `legacy/delivery-app/` 物理削除 |

## 復元（Git 履歴）

| 内容 | コマンド |
|------|----------|
| git 追跡 Legacy 一式 | `git checkout fee7420 -- legacy/delivery-app` |
| GAS 削除前 | `git checkout ec32c45^ -- gas/` |

## 正本

| 用途 | パス |
|------|------|
| **Production** | [`../index.html`](../index.html) |
| **Demo** | [`../demo-app/`](../demo-app/) |
| **GAS source** | [`../gas/`](../gas/) |
| **LAT fixtures** | [`../tests/fixtures/lat-verify/`](../tests/fixtures/lat-verify/) |

詳細: [`../docs/PRODUCTION-ENTRY.md`](../docs/PRODUCTION-ENTRY.md)
