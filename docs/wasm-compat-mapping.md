# vibe-local-wasm control-plane mapping

この文書は、`vibe-local-wasm` の **現在の実装** と **目標アーキテクチャ** を切り分けて説明する。

本 repo の目標は、**WASM/agentOS を trusted control plane にし、WASM で動かない処理だけを外部 sandbox に委譲すること** である。  
「全部を無理に Wasm に入れる」ことよりも、**主導権を agentOS 側に残すこと** を優先する。

## 1. Architectural stance

| Layer | Role | Trust level | Examples |
|------|------|-------------|----------|
| agentOS actor + Pyodide | control plane | trusted | session state, policy, audit, tool routing, sub-agent orchestration |
| workspace capability surface | bounded tool execution | trusted-ish / policy-mediated | read, write, search, structured fetch, future virtual workspace |
| external sandbox | execution plane | less trusted | Bash, subprocess, build/test, future MCP server spawn |

## 2. Current state vs target state

| Area | Current state | Target state |
|------|---------------|--------------|
| Agent core | `vibe-coder.py` runs in Pyodide | keep in Wasm |
| Session state | actor-local SQLite | keep in control plane |
| Tool routing | JS bridge from Pyodide | keep, but move toward capability-native tools |
| Workspace abstraction | host-backed workspace + AgentFS mirror | actor-owned workspace model + explicit host export/import |
| File operations | bounded host-backed operations | capability-mediated workspace, less raw host dependency |
| Bash/subprocess | host / sandbox dependent | sandbox-only for truly non-WASM tasks |
| Sandbox role | general external execution plane | narrower, explicit non-WASM execution plane |
| Web UI | archived / non-primary | optional / secondary, not architecture-defining |

## 3. Tool placement policy

### Keep in Wasm / control plane whenever possible

- session state
- permission and approval logic
- tool selection and routing
- structured task state
- lightweight parsing / summarization helpers
- fetch / search / file tools that can be mediated safely

### Delegate to external sandbox only when necessary

- arbitrary Bash
- native subprocess execution
- compiler / package manager / test runner invocation
- runtime-specific build pipelines
- MCP server spawn / stdio bridge

## 4. Current compatibility notes

| Capability | Current implementation | Long-term note |
|-----------|------------------------|----------------|
| `Read` / `Write` / `Edit` / `Glob` / `Grep` | JS bridge + bounded host access | replace raw host feel with clearer capability surface |
| `WebFetch` / `WebSearch` | JS bridge | keep in control plane where possible |
| `SubAgent` / `ParallelAgents` | JS-side mini loop / worker coordination | good fit for control plane orchestration |
| `Bash` | restricted execution path | keep as explicit escape hatch, not default architecture |
| `NotebookEdit` / `Task*` / `AskUserQuestion` | JS bridge in control plane | keep in-core |
| file watcher / auto-test | implemented with control-plane ownership | keep policy / audit in control plane, delegate heavy execution only when necessary |
| MCP | not finished | likely sandbox execution with control-plane ownership |

## 5. Design rules for future work

1. Prefer **capability APIs** over generic shell access.
2. Treat external sandbox as an **execution plane**, not the owner of state.
3. Keep **policy, routing, approvals, and audit** in agentOS.
4. When a feature cannot stay in Wasm, isolate it behind a narrow sandbox contract.
5. Do not expand archived web paths into the main architecture unless they serve the CLI/Wasm core.

## 6. What “more Wasm-native” means here

In this repo, “more Wasm-native” does **not** mean:

- deleting every external execution path
- forcing build/test/Bash into Wasm at all costs
- making the sandbox the new source of truth

Instead, it means:

- more logic stays in the Wasm/agentOS control plane
- fewer raw host bridges leak through
- sandbox delegation becomes narrower and more explicit
- trust boundaries become easier to explain and audit
