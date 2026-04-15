# Workspace ownership notes

This file maps the Milestone 4 workspace model to the current implementation.

## Current code locations

- actor state: `src/vibe-local-actor.ts`
- registry mounts: `src/registry.ts`
- AgentFS integration path: `src/agentfs.ts`
- project discovery and script execution: `src/projects.ts`, `src/toolkits.ts`

## Current reality

- actor-local SQLite already owns conversations and approvals
- `/mnt/workspace` is backed by `tools/agentos-dev/.agentos-dev/workspace`
- AgentFS integration code exists but is not actively wired into the current runtime path

## Implementation direction

The next implementation slice should add actor-facing workspace APIs before attempting a storage rewrite. The likely sequence is:

1. `workspaceRead`
2. `workspaceWrite`
3. `workspaceList`
4. `exportWorkspaceSnapshot`
5. `importWorkspaceSnapshot`

## Constraint

Do not make host filesystem writes disappear silently. If host import/export behavior changes, it should be explicit in both docs and audit behavior.
