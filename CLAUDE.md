# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

[ochyai/vibe-local](https://github.com/ochyai/vibe-local)（落合陽一氏の Free AI Coding Agent）の WASM 版。

本家 `vibe-local` は Python stdlib only の単一ファイル (`vibe-coder.py`, ~7400行) で Ollama と直接通信するコーディングエージェント。本リポジトリはそのコア機能を以下の上に再実装している:

- **agentOS**: Rivet-based managed VM runtime for workspace virtualization and tool execution
- **AgentFS**: Filesystem mirroring/audit layer backed by SQLite
- **sandbox-agent**: Separate execution plane for coding agents
- **Pyodide (WASM)**: 本家 `vibe-coder.py` (~8200行) をそのまま WASM 上で実行（`pyodide-chat` コマンドで利用可能）
- **sql.js (WASM)**: In-browser SQLite for session persistence

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
- Web UI あり（本家は TUI only）

## Pyodide ランタイム（実装済み）

本家 `vibe-coder.py` (8221行) を Pyodide (WASM) にロードし、**agentOS actor.runAgentTurn** 経由で実行する。

### 起動方法

デフォルトは TypeScript の `runAgentLoop` パスだが、`VIBE_LOCAL_PYODIDE=1` を設定すると Pyodide 経由 (vibe-coder.py) になる:

```bash
VIBE_LOCAL_PYODIDE=1 pnpm run cli -- chat vibe-local-pyodide --mode yolo
```

### 実行経路

```
CLI → actor.runAgentTurn(prompt)
        ↓
     persistMessage(user)                     [actor DB]
        ↓
     [VIBE_LOCAL_PYODIDE=1] executePyodideAgentTurn
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

`Bash` / `Read` / `Write` / `Edit` / `Glob` / `Grep` / `WebFetch` は JS 側で同期的に実行。vibe-coder.py の Python 実装は呼び出されない（Tool クラスのインスタンスは存在するが、execute だけ差し替え）。

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
| `@vibe-local-wasm/web` | `vibe-local-pyodide/` | React + Vite web client |

Root `bin/vibe-local-wasm.mjs` is the standalone CLI entrypoint.

## Commands

```bash
# Install
pnpm install

# Development (starts both agentOS manager on :6520 and Vite on :5374)
pnpm run dev

# Individual servers
pnpm run agentos          # agentOS manager only (dev mode with watch)
pnpm run web              # Vite dev server only

# Type check both packages
pnpm run check

# Build both packages
pnpm run build

# Diagnostics and self-check
pnpm run doctor
pnpm run smoke

# CLI (two equivalent forms)
pnpm run cli -- <command>
vibe-local-wasm cli <command>    # after pnpm link --global

# Health and project listing
pnpm run health
pnpm run projects

# E2E tests (requires dev servers running)
cd vibe-local-pyodide && pnpm run test:e2e
```

## Architecture (3-Layer)

```
Browser/CLI → Vite Middleware (/__vibe_local/*) → RivetKit Client → agentOS Manager (:6520)
                                                                        ├── vibeLocal actor (sessions/messages/approvals/artifacts)
                                                                        ├── workspaceVm (Pi + host toolkits)
                                                                        └── codingSandbox (sandbox-agent :2568)
```

- **vibeLocal actor**: Actor key `["browser-core"]`. Persists sessions, messages, approvals, artifacts, sub-agents, task state to SQLite.
- **workspaceVm**: Mounts repo read-only at `/mnt/repo`, writable workspace at `/mnt/workspace`. Provides host toolkits (repo inspection, git, code search, script execution).
- **codingSandbox**: Runs coding agents via `sandbox-agent` local provider.

## Vite Middleware Routes

All browser-to-backend communication goes through Vite middleware defined in `vibe-local-pyodide/vite.config.ts`. Key route prefixes:

- `/__vibe_local/agentos/*` → actor session management (create, config, message, compact, agent-run, approval, sub-agents, export, hydrate, health)
- `/__vibe_local/coding/*` → file ops, git, search, project listing, script execution
- `/__vibe_local/chat` → OpenAI-compatible streaming proxy
- `/__vibe_local/models` → model list proxy
- `/__vibe_local/opencode-config` → reads `~/.config/opencode/config.json`

The middleware calls `vibeLocal` actor via `rivetkit` client at `AGENTOS_ENDPOINT` (default `http://127.0.0.1:6420`).

## Persistence

| Layer | Storage | Location |
|-------|---------|----------|
| Actor state (sessions, messages) | SQLite via RivetKit | `tools/agentos-dev/.agentos-dev/rivetkit/` |
| Workspace files | Host filesystem | `tools/agentos-dev/.agentos-dev/workspace/` |
| AgentFS mirror/audit | SQLite | `tools/agentos-dev/.agentos-dev/agentfs/workspace.db` |
| Backend settings (Web) | localStorage | Browser |
| Browser SQLite (fallback) | IndexedDB via sql.js | Browser (`vibe-local-pyodide.sqlite`) |

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTOS_PORT` | `6520` | agentOS manager listen port |
| `AGENTOS_ENDPOINT` | `http://127.0.0.1:6420` | RivetKit client endpoint (used in vite.config.ts) |
| `SANDBOX_AGENT_PORT` | `2568` | sandbox-agent provider port |
| `SANDBOX_AGENT_LOG` | — | `inherit` / `pipe` / `silent` |
| `VIBE_LOCAL_PORT` | `5374` | Web UI port |
| `OPENAI_API_KEY` | — | Forwarded to sandbox-agent |
| `ANTHROPIC_API_KEY` | — | Forwarded to sandbox-agent |
| `AGENTOS_DEBUG` | — | Enable debug logging |

## Key Source Files

| File | Role |
|------|------|
| `tools/agentos-dev/src/vibe-local-actor.ts` | Main actor: all session/message/approval/sub-agent logic |
| `tools/agentos-dev/src/vibe-local-cli.ts` | CLI commands: chat, health, projects, agent-run, etc. |
| `tools/agentos-dev/src/registry.ts` | agentOS manager setup (workspaceVm + codingSandbox) |
| `tools/agentos-dev/src/agentfs.ts` | AgentFS integration |
| `tools/agentos-dev/src/toolkits.ts` | Host toolkits (repo, git, code search) |
| `tools/agentos-dev/src/projects.ts` | Project discovery via package.json walking |
| `tools/agentos-dev/src/server.ts` | RivetKit manager startup |
| `vibe-local-pyodide/src/App.tsx` | Main React component (chat UI, settings, session management) |
| `vibe-local-pyodide/vite.config.ts` | Vite middleware (all `/__vibe_local/*` routes) |
| `vibe-local-pyodide/src/persistence/sqliteStore.ts` | sql.js browser-side SQLite |
| `vibe-local-pyodide/src/persistence/agentosStore.ts` | agentOS actor integration for frontend |
| `vibe-local-pyodide/src/lib/codingTools.ts` | HTTP client for agentOS coding endpoints |

## Design Decisions

- **本家準拠**: CLI/TUI のコマンド体系は ochyai/vibe-local に準拠。本家にない独自コマンドは追加しない。
- **Actor-local SQLite for conversations, localStorage for settings**: Settings stay in browser, conversation state lives in the actor.
- **AgentFS is a mirror/audit layer**: Host filesystem is always the source of truth; AgentFS provides parallel tracking.
- **Execution modes**: Plan / Act（本家準拠）。YOLO は本家の `--yes` フラグに相当。
- **本家で実装済みだがこちらで未実装**: file watcher, auto-test loop, Git checkpoint/rollback, MCP連携, スキルシステム, /undo, /tokens, /config, /commit, /diff, /git

## Technology Stack

- **Runtime**: Node.js (ESM), TypeScript, tsx
- **Package manager**: pnpm 10.18.3 (workspaces)
- **Frontend**: React 19, Vite 7, sql.js, react-markdown, lucide-react
- **Backend**: RivetKit 2.2.1, rivet agent-os packages, sandbox-agent 0.4.2, agentfs-sdk, Zod 4
- **Testing**: Playwright (E2E), smoke/doctor scripts
- **WASM**: sql.js provides in-browser SQLite via WASM (no custom WASM compilation needed)
