# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

[ochyai/vibe-local](https://github.com/ochyai/vibe-local)（落合陽一氏の Free AI Coding Agent）の WASM 版。

本家 `vibe-local` は Python stdlib only の単一ファイル (`vibe-coder.py`, ~7400行) で Ollama と直接通信するコーディングエージェント。本リポジトリはそのコア機能を以下の上に再実装している:

- **agentOS**: Trusted control plane for workspace virtualization, policy, auditing, and tool routing
- **AgentFS**: Filesystem mirroring/audit layer backed by SQLite
- **sandbox-agent**: External execution plane for non-WASM / non-Workers-compatible tasks
- **Pyodide (WASM)**: 本家 `vibe-coder.py` (~8200行) をそのまま WASM 上で実行（CLI `chat` の既定実行経路）
- **sql.js (WASM)**: 旧 Web UI 側に残る browser persistence layer（現行の主経路ではない）

## 本家 vibe-local との関係

**CLI/TUI の体験は本家 vibe-local に準拠する。本家にないコマンドや API は実装しない。**

本家の主要機能:
- 16 built-in tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, NotebookEdit, SubAgent, ParallelAgents, TaskCreate/List/Get/Update, AskUserQuestion
- 対話コマンド: /help, /exit, /clear, /model, /models, /status, /save, /compact, /tokens, /undo, /config, /commit, /diff, /git, /plan, /approve, /checkpoint, /rollback, /autotest, /watch, /skills, /init, /yes
- CLI flags: --prompt/-p, --model/-m, --yes/-y, --debug, --resume, --session-id, --list-sessions, --ollama-host, --max-tokens, --temperature, --context-window, --version
- DECSTBM 固定フッター、ESC 割り込み、Plan/Act モード、Git チェックポイント
- MCP 連携、スキルシステム、auto-test、file watcher

本リポジトリの差分:
- バックエンドが agentOS + sandbox-agent（本家は Ollama 直接通信）
- セッション永続化が actor-local SQLite（本家は JSONL）
- 旧 Web UI 実装が repo には残るが、現行の主経路は CLI/TUI

## Target architecture principle

この repo の目標は **all-WASM を名目化することではなく、WASM/agentOS を trusted core にし、WASM で扱えない処理だけを外部 sandbox に出すこと** です。

- **control plane (trusted core)**: agentOS actor, Pyodide runtime, policy, audit, session state, tool routing
- **execution plane (less-trusted)**: `codingSandbox` などの外部 sandbox。Bash / subprocess / build / test / MCP server spawn のような非WASM処理を担当
- **design rule**: 状態管理・認可・監査・オーケストレーションは agentOS 側に残し、sandbox には主導権を渡さない

## Pyodide ランタイム（実装済み）

本家 `vibe-coder.py` (8221行) を Pyodide (WASM) にロードし、**agentOS actor.runAgentTurn** 経由で実行する。

### 起動方法

CLI `chat` は Pyodide 経由 (vibe-coder.py) で動く:

```bash
pnpm run cli -- chat vibe-local-pyodide --mode yolo
```

### 実行経路

```
CLI → actor.runAgentTurn(prompt)
        ↓
     persistMessage(user)                     [actor DB]
        ↓
     executePyodideAgentTurn
        ↓
     pyodideRunAgentTurn(messages, settings)  [pyodide-runtime.ts]
        ↓
     Pyodide WASM
        ├── vibe-coder.py OllamaClient.chat()
        │     └── urllib.request → JS curl bridge → LLM
        └── vibe-coder.py ToolRegistry
              └── tool.execute → _js_tool_dispatch → JS (Bash/Read/Write/Glob/Grep/WebFetch)
        ↓
     tool events + final response → actor
        ↓
     persistAgentToolEvent / persistMessage / saveTaskState  [actor DB]
        ↓
     return AgentTurnResult                   → CLI
```

### 主要ファイル

- `tools/agentos-dev/src/pyodide-runtime.ts` — Pyodide 初期化、ブリッジ、`pyodideRunAgentTurn`/`pyodideChat`/`pyodideToolCallViaBridge` API
- `tools/agentos-dev/src/pyodide-core/vibe-coder.py` — 本家 ochyai/vibe-local、8221行 **無改変**
- `tools/agentos-dev/src/vibe-local-actor.ts::executePyodideAgentTurn` — actor からの橋渡し

### Pyodide で動かすためのパッチ（全て runtime の `py.runPython` で実行時注入）

| 対象 | 内容 |
|------|------|
| `urllib.request.urlopen` | `curl` execSync JS bridge で同期HTTP |
| `subprocess.run/check_output/Popen` | `child_process.execFileSync` JS bridge、Popen は同期シム |
| `os.getpgid/killpg` | no-op（Popen シムのクリーンアップ互換用） |
| `OllamaClient._native_to_openai_response` | OpenAI-format レスポンス pass-through（llama.cpp/vLLM 互換） |
| `OllamaClient._prepare_messages_for_native` | tool_call に `type: "function"` を保持（llama.cpp が要求） |
| `ToolRegistry._tools[*].execute` | 全ツールの execute を `_js_tool_dispatch` にバインド（Option C: JS bridge 経由） |

### ブリッジ経由のツール (`_js_tool_dispatch`)

`Bash` / `Read` / `Write` / `Edit` / `Glob` / `Grep` / `WebFetch` / `WebSearch` / `NotebookEdit` / `TaskCreate` / `TaskList` / `TaskGet` / `TaskUpdate` / `AskUserQuestion` / `SubAgent` / `ParallelAgents` は JS bridge 経由で処理される。`SubAgent` と `ParallelAgents` は bridge 側の mini-agent loop と worker coordination で実装している。

### パフォーマンス

- 初回ロード: ~1.5 秒（Pyodide 起動 + sqlite3 パッケージ + vibe-coder.py パース）
- 以後はプロセス内キャッシュ（`pyPromise` シングルトン）
- 単純な1ツール agent turn: ~2秒（LLM 2 iter + tool 実行）
- multi-tool (Glob + Read + 要約): ~5秒 (3 iter)

## Monorepo Structure

Two pnpm workspace packages:

| Package | Path | Description |
|---------|------|-------------|
| `@vibe-local-wasm/agentos` | `tools/agentos-dev/` | Actor runtime, CLI, agentOS registry, sandbox wiring, AgentFS |

Root `bin/vibe-local-wasm.mjs` is the standalone CLI entrypoint.

## Commands

```bash
# Install
pnpm install

# Development
pnpm run dev

# Individual server
pnpm run agentos          # agentOS manager only (dev mode with watch)

# Type check CLI/runtime package
pnpm run check

# Build CLI/runtime package
pnpm run build

# Diagnostics and self-check
pnpm run doctor
pnpm run smoke

# CLI (two equivalent forms)
pnpm run cli -- <command>
vibe-local-wasm cli <command>    # after pnpm link --global

# CLI
pnpm run cli -- chat vibe-local-pyodide --mode act
```

## Architecture (CLI-first)

```
CLI → vibeLocal actor → Pyodide runtime → agentOS Manager surfaces
                                 ├── workspaceVm (capability-oriented workspace surface)
                                 └── codingSandbox (external execution plane for non-WASM tasks)
```

- **vibeLocal actor**: Actor key `["browser-core"]` のまま使っているが、現在の主利用者は CLI。trusted control plane として sessions / messages / approvals / artifacts / sub-agents / task state を SQLite に保存する。
- **workspaceVm**: Mounts repo read-only at `/mnt/repo`, writable workspace at `/mnt/workspace`. Current capability surface for repo inspection, git, code search, and bounded script execution.
- **codingSandbox**: Runs coding agents via `sandbox-agent` local provider. Use it only for work that cannot stay inside the Wasm / Workers-compatible core.

## Archived web integration

`vibe-local-pyodide/vite.config.ts` には旧 Web UI 用の Vite middleware が残っている。`/__vibe_local/*` ルート群や browser persistence はこの実装に属するが、現行の root workspace / root scripts / 検証導線では主経路として扱っていない。

## Persistence

| Layer | Storage | Location |
|-------|---------|----------|
| Actor state (sessions, messages) | SQLite via RivetKit | `tools/agentos-dev/.agentos-dev/rivetkit/` |
| Workspace files | Host filesystem | `tools/agentos-dev/.agentos-dev/workspace/` |
| AgentFS mirror/audit | SQLite | `tools/agentos-dev/.agentos-dev/agentfs/workspace.db` |
| Browser fallback state (archived web) | localStorage / IndexedDB via sql.js | `vibe-local-pyodide/` side only |

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTOS_PORT` | `6520` | agentOS manager listen port |
| `AGENTOS_ENDPOINT` | `http://127.0.0.1:6420` | RivetKit client endpoint (used in vite.config.ts) |
| `SANDBOX_AGENT_PORT` | `2568` | sandbox-agent provider port |
| `SANDBOX_AGENT_LOG` | — | `inherit` / `pipe` / `silent` |
| `OPENAI_API_KEY` | — | Forwarded to sandbox-agent |
| `ANTHROPIC_API_KEY` | — | Forwarded to sandbox-agent |
| `AGENTOS_DEBUG` | — | Enable debug logging |

## Key Source Files

| File | Role |
|------|------|
| `tools/agentos-dev/src/vibe-local-actor.ts` | Main actor: all session/message/approval/sub-agent logic |
| `tools/agentos-dev/src/vibe-local-cli.ts` | CLI commands: chat and the core interactive slash commands |
| `tools/agentos-dev/src/registry.ts` | agentOS manager setup (workspaceVm + codingSandbox) |
| `tools/agentos-dev/src/agentfs.ts` | AgentFS integration |
| `tools/agentos-dev/src/toolkits.ts` | Host toolkits (repo, git, code search) |
| `tools/agentos-dev/src/projects.ts` | Project discovery via package.json walking |
| `tools/agentos-dev/src/server.ts` | RivetKit manager startup |
| `vibe-local-pyodide/` | Archived web UI implementation retained in the repo but outside the active root workspace |

## Design Decisions

- **本家準拠**: CLI/TUI のコマンド体系は ochyai/vibe-local に準拠。本家にない独自コマンドは追加しない。
- **Actor-local SQLite for conversations**: 現行の CLI path では会話本体も設定読み出しも host/actor 側を主に使う。
- **Wasm-first control plane**: policy / audit / orchestration は agentOS + Pyodide 側に置き、非WASM処理だけを external sandbox に委譲する。
- **AgentFS is a mirror/audit layer**: 現状は host filesystem が source of truth だが、長期的には capability-mediated workspace を厚くしていく。
- **Execution modes**: Plan / Act（本家準拠）。YOLO は本家の `--yes` フラグに相当。
- **本家で実装済みだがこちらで未実装**: file watcher, auto-test loop, MCP連携, `/undo`

## Technology Stack

- **Runtime**: Node.js (ESM), TypeScript, tsx
- **Package manager**: pnpm 10.18.3 (workspaces)
- **Frontend (archived web only)**: React 19, Vite 7, sql.js, react-markdown, lucide-react
- **Backend**: RivetKit 2.2.1, rivet agent-os packages, sandbox-agent 0.4.2, agentfs-sdk, Zod 4
- **Testing**: Playwright (E2E), smoke/doctor scripts
- **WASM**: sql.js provides in-browser SQLite via WASM (no custom WASM compilation needed)
