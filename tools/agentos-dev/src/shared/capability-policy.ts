/**
 * Shared capability policy — path sandboxing, executable validation,
 * and result formatting rules used by BOTH the Pyodide sync bridge
 * (pyodide-runtime.ts) and the async structured tools (src/tools/*.ts).
 *
 * This module contains ONLY synchronous pure functions and constants.
 * No I/O, no Node APIs beyond path.
 *
 * Milestone 2 goal: both execution planes derive their policy from this
 * single source of truth, so capability rules cannot diverge.
 */

import path from "node:path";

// ── Path sandbox constants ──────────────────────────────────────────

export const SYSTEM_EXEC_DIRS = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/libexec",
  "/usr/local/bin",
  "/opt/homebrew/bin",
] as const;

export const BLOCKED_EXECUTABLES = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "fish",
  "python",
  "python3",
  "node",
  "nodejs",
  "ruby",
  "perl",
  "php",
  "lua",
  "osascript",
]);

export const PATH_VALUE_FLAGS = new Set([
  "-C",
  "--git-dir",
  "--work-tree",
  "--file",
  "--output",
  "--input",
]);

export const WATCH_IGNORED_DIRS = [
  "node_modules",
  ".git",
  ".vibe-local",
  "dist",
  ".agentos-dev",
] as const;

export const WATCH_IGNORED_EXTS = [
  ".db",
  ".sqlite",
  ".sqlite3",
  ".log",
  ".tmp",
] as const;

// ── Path containment ────────────────────────────────────────────────

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isAllowedAccessPath(
  candidate: string,
  executionRoot: string,
  tmpRoot: string,
): boolean {
  return isPathInside(executionRoot, candidate) || isPathInside(tmpRoot, candidate);
}

export function resolveAccessPath(
  raw: string,
  executionRoot: string,
  tmpRoot: string,
  baseDir?: string,
): string {
  if (!raw) throw new Error("Empty path");
  const effectiveBase = baseDir ?? executionRoot;
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(effectiveBase, raw);
  if (!isAllowedAccessPath(absolute, executionRoot, tmpRoot)) {
    throw new Error(`Path outside execution root is not allowed: ${raw}`);
  }
  return absolute;
}

export function isSystemExecutablePath(candidate: string): boolean {
  return (SYSTEM_EXEC_DIRS as readonly string[]).some((root) =>
    isPathInside(root, candidate),
  );
}

export function resolveExecutable(command: string, cwd: string, executionRoot: string, tmpRoot: string): string {
  const executableName = path.basename(command);
  if (BLOCKED_EXECUTABLES.has(executableName)) {
    throw new Error(`Executable '${executableName}' is blocked by the access policy`);
  }
  if (!command.includes("/") && !path.isAbsolute(command)) {
    return command;
  }
  const absolute = path.isAbsolute(command) ? path.resolve(command) : path.resolve(cwd, command);
  if (!isAllowedAccessPath(absolute, executionRoot, tmpRoot) && !isSystemExecutablePath(absolute)) {
    throw new Error(`Executable outside execution root is not allowed: ${command}`);
  }
  return absolute;
}

// ── URL detection ────────────────────────────────────────────────────

export function looksLikeUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

// ── Argument validation ──────────────────────────────────────────────

export function validatePathLikeArg(
  value: string,
  cwd: string,
  executionRoot: string,
  tmpRoot: string,
): void {
  if (!value || value === "-" || looksLikeUrl(value)) {
    return;
  }
  if (
    path.isAbsolute(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.includes("/")
  ) {
    resolveAccessPath(value, executionRoot, tmpRoot, cwd);
  }
}

export function validateCommandArgs(
  args: string[],
  cwd: string,
  executionRoot: string,
  tmpRoot: string,
): void {
  let expectPathValue = false;
  for (const arg of args) {
    if (expectPathValue) {
      validatePathLikeArg(arg, cwd, executionRoot, tmpRoot);
      expectPathValue = false;
      continue;
    }
    if (PATH_VALUE_FLAGS.has(arg)) {
      expectPathValue = true;
      continue;
    }
    if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      validatePathLikeArg(arg.split("=", 2)[1] ?? "", cwd, executionRoot, tmpRoot);
      continue;
    }
    validatePathLikeArg(arg, cwd, executionRoot, tmpRoot);
  }
}

// ── Result formatting helpers ───────────────────────────────────────

export function truncateContent(value: string, limit: number, suffix: string): string {
  return value.length > limit ? `${value.slice(0, limit)}${suffix}` : value;
}

export function formatToolResult(ok: boolean, output?: string, error?: string): string {
  return JSON.stringify({ ok, output, error });
}

export function stripHtmlTags(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}