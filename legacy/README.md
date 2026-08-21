# legacy/

Phase 3（2026-08）で **git 追跡済み Legacy コード（`legacy/delivery-app/*.html`, `*.js`, tests）は削除済み**。

## 現在の状態

| 内容 | 状態 |
|------|------|
| git 追跡 Legacy アプリコード | **削除済み**（`git rm`） |
| `legacy/delivery-app/` 配下 untracked | **ローカルに残存**（バックアップ・サンプル・旧 GAS コピー等）。Phase 3 では物理削除していない |

復元: `git checkout fee7420 -- legacy/delivery-app`（削除直前 SHA）

## 正本

| 用途 | パス |
|------|------|
| **Production** | [`../index.html`](../index.html) |
| **Demo** | [`../demo-app/`](../demo-app/) |
| **GAS source** | [`../gas/`](../gas/) |

詳細: [`../docs/PRODUCTION-ENTRY.md`](../docs/PRODUCTION-ENTRY.md)
