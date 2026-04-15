# Sandbox contract

This document defines the current execution boundary for `vibe-local-wasm`.

## Core rule

- **agentOS / Wasm** owns session state, approvals, audit, routing, and capability decisions.
- **workspace capability surface** handles bounded file and web operations.
- **external sandbox** is an execution service for work that cannot stay inside the trusted core.

The sandbox is **not** the source of truth for sessions, approvals, or workspace state.

## Explicit delegated execution classes

Only these classes should be handed to the external sandbox:

| Class | Why it is delegated | Examples |
|------|----------------------|----------|
| `arbitrary-bash` | Unstructured shell access cannot be audited as a narrow capability | shell pipelines, ad hoc commands |
| `native-subprocess` | Depends on host runtimes / binaries outside the Wasm core | `python`, `go`, `cargo`, language CLIs |
| `build-test-runner` | Package-manager and compiler-heavy workflows are non-WASM in practice | `pnpm run build`, `pytest`, `cargo test` |
| `full-coding-agent` | Full external coding agents should run as a service, not inside control-plane policy code | Codex / Claude Code sessions |
| `mcp-server-spawn` | MCP process launch belongs to a narrower external execution surface | stdio MCP servers, local bridges |

## Keep in the control plane when bounded safely

- session state and transcript persistence
- approvals and audit trail
- tool routing and capability checks
- structured file tools
- structured web fetch / search
- sub-agent orchestration
- task state management

## Current implementation note

The Pyodide bridge still contains bounded host-backed operations, including a restricted `Bash` path. That escape hatch exists for compatibility, but it does **not** expand the sandbox contract. The direction is to keep making the bounded capability surface clearer while reserving the external sandbox for the explicit classes above.
