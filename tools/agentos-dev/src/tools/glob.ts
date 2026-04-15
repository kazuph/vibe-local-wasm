import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { resolveAccessPath } from "../shared/capability-policy.js";

const SANDBOX_TMP_ROOT = path.resolve(
  process.env.TMPDIR ?? process.env.TEMP ?? "/tmp",
);

export const globInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  max_results: z.number().int().positive().max(1000).default(200),
});

export type GlobInput = z.infer<typeof globInputSchema>;

export type GlobResult = {
  ok: boolean;
  pattern: string;
  matches: string[];
  truncated: boolean;
  error?: string;
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "build",
  ".venv",
  "__pycache__",
]);

/**
 * Convert a glob pattern to a RegExp.
 * - `**` → `.*`  (matches anything including /)
 * - `*`  → `[^/]*` (matches anything except /)
 * - `?`  → `.`
 * - `[abc]` → `[abc]` (pass through)
 * - Other regex special chars are escaped.
 */
function globToRegex(pattern: string): RegExp {
  let result = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        result += ".*";
        i += 2;
        // skip optional trailing slash after **
        if (pattern[i] === "/") {
          result += "/?";
          i++;
        }
      } else {
        result += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      result += ".";
      i++;
    } else if (ch === "[") {
      // find closing ]
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        // no closing bracket — treat as literal
        result += "\\[";
        i++;
      } else {
        result += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else if (/[.+^${}()|\\]/.test(ch)) {
      result += "\\" + ch;
      i++;
    } else {
      result += ch;
      i++;
    }
  }

  return new RegExp("^" + result + "$");
}

async function walkDir(
  dir: string,
  matcher: RegExp,
  base: string,
  results: string[],
  limit: number
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // collect a bit more than limit for proper mtime sorting later
    if (results.length >= limit * 2) return;

    if (SKIP_DIRS.has(entry.name)) continue;

    // Also skip nested node_modules inside .worktree
    if (entry.name === "node_modules") continue;

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walkDir(full, matcher, base, results, limit);
    } else if (entry.isFile()) {
      const rel = path.relative(base, full);
      if (matcher.test(rel)) {
        results.push(full);
      }
    }
  }
}

export async function runGlob(
  input: GlobInput,
  repoRoot: string
): Promise<GlobResult> {
  const { pattern, max_results } = input;
  let searchBase: string;
  if (input.path) {
    try {
      searchBase = resolveAccessPath(input.path, repoRoot, SANDBOX_TMP_ROOT, repoRoot);
    } catch {
      return {
        ok: false,
        pattern,
        matches: [],
        truncated: false,
        error: `Path "${input.path}" is outside the allowed sandbox`,
      };
    }
  } else {
    searchBase = repoRoot;
  }

  let matcher: RegExp;
  try {
    matcher = globToRegex(pattern);
  } catch (err) {
    return {
      ok: false,
      pattern,
      matches: [],
      truncated: false,
      error: `Invalid glob pattern: ${String(err)}`,
    };
  }

  const collected: string[] = [];

  try {
    await walkDir(searchBase, matcher, repoRoot, collected, max_results);
  } catch (err) {
    return {
      ok: false,
      pattern,
      matches: [],
      truncated: false,
      error: String(err),
    };
  }

  // stat all collected files for mtime sorting
  type Stamped = { full: string; mtime: number };
  const stamped: Stamped[] = await Promise.all(
    collected.map(async (full) => {
      try {
        const st = await fs.stat(full);
        return { full, mtime: st.mtimeMs };
      } catch {
        return { full, mtime: 0 };
      }
    })
  );

  // sort newest first
  stamped.sort((a, b) => b.mtime - a.mtime);

  const truncated = stamped.length > max_results;
  const final = stamped.slice(0, max_results).map((s) => {
    // return repo-relative path
    const rel = path.relative(repoRoot, s.full);
    // ensure forward slashes on all platforms
    return rel.split(path.sep).join("/");
  });

  return {
    ok: true,
    pattern,
    matches: final,
    truncated,
  };
}
