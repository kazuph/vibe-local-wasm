# agentOS Hybrid Dev Runtime

このディレクトリは `vibe-local-wasm` 用の開発オーケストレーション層です。現行の主経路は CLI/TUI で、ここが actor runtime / registry / CLI をまとめて提供します。

## 何をしているか

- `workspaceVm`: `agentOS` 上で Pi と host toolkits を動かす高速な VM
- `codingSandbox`: `sandbox-agent` を `local` provider 経由で起動する coding agent 実行面
- `vibeLocal`: CLI と旧 Web UI の session / transcript を actor-local SQLite に保存する actor
- repo 全体を `agentOS` に read-only mount し、host 側で project discovery と script 実行を補助

## 重要な前提

- root の `package.json` と `pnpm-workspace.yaml` は monorepo 管理とこのランタイムの起動導線のためにあります
- 既存プロジェクトの install / build / deploy 手順は引き続き各 project 直下が正です
- root からは `pnpm --filter` で `agentOS` ランタイムだけを叩けます
- 既存アプリの lockfile は残したままですが、今後 root からの操作は `pnpm` を基準にします

## 使い方

```bash
pnpm run doctor
pnpm run agentos
```

project を開く（debug / inspection 用）:

```bash
pnpm agentos:open -- --project vibe-local-pyodide
pnpm agentos:open -- --project vibe-local-pyodide --surface workspace
pnpm agentos:open -- --project vibe-local-pyodide --surface sandbox --agent codex
```

CLI からは project selector を渡して使う:

```bash
pnpm run agentos
pnpm run cli -- chat vibe-local-pyodide --mode act
pnpm run cli -- chat vibe-local-pyodide --mode plan
```

CLI からは同じ `vibeLocal` actor を直接叩き、会話・compact artifact・task state が actor-local SQLite に保存されます。

## vibe-local parity の優先順位

この repo で `vibe-local` 互換を広げるときは、次の 3 点を必須の優先項目として扱います。

1. ツール実行の強化
2. `Plan / Act / approve` フロー
3. サブエージェント / 並列エージェント

次は採用しません。

- checkpoint / rollback

次は後回しです。

- file watcher
- auto-test loop

## 環境変数

- `AGENTOS_PORT`: Rivet manager の listen port。既定値 `6520`
- `SANDBOX_AGENT_PORT`: local sandbox-agent provider の port。既定値 `2568`
- `SANDBOX_AGENT_LOG`: `inherit | pipe | silent`
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` など: sandbox-agent 側へ引き継ぐ

## mount

- repo: `/mnt/repo` -> monorepo root, read-only
- workspace: `/mnt/workspace` -> `tools/agentos-dev/.agentos-dev/workspace`, read-write
- pi agent home: `/home/user/.pi/agent` -> `tools/agentos-dev/.agentos-dev/pi-agent`, read-write

## vibeLocal actor

- actor key は `["browser-core"]`
- 保存テーブルは `sessions`, `messages`, `artifacts`
- 旧 Web UI を使う場合は `vibe-local-pyodide` 側の Vite middleware からも同じ actor を叩けますが、現行の主経路は CLI です
- browser 側の localStorage / sql.js は archived web surface の話で、CLI path では actor-local SQLite が主経路です
- `tools/agentos-dev/.agentos-dev/workspace` は引き続き host filesystem を正とし、AgentFS はその mirror / audit layer として並行保存します
