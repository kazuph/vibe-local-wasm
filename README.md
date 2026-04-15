# vibe-local-wasm

[ochyai/vibe-local](https://github.com/ochyai/vibe-local)（落合陽一氏による Free AI Coding Agent）の WASM 版です。

本家 `vibe-local` は Python stdlib only の単一ファイル (`vibe-coder.py`) で Ollama と直接通信するコーディングエージェントです。  
本リポジトリはそのコア機能を `agentOS + SQLite + sandbox-agent + AgentFS` の上に再実装し、バックエンドを WASM (Pyodide) 上でも動かせるようにすることを目指しています。現時点で主に整備されているのは **CLI/TUI path** です。

## Architecture direction

この repo の目標は **「全部を無理に Wasm に押し込む」ことではなく、Wasm/agentOS を trusted control plane にし、Wasm で動かない処理だけを外部 sandbox に委譲すること** です。

- **Wasm / agentOS 側**
  - セッション状態
  - 認可と監査
  - tool routing
  - capability 判定
  - 可能な範囲の file / web / structured tool execution
- **外部 sandbox 側**
  - Wasm / Workers では扱いづらい処理
  - 任意 Bash / subprocess
  - 言語ランタイム依存の build / test
  - 将来の MCP server spawn など

つまり、外部 sandbox は **execution plane** であり、主導権は常に agentOS / Wasm 側に残します。

明示的な sandbox 委譲クラスは `docs/sandbox-contract.md` で固定しています。

CLI/TUI の体験は本家 vibe-local に準拠します。本家にないコマンドや API は原則として実装しません。

## 現在の実装状況

この repository でいま主に使うのは **CLI/TUI** です。

- CLI
  - interactive `chat`
  - `/help` `/exit` `/clear` `/save`
  - `/status` `/tokens` `/config` `/compact`
  - `/model <name>` `/models`
  - `/plan` `/approve` `/yes`
  - `/diff` `/git <args>` `/commit`
  - `/checkpoint` `/rollback`
  - `/autotest` `/watch` `/skills` `/init`
- runtime
  - vendored `vibe-coder.py` を Pyodide で実行
  - agentOS manager
  - actor-local SQLite persistence
  - JS bridge for `WebSearch` / `NotebookEdit` / `Task*` / `AskUserQuestion`

実装済みの CLI quality gap:

- `/watch`
- `/autotest`
- `/undo`

次の主要ロードマップ:

- explicit sandbox contract
- virtual workspace model
- MCP layering

## Repository layout

- `tools/agentos-dev/`
  - `agentOS` registry
  - actor runtime
  - CLI
  - sandbox wiring
  - AgentFS integration
- `bin/vibe-local-wasm.mjs`
  - standalone command entrypoint
- `vibe-local-pyodide/`
  - 以前の Web UI 実験実装
  - 現在の root workspace / root scripts の主経路には含めていない

## Active ports

- agentOS manager: `6520`
- sandbox-agent provider: `2568`

必要なら環境変数で上書きできます:

- `AGENTOS_PORT`
- `SANDBOX_AGENT_PORT`
- `SANDBOX_AGENT_LOG`

## Quick start

```bash
pnpm install
pnpm run cli -- chat vibe-local-pyodide --mode act
```

## Standalone command

この repository を clone したあと:

```bash
pnpm link --global
```

これで `vibe-local-wasm` コマンドが使えます。

例:

```bash
vibe-local-wasm agentos
vibe-local-wasm chat vibe-local-pyodide --mode act
vibe-local-wasm chat --list-sessions
vibe-local-wasm --version
```

## Root scripts

```bash
pnpm run agentos
pnpm run start:agentos
pnpm run check
pnpm run build
pnpm run doctor
pnpm run smoke
```

## CLI commands

`vibe-local-wasm cli ...` または `pnpm run cli -- ...` で使えます。

```bash
vibe-local-wasm cli chat vibe-local-pyodide --mode act
pnpm run cli -- chat vibe-local-pyodide --mode plan
pnpm run cli -- chat vibe-local-pyodide --prompt "Reply with exactly OK."
pnpm run cli -- chat --resume --debug
pnpm run cli -- chat --session-id 51d137c1 --debug
pnpm run cli -- chat --list-sessions
pnpm run cli -- --version
```

interactive chat では次が使えます。

- `/help`
- `/clear`
- `/save`
- `/status`
- `/tokens`
- `/config`
- `/compact`
- `/model <name>`
- `/models`
- `/plan`
- `/approve`
- `/yes`
- `/diff`
- `/git <args>`
- `/commit`
- `/undo`
- `/checkpoint`
- `/rollback`
- `/autotest`
- `/watch`
- `/skills`
- `/init`
- `/exit`

## Model/backend settings

CLI の既定設定は `~/.config/opencode/config.json` から読みます。

現状の前提:

- OpenAI-compatible `/chat/completions` backend を使う
- model 一覧取得が使える backend だと `/models` が有効

## Persistence

- actor state: `tools/agentos-dev/.agentos-dev/rivetkit`
- writable workspace: `tools/agentos-dev/.agentos-dev/workspace`
- AgentFS DB: `tools/agentos-dev/.agentos-dev/agentfs/workspace.db`
- Pi home mirror: `tools/agentos-dev/.agentos-dev/pi-agent`

## Internal architecture

ランタイムはざっくり次の 3 層です。

- `vibeLocal` actor
  - trusted control plane
  - sessions / messages / approvals / artifacts / sub-agents / task state を保持する
- `workspaceVm`
  - capability-oriented workspace surface
  - host toolkit と Pi を載せる
- `codingSandbox`
  - Wasm では扱いづらい処理だけを逃がす external execution plane

関連文書:

- `docs/sandbox-contract.md`
- `docs/mcp-layering.md`
- `docs/workspace-model.md`
- `docs/wasm-compat-mapping.md`

## Archived web surface

`vibe-local-pyodide/` には React + Vite ベースの Web UI 実装が残っていますが、現行の root workspace / root scripts / 検証導線は CLI-first です。Web 側は参照用・将来の整理対象として repo に残してあり、現フェーズではアクティブな提供面として扱っていません。

## Verification status

この repository では少なくとも次を通した状態で公開しています。

- `pnpm run check`
- `vibe-local-wasm help`
- `vibe-local-wasm chat vibe-local-pyodide --mode act`

## License

MIT
