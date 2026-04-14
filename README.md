# vibe-local-wasm

[ochyai/vibe-local](https://github.com/ochyai/vibe-local)（落合陽一氏による Free AI Coding Agent）の WASM 版です。

本家 `vibe-local` は Python stdlib only の単一ファイル (`vibe-coder.py`) で Ollama と直接通信するコーディングエージェントです。  
本リポジトリはそのコア機能を `agentOS + SQLite + sandbox-agent + AgentFS` の上に再実装し、バックエンドを WASM (Pyodide) 上でも動かせるようにすることを目指しています。

CLI/TUI の体験は本家 vibe-local に準拠します。本家にないコマンドや API は原則として実装しません。

## 現在の実装状況

この repository でいま主に使うのは **CLI/TUI** です。

- CLI
  - interactive `chat`
  - `/help` `/exit` `/clear`
  - `/status` `/compact`
  - `/model <name>`
  - `/plan` `/approve`
- runtime
  - vendored `vibe-coder.py` を Pyodide で実行
  - agentOS manager
  - actor-local SQLite persistence

後回しのままのもの:

- file watcher
- auto-test loop
- checkpoint / rollback

## Repository layout

- `vibe-local-pyodide/`
  - React + Vite の Web クライアント
  - Pyodide ベースの local fallback も含む
- `tools/agentos-dev/`
  - `agentOS` registry
  - actor runtime
  - CLI
  - sandbox wiring
  - AgentFS integration
- `bin/vibe-local-wasm.mjs`
  - standalone command entrypoint

## Default ports

- Web UI: `5374`
- Web preview: `4374`
- agentOS manager: `6520`
- sandbox-agent provider: `2568`

必要なら環境変数で上書きできます:

- `AGENTOS_PORT`
- `SANDBOX_AGENT_PORT`
- `VIBE_LOCAL_PORT`
- `SANDBOX_AGENT_LOG`

## Quick start

```bash
pnpm install
pnpm run dev
```

別ターミナルで CLI を使います。

```bash
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
vibe-local-wasm dev
vibe-local-wasm agentos
vibe-local-wasm chat vibe-local-pyodide --mode act
```

## Root scripts

```bash
pnpm run dev
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
```

interactive chat では次が使えます。

- `/help`
- `/clear`
- `/status`
- `/compact`
- `/model <name>`
- `/plan`
- `/approve`
- `/exit`

## Web UI behavior

Web UI は chat-first です。

- メイン画面は transcript と tool log が中心
- settings panel は開閉でき、状態は localStorage に保存
- backend settings は localStorage に保存
- 会話本体と session 状態は actor-local SQLite に保存
- selected session は必要時に詳細 hydrate される
- running task / running sub-agent があると自動追従で再取得する

Web から見える主要な操作:

- session 作成
- mode 切り替え
- approval
- compact
- export
- backend settings 保存
- model 一覧取得

## Model/backend settings

CLI の既定設定は `~/.config/opencode/config.json` から読みます。

現状の前提:

- OpenAI-compatible `/chat/completions` backend を使う
- model 一覧取得が使える backend だと UI の model refresh が有効

## Persistence

- actor state: `tools/agentos-dev/.agentos-dev/rivetkit`
- writable workspace: `tools/agentos-dev/.agentos-dev/workspace`
- AgentFS DB: `tools/agentos-dev/.agentos-dev/agentfs/workspace.db`
- Pi home mirror: `tools/agentos-dev/.agentos-dev/pi-agent`

## Internal architecture

ランタイムはざっくり次の 3 層です。

- `workspaceVm`
  - host toolkit と Pi を載せる
- `codingSandbox`
  - sandbox-agent を使う coding execution plane
- `vibeLocal` actor
  - sessions / messages / approvals / artifacts / sub-agents / task state を保持する

## Verification status

この repository では少なくとも次を通した状態で公開しています。

- `pnpm run check`
- `vibe-local-wasm help`
- `vibe-local-wasm chat vibe-local-pyodide --mode act`

## License

MIT
