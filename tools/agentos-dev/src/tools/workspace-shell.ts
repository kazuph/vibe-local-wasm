import path from "node:path";

import {
  Bash,
  InMemoryFs,
  MountableFs,
  OverlayFs,
  ReadWriteFs,
  type CommandName,
} from "just-bash";
import { z } from "zod";

import { REPO_ROOT, WRITABLE_WORKSPACE_ROOT } from "../config.js";

const VIRTUAL_REPO_ROOT = "/mnt/repo";
const VIRTUAL_WORKSPACE_ROOT = "/mnt/workspace";
const MAX_STDIO_BYTES = 2_000_000;

const WORKSPACE_SHELL_COMMANDS: CommandName[] = [
  "alias",
  "awk",
  "basename",
  "cat",
  "chmod",
  "clear",
  "column",
  "comm",
  "cp",
  "cut",
  "date",
  "diff",
  "dirname",
  "du",
  "echo",
  "env",
  "expand",
  "expr",
  "false",
  "fgrep",
  "file",
  "find",
  "fold",
  "grep",
  "head",
  "help",
  "join",
  "ln",
  "ls",
  "md5sum",
  "mkdir",
  "mv",
  "nl",
  "od",
  "paste",
  "printf",
  "printenv",
  "pwd",
  "readlink",
  "rev",
  "rg",
  "rm",
  "rmdir",
  "sed",
  "sha1sum",
  "sha256sum",
  "sort",
  "stat",
  "strings",
  "tac",
  "tail",
  "tee",
  "touch",
  "tree",
  "tr",
  "true",
  "unalias",
  "unexpand",
  "uniq",
  "wc",
  "which",
  "whoami",
  "xargs",
] satisfies CommandName[];

export const workspaceShellInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
});

export type WorkspaceShellInput = z.infer<typeof workspaceShellInputSchema>;

export type WorkspaceShellResult = {
  cwd: string;
  exitCode: number;
  ok: boolean;
  plane: "workspace-surface";
  stderr: string;
  stdout: string;
  truncated: boolean;
};

function truncateOutput(value: string) {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= MAX_STDIO_BYTES) {
    return { value, truncated: false };
  }
  return {
    value: buffer.subarray(0, MAX_STDIO_BYTES).toString("utf8"),
    truncated: true,
  };
}

function resolveVirtualCwd(input?: string) {
  if (!input) {
    return VIRTUAL_WORKSPACE_ROOT;
  }

  const candidate = input.startsWith("/")
    ? path.posix.normalize(input)
    : path.posix.resolve(VIRTUAL_WORKSPACE_ROOT, input);

  if (
    candidate === VIRTUAL_REPO_ROOT ||
    candidate.startsWith(`${VIRTUAL_REPO_ROOT}/`) ||
    candidate === VIRTUAL_WORKSPACE_ROOT ||
    candidate.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)
  ) {
    return candidate;
  }

  throw new Error(`workspaceShell cwd must stay under ${VIRTUAL_REPO_ROOT} or ${VIRTUAL_WORKSPACE_ROOT}`);
}

function createWorkspaceShell(cwd: string) {
  const fs = new MountableFs({ base: new InMemoryFs() });
  fs.mount(
    VIRTUAL_REPO_ROOT,
    new OverlayFs({
      root: REPO_ROOT,
      mountPoint: VIRTUAL_REPO_ROOT,
      readOnly: true,
    }),
  );
  fs.mount(
    VIRTUAL_WORKSPACE_ROOT,
    new ReadWriteFs({
      root: WRITABLE_WORKSPACE_ROOT,
    }),
  );

  return new Bash({
    commands: WORKSPACE_SHELL_COMMANDS,
    cwd,
    env: {
      HOME: VIRTUAL_WORKSPACE_ROOT,
      PWD: cwd,
      REPO_ROOT: VIRTUAL_REPO_ROOT,
      WORKSPACE_ROOT: VIRTUAL_WORKSPACE_ROOT,
    },
    fs,
  });
}

export async function runWorkspaceShell(input: WorkspaceShellInput): Promise<WorkspaceShellResult> {
  const cwd = resolveVirtualCwd(input.cwd);
  const shell = createWorkspaceShell(cwd);
  const result = await shell.exec(input.command, { cwd });
  const stdout = truncateOutput(result.stdout);
  const stderr = truncateOutput(result.stderr);

  return {
    cwd,
    exitCode: result.exitCode,
    ok: result.exitCode === 0,
    plane: "workspace-surface",
    stdout: stdout.value,
    stderr: stderr.value,
    truncated: stdout.truncated || stderr.truncated,
  };
}
