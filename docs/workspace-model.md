# Workspace model

This document defines the target workspace model for `vibe-local-wasm` after Milestone 4.

## Goal

The control plane should own the **workspace abstraction** even while the host filesystem remains the current persistence mechanism.

That means:

- actor state stays in actor-local SQLite
- workspace operations become capability-mediated
- host filesystem becomes an explicit export/import surface, not an implicit owner of truth

## Current state

Today the repository uses three distinct persistence surfaces:

| Layer | Current role | Current location |
|------|---------------|------------------|
| actor state | source of truth for sessions, messages, approvals, artifacts, task state | `tools/agentos-dev/.agentos-dev/rivetkit/` |
| workspace files | writable backing store used by the current runtime | `tools/agentos-dev/.agentos-dev/workspace/` |
| AgentFS | defined integration path, not actively wired into the current runtime | `tools/agentos-dev/.agentos-dev/agentfs/workspace.db` |

This means the workspace is still effectively **host-backed**, and the AgentFS path is currently architectural preparation rather than an active source of runtime behavior.

## Target state

The long-term target is a three-layer model:

1. **actor DB** owns session, approval, audit, and routing state
2. **workspace state** becomes a first-class capability-mediated abstraction
3. **host export** is a synchronized replica for user visibility and external tooling

The key shift is conceptual: host persistence remains useful, but it stops being the architectural owner of workspace state.

## Ownership rules

### Control plane owns

- session state
- approvals and audit
- workspace routing
- workspace capability policy
- import/export decisions

### Workspace layer owns

- bounded file reads and writes
- file metadata and change tracking
- workspace snapshots
- future sync policy with AgentFS-backed storage

### Host filesystem owns

- compatibility with existing editors and git tooling
- explicit exports from the workspace layer
- current transitional backing store while the virtual workspace matures

## Export / import contract

Milestone 4 does not implement this contract, but it defines it:

- `exportWorkspaceSnapshot()`
  - returns workspace files plus metadata needed for replay or restore
- `importWorkspaceSnapshot(snapshot)`
  - restores a workspace state into the control-plane-managed workspace
- `syncWorkspaceToHost()`
  - pushes workspace state to the host-visible writable workspace
- `syncHostIntoWorkspace(source)`
  - explicit import path for user edits that originate outside the control plane

## Migration path

1. **documented ownership**
   - describe current host-backed reality without pretending the virtual workspace already exists
2. **actor-mediated workspace APIs**
   - add explicit workspace read/write/export operations on the actor side
3. **AgentFS promotion**
   - move AgentFS from mirror/audit toward primary workspace-state backing
4. **explicit host sync**
   - turn host filesystem writes into import/export operations rather than the default truth path

## Flows that still require host dependence today

- project discovery via `package.json`
- git operations against the repository checkout
- build/test workflows that run through native runtimes
- writable scratch files exposed under `/mnt/workspace`

These are acceptable transitional dependencies, but they should remain explicit.

## Non-goal

Milestone 4 is **not** a big-bang rewrite of workspace persistence. It is the design checkpoint that makes later capability-native implementation coherent.
