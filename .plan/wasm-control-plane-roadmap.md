# vibe-local-wasm future roadmap for follow-up AI

This document is a handoff plan for a separate AI or engineer.  
It is intentionally detailed and assumes no hidden chat context.

## 1. Core objective

Move the repository toward this architecture:

- **Wasm / agentOS = trusted control plane**
- **external sandbox = non-WASM execution plane**
- **no Docker requirement**
- **agentOS keeps ownership of state, routing, approval, and audit**

The goal is **not** “force everything into Wasm.”  
The goal is to keep as much of the system as possible inside a safe, auditable Wasm/agentOS core and delegate only the irreducibly non-WASM work to a narrower external sandbox.

## 2. Non-goals

Do **not** optimize for these at the expense of the core objective:

- blindly matching every niche upstream feature
- maximizing shell compatibility
- preserving legacy web UI as a first-class path
- making sandbox execution the primary source of truth

## 3. Current state summary

### Completed already

- Phases 1-7 from the previous cleanup/parity effort are done.
- CLI/TUI is the primary path.
- `vibe-coder.py` runs in Pyodide.
- core tool bridge exists in `tools/agentos-dev/src/pyodide-runtime.ts`
- `SubAgent` and `ParallelAgents` are bridged on the JS side.
- `WebFetch` now handles non-UTF8 pages like Shift_JIS.

### Still incomplete

- `/watch`
- `/autotest`
- `/undo`
- MCP integration
- deeper capability-native workspace model
- reducing raw host-bridge dependence for file/process operations

## 4. Recommended work order

### Track A — quality and reliability first

Do this before large architectural rewrites:

1. tighten tool-result reliability
2. reduce repeated/unnecessary tool calls
3. improve session recovery and error visibility
4. harden port conflict handling and long-running task behavior

Reason: architecture work is easier when the current baseline is stable.

### Track B — capability-native architecture

After reliability work, move on to these:

1. clarify the capability boundary for file and web tools
2. shrink the raw shell/subprocess surface
3. make sandbox usage more explicit and narrower
4. prepare a virtual-workspace-first model

## 5. Concrete roadmap

## Milestone 1 — finish the “commonly used” CLI quality gaps

### Scope

- make `/watch` and `/autotest` honest: either real or clearly scoped
- add `/undo` only if it can be reliable and auditable
- improve repeated tool-call behavior and result grounding

### Files likely involved

- `tools/agentos-dev/src/vibe-local-cli.ts`
- `tools/agentos-dev/src/vibe-local-actor.ts`
- `tools/agentos-dev/src/pyodide-runtime.ts`
- `tools/agentos-dev/src/pyodide-core/vibe-coder.py` only if unavoidable

### Guidance

- Prefer implementing behavior on the JS/actor side instead of editing vendored Python.
- If `/watch` is added, keep the **watch detection / event injection** in the control plane.
- If `/autotest` is added, keep the **policy and routing** in the control plane; let heavy execution happen in sandbox.
- Avoid adding new placeholder commands. Either wire a feature or document it as deferred.

### Acceptance criteria

- commands do not lie about their behavior
- targeted reproductions exist in `.artifacts/`
- `pnpm run check`, `pnpm run build`, and relevant CLI reproductions pass

## Milestone 2 — make the file/tool surface more capability-native

### Scope

Reduce the “raw host bridge” feel of:

- `Read`
- `Write`
- `Edit`
- `Glob`
- `Grep`
- `WebFetch`

### Guidance

- Introduce clearer capability boundaries instead of broad file/process access.
- Keep the current execution-root restriction model, but make the surface easier to reason about.
- Prefer structured operations over general shell escape paths.
- If you need a new abstraction, put it in the JS runtime / actor layer rather than patching vendored Python.

### Questions to answer during work

1. Which tools can remain fully inside the trusted control plane?
2. Which tools still need a host-backed implementation?
3. Which of those can be narrowed to structured capabilities?

