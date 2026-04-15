import { z } from "zod";

export const mcpTransportSchema = z.enum(["stdio", "http", "sse"]);
export const mcpApprovalPolicySchema = z.enum(["always", "session", "never"]);

export const mcpServerConfigSchema = z
  .object({
    name: z.string().min(1),
    transport: mcpTransportSchema.default("stdio"),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    url: z.string().url().optional(),
    env: z.record(z.string(), z.string()).default({}),
    enabled: z.boolean().default(true),
    exposedTools: z.array(z.string()).default([]),
    approvalPolicy: mcpApprovalPolicySchema.default("always"),
  })
  .superRefine((value, ctx) => {
    if (value.transport === "stdio" && !value.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stdio MCP servers require command",
        path: ["command"],
      });
    }
    if (value.transport !== "stdio" && !value.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.transport} MCP servers require url`,
        path: ["url"],
      });
    }
  });

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const MCP_CONTROL_PLANE_RESPONSIBILITIES = [
  "server registry",
  "permissions and approvals",
  "tool exposure",
  "audit trail",
  "session routing",
] as const;

export const MCP_SANDBOX_RESPONSIBILITIES = [
  "server process spawn",
  "lifecycle supervision",
  "stdio or network transport connection",
  "resource isolation",
] as const;

export function buildMcpLaunchPlan(config: McpServerConfig) {
  const parsed = mcpServerConfigSchema.parse(config);
  return {
    executionPlane: "sandbox" as const,
    server: parsed,
    controlPlaneResponsibilities: [...MCP_CONTROL_PLANE_RESPONSIBILITIES],
    sandboxResponsibilities: [...MCP_SANDBOX_RESPONSIBILITIES],
  };
}

export function describeMcpContract() {
  return {
    status: "planned" as const,
    executionPlane: "sandbox" as const,
    supportedTransports: mcpTransportSchema.options,
    controlPlaneResponsibilities: [...MCP_CONTROL_PLANE_RESPONSIBILITIES],
    sandboxResponsibilities: [...MCP_SANDBOX_RESPONSIBILITIES],
    invariants: [
      "Do not spawn MCP servers from the trusted control plane.",
      "Control plane owns configuration, permissions, tool exposure, and audit.",
      "Sandbox owns MCP server process lifecycle.",
    ],
  };
}
