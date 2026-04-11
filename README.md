# vibe-local-wasm

`vibe-local-wasm` は、`vibe-local` 風の coding agent 体験を Web と CLI の両方で使えるようにした standalone repository です。

現状の実装は、薄い chat-first UI の下に `agentOS + SQLite + sandbox-agent + AgentFS` を置く構成です。  
Web でも CLI でも同じ actor-backed session を共有します。

## 現在の実装状況

この repository で実際に使えるもの:

- browser UI
  - chat-first transcript
  - backend settings の保存
  - `Plan / Act / YOLO`
  - pending approvals
  - tool execution log
  - sub-agent / parallel agent の進行表示
  - session 一覧、compact、export
- CLI
  - `health`, `projects`, `project-info`
  - `git-status`, `diff-stat`, `search`
  - `read-file`, `write-file`, `run-script`
  - `agent-run`, `agent-plan`, `agent-yolo`
  - interactive `chat`
  - `sessions`, `session`, `watch-session`
  - `continue-session`, `continue-subagent`
  - `approval`
  - `parallel-run`
- runtime
  - `agentOS` manager
  - `sandbox-agent` local provider
  - actor-local SQLite persistence
  - AgentFS workspace mirror

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

そのあと `http://localhost:5374/` を開きます。

Chrome で開くなら:

```bash
pnpm run open
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
vibe-local-wasm web
vibe-local-wasm agentos
vibe-local-wasm health
vibe-local-wasm projects
vibe-local-wasm chat vibe-local-pyodide --mode act
```

## Root scripts

```bash
pnpm run dev
pnpm run web
pnpm run agentos
pnpm run start:agentos
pnpm run check
pnpm run build
pnpm run doctor
pnpm run smoke
pnpm run health
pnpm run projects
pnpm run open
```

## CLI commands

`vibe-local-wasm cli ...` または `pnpm run cli -- ...` で使えます。

```bash
vibe-local-wasm cli health
vibe-local-wasm cli projects
vibe-local-wasm cli project-info vibe-local-pyodide
vibe-local-wasm cli git-status
vibe-local-wasm cli diff-stat
vibe-local-wasm cli search localStorage 20
vibe-local-wasm cli read-file README.md
printf 'hello\n' | vibe-local-wasm cli write-file tools/agentos-dev/.agentos-dev/workspace/note.txt
vibe-local-wasm cli run-script vibe-local-pyodide check
vibe-local-wasm cli agent-run vibe-local-pyodide "git status を見て要約して"
vibe-local-wasm cli agent-plan vibe-local-pyodide "README に改善点を出して"
vibe-local-wasm cli agent-yolo vibe-local-pyodide "小さな UI 改善を最後までやって"
vibe-local-wasm cli chat vibe-local-pyodide --mode act
vibe-local-wasm cli sessions
vibe-local-wasm cli session <sessionId>
vibe-local-wasm cli watch-session <sessionId>
vibe-local-wasm cli continue-session <sessionId>
vibe-local-wasm cli continue-subagent <sessionId> <subAgentId>
vibe-local-wasm cli approval <sessionId> <approvalId> <approve|reject> --continue
vibe-local-wasm cli parallel-run --mode act vibe-local-pyodide "task 1" -- "task 2"
```

interactive chat では次が使えます。

- `/help`
- `/mode <plan|act|yolo>`
- `/projects`
- `/project <name>`
- `/approvals`
- `/approve <id> [continue]`
- `/reject <id>`
- `/continue`
- `/subagents`
- `/continue-subagent <id>`
- `/parallel [mode] <p1> -- <p2>`
- `/session`
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
Web は backend settings を localStorage に保存します。

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
- `vibe-local-wasm health`
- `vibe-local-wasm projects`

## License

MIT
