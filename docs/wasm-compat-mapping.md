# vibe-coder.py WASM 互換性マッピング

本家 [ochyai/vibe-local](https://github.com/ochyai/vibe-local) の `vibe-coder.py` (~7400行) を
Pyodide (WASM) 上で動作させるための互換性分析と、vibe-local-wasm の現状との差分。

## 1. 本家 vibe-coder.py のモジュール構成

| モジュール | 役割 | 主要クラス/関数 |
|-----------|------|----------------|
| OllamaClient | Ollama API 直接通信 (`/v1/chat/completions`) | ストリーミング、モデル一覧 |
| ToolRegistry | OpenAI format の function calling スキーマ管理 | 16ツールの登録・呼び出し |
| PermissionMgr | safe/ask/deny のアクセス制御 | ツール実行前の確認フロー |
| Session | インメモリ状態 + JSONL 永続化 | セッション保存・復元・compact |
| TUI | readline + ANSI + DECSTBM 固定フッター | ストリーミング表示、ESC割り込み |
| AgentLoop | LLM → tool → result → loop | function calling / XML fallback |

## 2. WASM (Pyodide) 互換性マトリクス

### 動作可能（Pyodide で直接実行可）

| 機能 | 理由 |
|------|------|
| OllamaClient (HTTP通信) | Pyodide の `pyodide.http.pyfetch` で代替可能 |
| ToolRegistry (スキーマ管理) | 純Python、stdlib only |
| PermissionMgr (権限管理) | 純Python ロジック |
| Session (インメモリ状態) | 純Python dict操作 |
| AgentLoop (エージェントループ) | 純Python ループ |
| compact (コンテキスト圧縮) | 純Python 文字列処理 |
| Token counting | 純Python |
| XML fallback parser | 純Python |

### 動作不可（ホスト委譲が必要）

| 機能 | 理由 | 委譲先 |
|------|------|--------|
| BashTool (subprocess) | WASM にプロセス実行なし | agentOS workspaceVm / sandbox-agent |
| ReadTool (ファイル読み取り) | WASM にホストFS アクセスなし | agentOS host toolkit (`readFile`) |
| WriteTool (ファイル書き込み) | 同上 | agentOS host toolkit (`writeFile`) |
| EditTool (ファイル編集) | 同上 | agentOS host toolkit (新規追加必要) |
| GlobTool (ファイル検索) | os.walk 不可 | agentOS host toolkit (新規追加必要) |
| GrepTool (内容検索) | ホストFS アクセス不可 | agentOS host toolkit (`searchCode`) |
| WebFetchTool (HTTP取得) | CORS制約 | Vite middleware 経由でプロキシ |
| WebSearchTool (検索) | 同上 | Vite middleware 経由でプロキシ |
| NotebookEditTool | ファイルI/O | agentOS host toolkit |
| Git操作 (/commit, /diff, /git) | subprocess + git | agentOS host toolkit (`runGit`) |
| File watcher (/watch) | inotify/kqueue 不可 | agentOS host toolkit (未実装) |
| Auto-test (/autotest) | subprocess | agentOS host toolkit (未実装) |
| JSONL セッション保存 | ホストFS | agentOS actor SQLite で代替済み |
| DECSTBM TUI | ターミナル制御 | **CLI (TypeScript) 側で実装** |

### 設計方針

```
┌─────────────────��────────────────┐
│  Pyodide (WASM)                  │
│  ┌─────────────────────���────────┐│
│  │ vibe-coder core              ││
│  │ - OllamaClient              ││
│  │ - ToolRegistry              ││
│  │ - PermissionMgr             ││
│  │ - Session (in-memory)        ││
│  │ - AgentLoop                  ││
│  │ - compact / token counting   ││
│  └──────────┬───────────────────┘│
│             │ ツール実行要求      │
│             ▼                    │
│  ┌──────────────────────────────┐│
│  │ Host Bridge (JS↔Python)      ││
│  │ ツール呼び出しをJSに委譲      ││
│  └──────────┬───────────────────┘│
└─────────────┼────────────────────┘
              │
              ▼
┌─────────────��────────────────────┐
│  TypeScript Host                 │
│  ┌──────────────────────┐        │
│  │ agentOS host toolkit │        │
│  │ - Bash (subprocess)  │        │
│  │ - Read/Write/Edit    │        │
│  │ - Glob/Grep          │        │
│  │ - Git operations     │        │
│  └──────────────────────┘        │
│  ┌──────────────────────┐        │
│  │ TUI (DECSTBM)        │        │
│  │ - ANSI色             │        │
│  │ - 固定フッター       │        │
│  │ - ストリーミング表示 │        │
│  └──────────────────────┘        │
│  ┌──────────────────────┐        │
│  │ sandbox-agent        │        │
│  │ - coding agent実行面 │        │
│  └──────────────────────┘        │
└──────────────────────────────────┘
```

## 3. CLI コマンド差分（本家 vs vibe-local-wasm）

### vibe-local-wasm に存在するが本家にないもの（削除対象）

#### CLI サブコマンド

| コマンド | 本家での対応 | アクション |
|----------|-------------|-----------|
| `health` | なし（内部診断） | 削除。代わりに `--debug` で診断情報出力 |
| `projects` | なし（単一プロジェクト前提） | 削除 |
| `project-info` | なし | 削除 |
| `git-status` | `/diff` コマンド | 削除。`/diff` に統合 |
| `diff-stat` | `/diff` コマンド | 削除。`/diff` に統合 |
| `search` | Grep tool で対応 | 削除 |
| `read-file` | Read tool で対応 | 削除 |
| `read-agentfs-mirror` | なし | 削除 |
| `write-file` | Write tool で対応 | 削除 |
| `run-script` | Bash tool で対応 | 削除 |
| `agent-run` | 対話モード内で処理 | 削除。`chat` に統合 |
| `agent-plan` | 対話モード + `/plan` | 削除 |
| `agent-yolo` | 対話モード + `--yes` | 削除 |
| `sessions` | `--list-sessions` フラグ | フラグに変更 |
| `session` | `--session-id` フラグ | フラグに変更 |
| `watch-session` | なし | 削除 |
| `continue-session` | `--resume` / `--session-id` | フラグに変更 |
| `continue-subagent` | なし（エージェント内で自動） | 削除 |
| `approval` | なし（対話中に自動確認） | 削除 |
| `parallel-run` | ParallelAgents tool | 削除 |
| `agent-rewrite-file` | Edit tool | 削除 |

#### 対話コマンド

| コマンド | 本家での対応 | アクション |
|----------|-------------|-----------|
| `/projects` | なし | 削除 |
| `/project <name>` | なし | 削除 |
| `/approvals` | なし（対話中に自動） | 削除 |
| `/subagents` | なし | 削除 |
| `/continue-subagent` | なし | 削除 |
| `/mode <plan\|act\|yolo>` | `/plan` と `/approve` | `/plan` と `/approve` に変更 |
| `/parallel` | ParallelAgents tool | 削除 |
| `/approve <id>` (承認) | 対話中に y/n | 対話中の y/n 確認に変更 |
| `/reject <id>` | 対話中に y/n | 同上 |

### 本家にあるが vibe-local-wasm にないもの（追加対象）

| コマンド/機能 | 優先度 | 備考 |
|--------------|--------|------|
| `/model <name>` | P0 | モデル切り替え |
| `/models` | P0 | インストール済みモデル一覧 |
| `/status` | P0 | セッション情報表示 |
| `/save` | P1 | セッション手動保存 |
| `/compact` | P0 | 既に actor 側にあるが CLI コマンドがない |
| `/tokens` | P1 | トークン使用量表示 |
| `/undo` | P2 | 最後の Write/Edit を取り消し |
| `/config` | P1 | 設定表示 |
| `/commit` | P1 | git stage + commit |
| `/diff` | P1 | git diff 表示 |
| `/git <cmd>` | P1 | 任意の git サブコマンド |
| `/plan` | P0 | Plan モードに入る |
| `/approve` (モード切替) | P0 | Act モードに切り替え |
| `/checkpoint` | P2 | Git チェックポイント |
| `/rollback` | P2 | チェックポイントに戻す |
| `/autotest` | P2 | 自動テスト ON/OFF |
| `/watch` | P2 | ファイル監視 ON/OFF |
| `/skills` | P2 | スキル一覧 |
| `/init` | P1 | CLAUDE.md 作成 |
| `/yes` | P1 | 自動承認モード |
| `/debug-scroll` | P3 | スクロール領域デバッグ |
| `--prompt/-p` | P0 | ワンショットモード |
| `--model/-m` | P0 | モデル指定 |
| `--yes/-y` | P0 | 自動承認 |
| `--debug` | P1 | デバッグログ |
| `--resume` | P0 | セッション復帰 |
| `--session-id` | P0 | セッション指定 |
| `--list-sessions` | P0 | セッション一覧 |
| `--version` | P1 | バージョン表示 |
| DECSTBM 固定フッター | P0 | ステータス行 |
| ESC 割り込み | P0 | 生成中止 |
| 三重引用符 `"""` 複数行入力 | P1 | 複数行入力 |
| ツール実行時の y/n 確認 | P0 | PermissionMgr |

## 4. 実装ロードマップ

### Phase 1: CLI を本家準拠に（今回のスコープ）
1. 捏造コマンドの削除
2. 本家準拠のフラグ体系 (`-p`, `-m`, `-y`, `--resume`, `--list-sessions`, `--session-id`)
3. DECSTBM 固定フッター実装
4. ANSI 色付き出力
5. 本家準拠の対話コマンド (`/plan`, `/approve`, `/model`, `/status`, `/compact`, `/clear`)

### Phase 2: ツール実行の本家互換
1. 16 ツールの agentOS host toolkit マッピング完成
2. ツール実行時の y/n 確認フロー
3. SubAgent / ParallelAgents の内部実装（CLI コマンドとしてではなくツールとして）

### Phase 3: Pyodide 統合
1. vibe-coder.py のコアロジック (OllamaClient, ToolRegistry, PermissionMgr, Session, AgentLoop) を Pyodide に載せる
2. Host Bridge (JS↔Python) でツール実行を TypeScript 側に委譲
3. 既存 agentOS actor との統合

### Phase 4: 本家パリティ達成
1. MCP 連携
2. スキルシステム
3. Git チェックポイント / rollback
4. File watcher
5. Auto-test loop
