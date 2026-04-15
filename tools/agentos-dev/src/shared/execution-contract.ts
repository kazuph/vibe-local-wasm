export type ExecutionPlane = "control-plane" | "workspace-surface" | "sandbox";

export type SandboxDelegationClass =
  | "arbitrary-bash"
  | "native-subprocess"
  | "build-test-runner"
  | "full-coding-agent"
  | "mcp-server-spawn";

export interface DelegatedOperationClass {
  id: SandboxDelegationClass;
  plane: ExecutionPlane;
  description: string;
  examples: string[];
}

export const CONTROL_PLANE_RESPONSIBILITIES = [
  "session state",
  "transcript persistence",
  "approvals and audit",
  "tool routing",
  "capability checks",
  "sub-agent orchestration",
  "structured task state",
] as const;

export const WORKSPACE_CAPABILITY_SURFACE = [
  "repo inspection",
  "bounded file read/write/edit",
  "glob and grep under sandbox policy",
  "structured web fetch/search",
  "workspace scratch files",
] as const;

export const SANDBOX_DELEGATION_CLASSES: readonly DelegatedOperationClass[] = [
  {
    id: "arbitrary-bash",
    plane: "sandbox",
    description: "Unstructured shell access that cannot be expressed as a bounded capability.",
    examples: ["bash -lc '<custom command>'", "ad hoc shell pipelines"],
  },
  {
    id: "native-subprocess",
    plane: "sandbox",
    description: "Native process execution that depends on host runtimes or tools outside the Wasm core.",
    examples: ["python", "go", "cargo", "tool-specific CLIs"],
  },
  {
    id: "build-test-runner",
    plane: "sandbox",
    description: "Project build, install, and test workflows that are runtime-heavy or package-manager-heavy.",
    examples: ["pnpm run build", "pnpm run test", "pytest", "cargo test"],
  },
  {
    id: "full-coding-agent",
    plane: "sandbox",
    description: "Delegation to an external coding agent such as Codex or Claude Code.",
    examples: ["codingSandbox actor", "project-specific coding sessions"],
  },
  {
    id: "mcp-server-spawn",
    plane: "sandbox",
    description: "Future MCP server process launch and stdio bridging owned by the control plane.",
    examples: ["stdio MCP servers", "spawned local MCP bridges"],
  },
] as const;

export const SANDBOX_CONTRACT_INVARIANTS = [
  "The control plane owns routing, permissions, configuration, and audit.",
  "The sandbox is an execution service and never the source of truth for session state.",
  "Delegated execution classes must stay explicit and auditable.",
  "Structured file and web tools should remain in the control plane whenever they can be bounded safely.",
] as const;

export function describeExecutionContract() {
  return {
    controlPlane: {
      plane: "control-plane" as const,
      responsibilities: [...CONTROL_PLANE_RESPONSIBILITIES],
    },
    workspaceSurface: {
      plane: "workspace-surface" as const,
      responsibilities: [...WORKSPACE_CAPABILITY_SURFACE],
    },
    sandbox: {
      plane: "sandbox" as const,
      delegatedOperationClasses: SANDBOX_DELEGATION_CLASSES.map((entry) => ({
        id: entry.id,
        description: entry.description,
        examples: [...entry.examples],
      })),
      invariants: [...SANDBOX_CONTRACT_INVARIANTS],
    },
  };
}

export function formatSandboxDelegationClasses() {
  return SANDBOX_DELEGATION_CLASSES.map((entry) => `${entry.id}: ${entry.description}`).join("\n");
}
