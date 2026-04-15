# MCP layering

This document fixes the intended MCP trust boundary for `vibe-local-wasm`.

## Rule

MCP belongs to **both** planes, but with different responsibilities:

- **control plane**
  - server registry and configuration
  - permissions and approval policy
  - tool exposure to the agent
  - audit trail for MCP tool calls
- **sandbox**
  - server process spawn
  - lifecycle supervision
  - stdio / network transport connection
  - resource isolation

## What must not happen

- Pyodide must not spawn MCP server processes directly
- the actor must not become an arbitrary process launcher
- sandbox execution must not own MCP permissions or session truth

## Current state

MCP is not implemented yet. Milestone 5 adds a typed contract in `tools/agentos-dev/src/shared/mcp-contract.ts` so future work has one place that defines:

- allowed transport shapes
- control-plane-owned responsibilities
- sandbox-owned responsibilities
- launch-plan validation for future MCP server registration

## Execution model

1. control plane loads or validates MCP server configuration
2. control plane decides whether the server may be exposed
3. sandbox launches or connects to the server
4. results flow back through the control plane for audit and routing

This keeps MCP consistent with the repository rule: **agentOS/Wasm owns policy; sandbox provides execution**.
