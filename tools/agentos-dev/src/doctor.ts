import { access } from "node:fs/promises";
import path from "node:path";

import { AGENTOS_PORT, REPO_ROOT, SANDBOX_AGENT_PORT, TOOL_ROOT } from "./config.js";
import { discoverProjects } from "./projects.js";
import { SANDBOX_DELEGATION_CLASSES, describeExecutionContract } from "./shared/execution-contract.js";
import { describeMcpContract } from "./shared/mcp-contract.js";

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const projects = await discoverProjects();
  const requiredPaths = [
    TOOL_ROOT,
    REPO_ROOT,
    path.join(TOOL_ROOT, "node_modules"),
    path.join(TOOL_ROOT, ".agentos-dev"),
  ];

  console.log("agentOS doctor");
  console.log(`- repo root: ${REPO_ROOT}`);
  console.log(`- tool root: ${TOOL_ROOT}`);
  console.log(`- manager port: ${AGENTOS_PORT}`);
  console.log(`- sandbox-agent port: ${SANDBOX_AGENT_PORT}`);
  console.log(
    `- sandbox delegation classes: ${SANDBOX_DELEGATION_CLASSES.map((entry) => entry.id).join(", ")}`,
  );
  const executionContract = describeExecutionContract();
  const mcpContract = describeMcpContract();
  console.log(
    `- execution planes: ${[executionContract.controlPlane.plane, executionContract.workspaceSurface.plane, executionContract.sandbox.plane].join(", ")}`,
  );
  console.log(`- MCP status: ${mcpContract.status}, spawn in ${mcpContract.executionPlane}`);
  console.log(`- projects discovered: ${projects.length}`);

  for (const target of requiredPaths) {
    console.log(`- path ${target}: ${(await exists(target)) ? "ok" : "missing"}`);
  }

  console.log("");
  console.log("projects");
  for (const project of projects) {
    const scripts = project.scripts.length > 0 ? project.scripts.join(", ") : "(no scripts)";
    console.log(`- ${project.relativePath}: ${scripts}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
