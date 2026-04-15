# tui-foundation / Phase 8 architecture docs alignment

Created: 2026-04-14
Branch: feature/tui-foundation
Status: Awaiting Review

## 📌 Attention Required

| # | Item | Question/Note |
|---|------|---------------|
| 1 | Docs alignment | README / CLAUDE / runtime README を「Wasm/agentOS = control plane」「sandbox = execution plane」に合わせて更新 |
| 2 | Mapping rewrite | `docs/wasm-compat-mapping.md` を現状と目標アーキテクチャの差分が分かる内容へ全面更新 |
| 3 | Handoff plan | 別 AI に渡せる詳細ロードマップを `.plan/wasm-control-plane-roadmap.md` として新設 |

---

## 🔄 User Request ⇄ Response (修正依頼と対処)

| # | User Request (原文) | Response (対処内容) | 検証方法 |
|---|---------------------|---------------------|----------|
| 1 | 「今のソースベースのドキュメントやREADMEルール等で、今のあなたの意見と違う部分はすべて書き換えてください。また、…ちゃんとこのリポジトリの下にドットプランとして作成してほしいです。 `.plan/`」 | Phase 8 として docs を control-plane / execution-plane 方針に揃え、`.plan/wasm-control-plane-roadmap.md` を追加した。 | `pnpm run check` / `pnpm run build` / `pnpm run smoke` |

---

## 📋 Previous Feedback Response (累積フィードバック履歴)

<details open>
<summary><strong>Latest: 2026-04-14</strong></summary>

| Feedback | Status | How Addressed |
|----------|--------|---------------|
| 「今のソースベースのドキュメントやREADMEルール等で、今のあなたの意見と違う部分はすべて書き換えてください。… `.plan/`」 | ✅ Done | root / repo / runtime docs を control-plane / execution-plane の説明に統一し、別 AI 向けの詳細ロードマップを `.plan/wasm-control-plane-roadmap.md` に追加した |
| 「なんかうまく言ってないです。fetchができてない模様。」 | ✅ Done | `WebFetch` が Shift_JIS ページを読めず推測回答に流れていた問題を修正し、青空文庫 URL で `二百十日 / 夏目漱石` を返すところまで確認した |

</details>

---

## Context

- 既存 handoff REPORT の次段として Phase 8 を実施
- フェーズ完了条件は「動作確認のあとにコミット」
- 直前の対話で、目標アーキテクチャは「全部 Wasm」ではなく「Wasm/agentOS が trusted control plane、外部 sandbox は非WASM task の execution plane」であると明確化された
- docs と handoff material がその方針に追随できていなかった

## Plan

- [x] `README.md` / `CLAUDE.md` / `tools/agentos-dev/README.md` を control-plane / execution-plane 方針に揃える
- [x] `docs/wasm-compat-mapping.md` を全面更新し、current state と target state を分離して説明する
- [x] 別 AI 向け handoff plan を `.plan/wasm-control-plane-roadmap.md` に追加する
- [x] `pnpm run check` / `pnpm run build` / `pnpm run smoke` で確認する

## Evidence

### 変更ファイル

| File | Change |
|------|--------|
| `README.md` | root overview に control-plane / execution-plane 方針を追加し、残課題の優先度説明を更新 |
| `CLAUDE.md` | repo guidance を trusted core / external execution plane の原則に合わせて更新 |
| `tools/agentos-dev/README.md` | runtime package の設計原則を control plane / execution plane で整理 |
| `docs/wasm-compat-mapping.md` | stale な phase-centric 文書を置き換え、現在地と目標のマッピングへ再構成 |
| `.plan/wasm-control-plane-roadmap.md` | 別 AI 向けの詳細な今後の実装計画を追加 |

### Logs

| Kind | File |
|------|------|
| Phase 1 validation log | [`./test-results.txt`](./test-results.txt) |
| Phase 2 validation log | [`./phase2-test-results.txt`](./phase2-test-results.txt) |
| Phase 3 validation log | [`./phase3-test-results.txt`](./phase3-test-results.txt) |
| Phase 4 validation log | [`./phase4-test-results.txt`](./phase4-test-results.txt) |
| Phase 5 validation log | [`./phase5-test-results.txt`](./phase5-test-results.txt) |
| Phase 6 validation log | [`./phase6-test-results.txt`](./phase6-test-results.txt) |
| Phase 7 validation log | [`./phase7-test-results.txt`](./phase7-test-results.txt) |
| Phase 8 validation log | [`./phase8-test-results.txt`](./phase8-test-results.txt) |
| Diff stat | [`./diff-stat.txt`](./diff-stat.txt) |
| Git status | [`./git-status.txt`](./git-status.txt) |

### Test Results

```bash
# Command executed
pnpm run check
pnpm run build
pnpm run smoke

# Result
pnpm run check         -> passed
pnpm run build         -> passed
pnpm run smoke         -> passed
```

### Verification Checklist

- [x] Build: `pnpm run build` passed
- [x] Type check: `pnpm run check` passed
- [x] Docs describe the Wasm/agentOS control plane explicitly
- [x] `docs/wasm-compat-mapping.md` reflects the current and target architecture
- [x] `.plan/wasm-control-plane-roadmap.md` exists in the repo root
- [x] Smoke test still passes after docs/plan changes
- [x] Evidence logs saved under `.artifacts/tui-foundation/`

<details>
<summary>Detailed verification logs (collapsed)</summary>

#### Validation Logs
See `./test-results.txt`, `./phase2-test-results.txt`, `./phase3-test-results.txt`, `./phase4-test-results.txt`, `./phase5-test-results.txt`, `./phase6-test-results.txt`, `./phase7-test-results.txt`, and `./phase8-test-results.txt`.

#### Diff Summary
See `./diff-stat.txt`.

</details>

### How to Reproduce

```bash
pnpm install
pnpm run check
pnpm run build
pnpm run smoke
```

## Notes

- 今回の docs 更新は、実装現状を偽らず、同時に長期目標も誤解なく伝えるためのもの
- `.plan/wasm-control-plane-roadmap.md` は別 AI が prior chat なしで続きから入れる粒度を狙っている
- file watcher / auto-test / MCP / `/undo` は依然として今後の quality / parity work
