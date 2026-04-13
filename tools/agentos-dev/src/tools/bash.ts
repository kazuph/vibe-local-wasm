import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execAsync = promisify(exec);

export const bashInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().positive().max(600_000).default(60_000),
  max_bytes: z.number().int().positive().max(10_000_000).default(2_000_000),
});

export type BashInput = z.infer<typeof bashInputSchema>;

export type BashResult = {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  signal?: string;
  error?: string;
};

function truncateBuffer(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) {
    return { value, truncated: false };
  }
  return { value: buf.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export async function runBash(input: BashInput, repoRoot: string): Promise<BashResult> {
  const { command, timeout_ms, max_bytes } = input;
  const cwd = input.cwd ?? repoRoot;

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeout_ms,
      killSignal: "SIGTERM",
      maxBuffer: max_bytes,
    });

    const stdoutResult = truncateBuffer(stdout, max_bytes);
    const stderrResult = truncateBuffer(stderr, max_bytes);
    const truncated = stdoutResult.truncated || stderrResult.truncated;

    return {
      ok: true,
      exit_code: 0,
      stdout: stdoutResult.value,
      stderr: stderrResult.value,
      truncated,
    };
  } catch (err: unknown) {
    // exec rejects on non-zero exit OR on kill/timeout
    // The error object from promisified exec has: code, signal, stdout, stderr, killed
    const e = err as {
      code?: number | string;
      signal?: string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      message?: string;
    };

    const rawStdout = typeof e.stdout === "string" ? e.stdout : "";
    const rawStderr = typeof e.stderr === "string" ? e.stderr : "";

    const stdoutResult = truncateBuffer(rawStdout, max_bytes);
    const stderrResult = truncateBuffer(rawStderr, max_bytes);
    const truncated = stdoutResult.truncated || stderrResult.truncated;

    // Timeout / signal kill
    if (e.killed || e.signal != null) {
      return {
        ok: false,
        exit_code: null,
        stdout: stdoutResult.value,
        stderr: stderrResult.value,
        truncated,
        signal: e.signal ?? "SIGTERM",
        error: "timeout",
      };
    }

    // Non-zero exit code (code is numeric)
    const exitCode = typeof e.code === "number" ? e.code : null;
    if (exitCode !== null) {
      return {
        ok: false,
        exit_code: exitCode,
        stdout: stdoutResult.value,
        stderr: stderrResult.value,
        truncated,
      };
    }

    // Command not found or other exec-level error
    return {
      ok: false,
      exit_code: null,
      stdout: stdoutResult.value,
      stderr: stderrResult.value,
      truncated,
      error: e.message ?? String(err),
    };
  }
}
