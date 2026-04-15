import { hostTool, toolKit } from "@rivet-dev/agent-os-core";
import { z } from "zod";

import {
  discoverProjects,
  readProjectPackageJson,
  resolveProject,
  runProjectScript,
} from "./projects.js";
import { runGit, searchCode } from "./shared/git-utils.js";

export const repoToolkit = toolKit({
  name: "repo",
  description: "Inspect projects in vibe-local-wasm and run project-local scripts from the host.",
  tools: {
    listProjects: hostTool({
      description: "List app projects discovered from package.json files in this repository.",
      inputSchema: z.object({}),
      async execute() {
        return discoverProjects();
      },
      examples: [{ description: "List every app", input: {} }],
    }),
    projectInfo: hostTool({
      description: "Read package metadata and scripts for one project by path or package name.",
      inputSchema: z.object({
        project: z.string().min(1),
      }),
      async execute({ project }) {
        const info = await resolveProject(project);
        const pkg = await readProjectPackageJson(project);
        return {
          ...info,
          packageJson: pkg,
        };
      },
      examples: [
        {
          description: "Inspect the active CLI/runtime package",
          input: { project: "@vibe-local-wasm/agentos" },
        },
      ],
    }),
    runScript: hostTool({
      description: "Run pnpm scripts inside one project from the host and capture stdout and stderr.",
      inputSchema: z.object({
        project: z.string().min(1),
        script: z.string().min(1),
        timeoutMs: z.number().int().positive().max(600_000).default(120_000),
      }),
      async execute({ project, script, timeoutMs }) {
        return runProjectScript(project, script, timeoutMs);
      },
      examples: [
        {
          description: "Run the CLI/runtime checks",
          input: { project: "@vibe-local-wasm/agentos", script: "check", timeoutMs: 120000 },
        },
      ],
    }),
    searchCode: hostTool({
      description: "Search the monorepo with ripgrep and return matching lines for a query.",
      inputSchema: z.object({
        query: z.string().min(1),
        maxResults: z.number().int().positive().max(200).default(50),
      }),
      async execute({ query, maxResults }) {
        return {
          query,
          matches: await searchCode(query, maxResults),
        };
      },
      examples: [
        {
          description: "Find where localStorage is used",
          input: { query: "localStorage", maxResults: 20 },
        },
      ],
    }),
  },
});

export const gitToolkit = toolKit({
  name: "git",
  description: "Expose safe git inspection tools for the host repository.",
  tools: {
    status: hostTool({
      description: "Show the current branch and porcelain status for the host repository.",
      inputSchema: z.object({}),
      async execute() {
        const branch = await runGit(["branch", "--show-current"]);
        const status = await runGit(["status", "--short"]);
        return {
          branch: branch.stdout.trim(),
          status: status.stdout.trim().split("\n").filter(Boolean),
        };
      },
      examples: [{ description: "Read the git status", input: {} }],
    }),
    diffStat: hostTool({
      description: "Show a compact git diff summary for the host repository.",
      inputSchema: z.object({}),
      async execute() {
        const diff = await runGit(["diff", "--stat"]);
        return {
          ok: diff.ok,
          diffStat: diff.stdout.trim(),
          stderr: diff.stderr.trim(),
        };
      },
      examples: [{ description: "Read the current diff stat", input: {} }],
    }),
  },
});
