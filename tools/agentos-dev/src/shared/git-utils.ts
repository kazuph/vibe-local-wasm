/**
 * Shared git and code-search utilities.
 *
 * Extracted from vibe-local-actor.ts and toolkits.ts to eliminate duplication.
 */

import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { REPO_ROOT } from "../config.js";

const execFileAsync = promisify(execFile);
const SANDBOX_HOME = path.join(tmpdir(), "vibe-local-wasm-home");
const SANDBOX_CONFIG_HOME = path.join(SANDBOX_HOME, ".config");
const SANDBOX_CACHE_HOME = path.join(SANDBOX_HOME, ".cache");
const SANDBOX_DATA_HOME = path.join(SANDBOX_HOME, ".local", "share");

mkdirSync(SANDBOX_HOME, { recursive: true });
mkdirSync(SANDBOX_CONFIG_HOME, { recursive: true });
mkdirSync(SANDBOX_CACHE_HOME, { recursive: true });
mkdirSync(SANDBOX_DATA_HOME, { recursive: true });

function childProcessEnv() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: SANDBOX_HOME,
    XDG_CACHE_HOME: SANDBOX_CACHE_HOME,
    XDG_CONFIG_HOME: SANDBOX_CONFIG_HOME,
    XDG_DATA_HOME: SANDBOX_DATA_HOME,
  };
}

export type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

/** Run a git command in the repository root. */
export async function runGit(args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: REPO_ROOT,
      env: childProcessEnv(),
      timeout: 20_000,
      maxBuffer: 1024 * 1024 * 2,
    });

    return { ok: true, stdout, stderr };
  } catch (error) {
    const typed = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? typed.message ?? "",
    };
  }
}

/** Search the monorepo with ripgrep, excluding node_modules and .git. */
export async function searchCode(query: string, maxResults: number): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "rg",
    [
      "-n",
      "--hidden",
      "--glob",
      "!**/node_modules/**",
      "--glob",
      "!**/.git/**",
      "--glob",
      "!tools/agentos-dev/node_modules/**",
      query,
      REPO_ROOT,
    ],
    {
      cwd: REPO_ROOT,
      env: childProcessEnv(),
      timeout: 20_000,
      maxBuffer: 1024 * 1024 * 4,
    },
  );

  const lines = stdout.trim().split("\n").filter(Boolean);
  return lines.slice(0, maxResults);
}
