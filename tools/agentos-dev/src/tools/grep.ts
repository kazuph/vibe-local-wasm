import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";

import { resolveAccessPath } from "../shared/capability-policy.js";

const SANDBOX_TMP_ROOT = path.resolve(
  process.env.TMPDIR ?? process.env.TEMP ?? "/tmp",
);

const execFileAsync = promisify(execFile);

export const grepInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  case_insensitive: z.boolean().default(false),
  multiline: z.boolean().default(false),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .default("files_with_matches"),
  context: z.number().int().min(0).max(10).default(0),
  max_results: z.number().int().positive().max(500).default(100),
});

export type GrepInput = z.infer<typeof grepInputSchema>;

export type GrepMatch = {
  file: string;
  line?: number;
  text?: string;
};

export type GrepResult = {
  ok: boolean;
  pattern: string;
  mode: string;
  matches: GrepMatch[];
  totalMatches?: number;
  truncated: boolean;
  error?: string;
};

export async function runGrep(
  input: GrepInput,
  repoRoot: string
): Promise<GrepResult> {
  let searchPath: string;
  if (input.path) {
    try {
      searchPath = resolveAccessPath(input.path, repoRoot, SANDBOX_TMP_ROOT, repoRoot);
    } catch {
      return {
        ok: false,
        pattern: input.pattern,
        mode: input.output_mode,
        matches: [],
        truncated: false,
        error: `Path "${input.path}" is outside the allowed sandbox`,
      };
    }
  } else {
    searchPath = repoRoot;
  }

  const args: string[] = [];

  // Mode-specific flags
  if (input.output_mode === "content") {
    args.push("-n");
  } else if (input.output_mode === "files_with_matches") {
    args.push("-l");
  } else if (input.output_mode === "count") {
    args.push("-c");
  }

  // Common flags
  args.push("--hidden");
  args.push("--glob", "!**/node_modules/**");
  args.push("--glob", "!**/.git/**");

  // User glob filter
  if (input.glob) {
    args.push("--glob", input.glob);
  }

  // Case insensitive
  if (input.case_insensitive) {
    args.push("-i");
  }

  // Multiline
  if (input.multiline) {
    args.push("-U", "--multiline-dotall");
  }

  // Context lines (only meaningful for content mode)
  if (input.context > 0 && input.output_mode === "content") {
    args.push("-C", String(input.context));
  }

  // Pattern and path
  args.push(input.pattern, searchPath);

  let stdout = "";
  let exitCode = 0;

  try {
    const result = await execFileAsync("rg", args, {
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    // When execFile rejects due to non-zero exit, the error object carries
    // { code: exitCode (number), stdout, stderr } from child_process.
    const error = err as {
      code?: unknown;
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    const exitCode =
      typeof error.code === "number" ? error.code : Number(error.code);

    // rg exits with code 1 when no matches found — treat as success
    if (exitCode === 1) {
      return {
        ok: true,
        pattern: input.pattern,
        mode: input.output_mode,
        matches: [],
        truncated: false,
        totalMatches: input.output_mode === "count" ? 0 : undefined,
      };
    }

    // Exit code 2+ is a real error
    return {
      ok: false,
      pattern: input.pattern,
      mode: input.output_mode,
      matches: [],
      truncated: false,
      error: error.stderr ?? error.message ?? String(err),
    };
  }

  const lines = stdout.split("\n").filter((l) => l.length > 0);

  // Convert absolute path to repo-relative
  const toRelative = (absPath: string): string => {
    if (absPath.startsWith(repoRoot + "/")) {
      return absPath.slice(repoRoot.length + 1);
    }
    return absPath;
  };

  if (input.output_mode === "files_with_matches") {
    const allMatches: GrepMatch[] = lines.map((line) => ({
      file: toRelative(line.trim()),
    }));
    const truncated = allMatches.length > input.max_results;
    return {
      ok: true,
      pattern: input.pattern,
      mode: input.output_mode,
      matches: allMatches.slice(0, input.max_results),
      truncated,
    };
  }

  if (input.output_mode === "count") {
    let totalMatches = 0;
    const allMatches: GrepMatch[] = [];

    for (const line of lines) {
      // Format: path:N
      const colonIdx = line.lastIndexOf(":");
      if (colonIdx === -1) continue;
      const filePart = line.slice(0, colonIdx);
      const countPart = line.slice(colonIdx + 1);
      const count = parseInt(countPart, 10);
      if (isNaN(count)) continue;
      totalMatches += count;
      allMatches.push({ file: toRelative(filePart) });
    }

    const truncated = allMatches.length > input.max_results;
    return {
      ok: true,
      pattern: input.pattern,
      mode: input.output_mode,
      matches: allMatches.slice(0, input.max_results),
      totalMatches,
      truncated,
    };
  }

  // content mode: lines like path:line:text
  // Context separator lines from -C look like "path-line-text" (with dashes) or "--"
  const allMatches: GrepMatch[] = [];

  for (const line of lines) {
    // Skip context separator lines (rg outputs "--" between context blocks)
    if (line === "--") continue;

    // rg content output with -n: "path:linenum:text"
    // With context (-C), context lines use "path-linenum-text" format
    // We only capture the match lines (colon-separated)
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const afterPath = line.slice(colonIdx + 1);
    const secondColonIdx = afterPath.indexOf(":");
    if (secondColonIdx === -1) continue;

    const filePart = line.slice(0, colonIdx);
    const lineNumStr = afterPath.slice(0, secondColonIdx);
    const text = afterPath.slice(secondColonIdx + 1);
    const lineNum = parseInt(lineNumStr, 10);

    allMatches.push({
      file: toRelative(filePart),
      line: isNaN(lineNum) ? undefined : lineNum,
      text,
    });
  }

  const truncated = allMatches.length > input.max_results;
  return {
    ok: true,
    pattern: input.pattern,
    mode: input.output_mode,
    matches: allMatches.slice(0, input.max_results),
    truncated,
  };
}
