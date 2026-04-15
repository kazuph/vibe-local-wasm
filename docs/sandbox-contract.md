# Sandbox contract

This document defines the **explicit delegation boundary** between the trusted
`agentOS / Pyodide` control plane and the external sandbox execution plane.

## Control-plane ownership

The sandbox is a service, not the owner of state. The control plane keeps:

- session state
- approvals and permissions
- audit trail
- tool routing
- capability decisions

## Delegated operation classes

Only these operation classes are allowed to cross into the external sandbox:

| Class | Why delegated | Examples |
|------|---------------|----------|
| `arbitrary-bash` | generic shell access cannot be reduced to a structured capability safely | shell pipelines, interactive shell flows |
| `native-subprocess` | depends on host binaries or language runtimes outside Wasm | `execFileSync`, native CLI helpers |
| `build-test-workflow` | compiler / package-manager / test-runner flows depend on host toolchains | `pnpm run build`, `pytest`, `cargo test` |
| `mcp-server-spawn` | MCP server processes and stdio bridges must not run inside the trusted core | future stdio MCP launch |

Anything outside this list should stay in the control plane or be introduced as
a new structured capability first.

## Current implementation hooks

- `tools/agentos-dev/src/shared/sandbox-contract.ts`
- `tools/agentos-dev/src/registry.ts`
- `tools/agentos-dev/src/server.ts`
- `tools/agentos-dev/src/doctor.ts`

Those files now share the same contract summary so future work does not widen
the sandbox role silently in docs only.
