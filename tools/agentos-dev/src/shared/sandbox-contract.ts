export const SANDBOX_DELEGATION_CLASSES = [
  {
    id: "arbitrary-bash",
    label: "Arbitrary Bash",
    description: "Unstructured shell commands that cannot be reduced to capability APIs.",
    examples: ["bash -lc ...", "one-off shell pipelines", "interactive shell workflows"],
  },
  {
    id: "native-subprocess",
    label: "Native subprocess",
    description: "Host-native process execution that depends on runtimes or binaries outside Wasm.",
    examples: ["execFile/execFileSync tools", "language runtime CLIs", "system package utilities"],
  },
  {
    id: "build-test-workflow",
    label: "Build/test workflow",
    description: "Compiler, package manager, lint, and test runs that depend on project toolchains.",
    examples: ["pnpm run build", "pytest", "cargo test"],
  },
  {
    id: "mcp-server-spawn",
    label: "MCP server spawn",
    description: "Future MCP server processes and stdio bridges that must not run inside the trusted core.",
    examples: ["stdio MCP launch", "sandbox-hosted MCP bridge"],
  },
] as const;

export type SandboxDelegationClass = (typeof SANDBOX_DELEGATION_CLASSES)[number]["id"];

export const SANDBOX_CONTROL_PLANE_RESPONSIBILITIES = [
  "session state",
  "approvals and permissions",
  "audit trail",
  "tool routing",
  "capability decisions",
] as const;

export function getSandboxContractSummary() {
  return {
    controlPlaneOwns: [...SANDBOX_CONTROL_PLANE_RESPONSIBILITIES],
    delegatedOperationClasses: SANDBOX_DELEGATION_CLASSES.map((entry) => ({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      examples: [...entry.examples],
    })),
  };
}

export function formatSandboxContractForInstructions(): string {
  const delegated = SANDBOX_DELEGATION_CLASSES.map((entry) => `${entry.id}: ${entry.description}`).join(
    "\n- ",
  );

  return [
    "Trusted control plane responsibilities remain inside agentOS/Wasm:",
    `- ${SANDBOX_CONTROL_PLANE_RESPONSIBILITIES.join("\n- ")}`,
    "Only delegate these operation classes to the external sandbox:",
    `- ${delegated}`,
    "Do not move session state, approvals, or audit ownership into the sandbox.",
  ].join("\n");
}
