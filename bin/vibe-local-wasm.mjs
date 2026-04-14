#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const [command = "help", ...rest] = process.argv.slice(2);

const scriptMap = {
  agentos: ["run", "agentos"],
  build: ["run", "build"],
  check: ["run", "check"],
  dev: ["run", "dev"],
  doctor: ["run", "doctor"],
  smoke: ["run", "smoke"],
};

function printHelp() {
  process.stdout.write(
    [
      "vibe-local-wasm",
      "",
      "Usage:",
      "  vibe-local-wasm dev",
      "  vibe-local-wasm agentos",
      "  vibe-local-wasm chat <project> [--mode plan|act|yolo]",
      "  vibe-local-wasm cli <args...>",
      "",
      "Any unknown subcommand is forwarded to the actor-backed CLI.",
    ].join("\n"),
  );
}

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

const args =
  command === "cli"
    ? ["run", "cli", "--", ...rest]
    : command in scriptMap
      ? scriptMap[command]
      : ["run", "cli", "--", command, ...rest];

const child = spawn("pnpm", args, {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