### Acceptance criteria

- it is easier to explain which operations are in-core vs delegated
- file access policy remains enforced
- no regression in current CLI flows

## Milestone 3 — narrow the sandbox contract

### Scope

Define exactly when the system is allowed to use external sandbox execution.

### Guidance

- treat sandbox as a **service** called by the control plane
- do not let sandbox become the owner of session or approval state
- keep an explicit list of delegated operation classes:
  - arbitrary Bash
  - subprocess-heavy work
  - build/test workflows
  - future MCP server spawn

### Files likely involved

- `tools/agentos-dev/src/registry.ts`
- `tools/agentos-dev/src/toolkits.ts`
- `tools/agentos-dev/src/shared/git-utils.ts`
- `tools/agentos-dev/src/pyodide-runtime.ts`
- docs under `README.md`, `CLAUDE.md`, `docs/`

### Acceptance criteria

- the repo has a documented sandbox contract
- new work does not silently expand sandbox scope
- docs match implementation

## Milestone 4 — plan the virtual workspace evolution

### Problem

Right now, host filesystem is still effectively the source of truth, with AgentFS as mirror/audit.

### Goal

Move toward a model where:

- the trusted control plane owns a clearer workspace abstraction
- host filesystem dependence is reduced
- export/import to host is more explicit

### Guidance

- do **not** attempt a big-bang rewrite
- first identify which existing flows truly require host FS
- separate “workspace state” from “host persistence” conceptually

### Deliverable

A design doc or prototype, not necessarily full implementation.

## Milestone 5 — MCP in the right architectural layer

### Guidance

- Do not add MCP by simply spawning arbitrary processes from the core path.
- Prefer:
  - control plane owns configuration, permissions, audit, tool exposure
  - sandbox owns server process execution when needed

### Acceptance criteria

- clear trust boundary
- auditable server configuration
- no uncontrolled spawn path from the trusted core

## 6. Validation protocol

For every phase-sized change:

1. run existing checks first
2. implement
3. run:
   - `pnpm run check`
   - `pnpm run build`
   - `pnpm run smoke` when relevant
4. add a focused repro under `.artifacts/...`
5. commit only after validation

This repository already follows a phase discipline where **validation and commit are required for completion**.

## 7. Repo files that matter most

### Runtime and architecture

- `tools/agentos-dev/src/pyodide-runtime.ts`
- `tools/agentos-dev/src/vibe-local-actor.ts`
- `tools/agentos-dev/src/vibe-local-cli.ts`
- `tools/agentos-dev/src/registry.ts`
- `tools/agentos-dev/src/toolkits.ts`
- `tools/agentos-dev/src/projects.ts`

### Documentation

- `README.md`
- `CLAUDE.md`
- `tools/agentos-dev/README.md`
- `docs/wasm-compat-mapping.md`

### Evidence

- `.artifacts/tui-foundation/`

## 8. Rules for the next AI

1. Do not assume archived web paths are first-class.
2. Do not expand raw shell use unless absolutely necessary.
3. Prefer JS/actor-side integration over modifying vendored Python.
4. Keep trust-boundary explanations in sync with code.
5. When in doubt, preserve agentOS/Wasm ownership and make sandbox narrower, not wider.

## 9. Suggested immediate next task

If continuing immediately, the best next task is:

### “Make `/watch` and `/autotest` real without widening trust boundaries”

Reason:

- they are visible user-facing gaps
- they fit the control-plane / execution-plane split well
- they improve daily usability more than niche parity features

Suggested split:

- control plane:
  - toggle state
  - event injection
  - audit
  - policy
- sandbox:
  - actual test command execution
  - expensive file-system-dependent operations

If that proves too large, then do:

### “Reduce repeated/fuzzy tool use and improve result grounding”

Reason:

- immediate UX payoff
- low architectural risk
- helps all future features
