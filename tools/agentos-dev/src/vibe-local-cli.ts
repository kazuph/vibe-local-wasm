import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { createClient } from "rivetkit/client";

import { AGENTOS_PORT } from "./config.js";
import { registry } from "./registry.js";
import {
  FixedFooter,
  bold,
  cyan,
  dim,
  errorColor,
  formatToolEvent,
  gray,
  infoColor,
  promptColor,
  yellow,
} from "./tui.js";

type OpenCodeConfig = {
  provider?: Record<
    string,
    {
      models?: Record<string, { name?: string }>;
      options?: {
        apiKey?: string;
        baseURL?: string;
      };
    }
  >;
};

type BackendSettings = {
  apiKey: string;
  baseUrl: string;
  maxTokens: number;
  model: string;
  systemPrompt: string;
  temperature: number;
};

type SessionSnapshot = Awaited<ReturnType<Awaited<ReturnType<typeof getActor>>["exportSession"]>>;

function summarizeCliToolInput(input: Record<string, unknown>) {
  const entries = Object.entries(input);
  if (entries.length === 0) {
    return "入力なし";
  }
  return entries
    .map(([key, value]) =>
      `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join(" ");
}

async function watchSessionProgress(
  actor: Awaited<ReturnType<typeof getActor>>,
  sessionId: string,
  work: Promise<unknown>,
  footer?: FixedFooter,
) {
  let settled = false;
  let workError: unknown = null;
  let lastAssistantText = "";
  const seenToolEvents = new Set<string>();

  // Capture error to throw after polling ends, prevent unhandled rejection crash
  work.catch((err) => { workError = err; }).finally(() => {
    settled = true;
  });

  footer?.update({ status: "generating…" });

  while (!settled) {
    let snapshot: SessionSnapshot | null = null;
    try {
      snapshot = (await actor.exportSession(sessionId)) as SessionSnapshot | null;
    } catch {
      // polling may fail transiently; keep trying until work settles
      await new Promise((resolve) => setTimeout(resolve, 350));
      continue;
    }
    if (snapshot) {
      const orderedArtifacts = [...snapshot.artifacts].sort(
        (left, right) =>
          new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
      );
      for (const artifact of orderedArtifacts) {
        if (artifact.kind !== "agent_tool_event") {
          continue;
        }
        if (seenToolEvents.has(artifact.id)) {
          continue;
        }
        seenToolEvents.add(artifact.id);
        const payload = artifact.payload as Record<string, unknown>;
        const toolName = typeof payload.name === "string" ? payload.name : "unknown";
        const toolStatus = typeof payload.status === "string" ? payload.status : "running";
        const toolInput = payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
          ? summarizeCliToolInput(payload.input as Record<string, unknown>)
          : undefined;
        console.log(formatToolEvent(toolName, toolStatus, toolInput));
        footer?.update({ status: `tool: ${toolName}` });
      }

      const partialText = snapshot.task?.status === "running" ? snapshot.task.lastResponse ?? "" : "";
      if (partialText.startsWith(lastAssistantText) && partialText.length > lastAssistantText.length) {
        process.stdout.write(partialText.slice(lastAssistantText.length));
        lastAssistantText = partialText;
      } else if (partialText && partialText !== lastAssistantText) {
        process.stdout.write(`\n${partialText}`);
        lastAssistantText = partialText;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  let finalSnapshot: SessionSnapshot | null = null;
  try {
    finalSnapshot = (await actor.exportSession(sessionId)) as SessionSnapshot | null;
  } catch {
    // best-effort final read
  }
  const finalText = finalSnapshot?.task?.lastResponse ?? "";
  if (finalText.startsWith(lastAssistantText) && finalText.length > lastAssistantText.length) {
    process.stdout.write(finalText.slice(lastAssistantText.length));
    lastAssistantText = finalText;
  } else if (finalText && finalText !== lastAssistantText) {
    process.stdout.write(`\n${finalText}`);
    lastAssistantText = finalText;
  }

  if (lastAssistantText) {
    process.stdout.write("\n");
  }

  footer?.update({ status: "idle" });

  // Re-throw captured error so caller's try-catch sees it
  if (workError) {
    throw workError;
  }
}

function usage() {
  console.log(`Usage:
  pnpm run cli -- chat <project> [--mode plan|act|yolo]`);
}

let managerStarted = false;

async function ensureManager() {
  if (managerStarted) return;
  registry.start();
  managerStarted = true;
  // Give the HTTP server a moment to bind
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function getActor() {
  await ensureManager();
  const endpoint = `http://127.0.0.1:${AGENTOS_PORT}`;
  const client = createClient(endpoint) as any;
  return client.vibeLocal.getOrCreate(["browser-core"]);
}

function loadBackendSettings(): BackendSettings {
  const configPath = path.join(homedir(), ".config", "opencode", "config.json");
  if (!existsSync(configPath)) {
    throw new Error(`OpenCode config not found at ${configPath}`);
  }

  const payload = JSON.parse(readFileSync(configPath, "utf8")) as OpenCodeConfig;
  const providerEntries = Object.entries(payload.provider ?? {});
  const preferred =
    providerEntries.find(([key]) => key === "qwen-local") ??
    providerEntries.find(([, value]) => Object.keys(value.models ?? {}).length > 0) ??
    null;

  if (!preferred) {
    throw new Error("No OpenCode provider with models found.");
  }

  const [, providerConfig] = preferred;
  const firstModelEntry = Object.entries(providerConfig.models ?? {})[0];
  if (!firstModelEntry) {
    throw new Error("Selected OpenCode provider has no models.");
  }

  return {
    apiKey: providerConfig.options?.apiKey ?? "",
    baseUrl: providerConfig.options?.baseURL ?? "",
    model: firstModelEntry[0],
    maxTokens: 4096,
    systemPrompt: "You are a helpful coding assistant. Be concise.",
    temperature: 0.2,
  };
}

async function runInteractiveChat(
  actor: Awaited<ReturnType<typeof getActor>>,
  project: string,
  initialMode: "act" | "plan" | "yolo",
) {
  const settings = loadBackendSettings();
  const session = await actor.createSession(`CLI chat ${project}`);
  let mode = initialMode;
  let currentProject = project;
  await actor.setSessionConfig(session.session.id, settings.model, mode);

  // Set up DECSTBM fixed footer
  const footer = new FixedFooter({
    model: settings.model,
    mode,
    project: currentProject,
    sessionId: session.session.id.slice(0, 8),
  });
  footer.setup();

  const rl = createInterface({ input, output });
  console.log(infoColor(`session=${session.session.id.slice(0, 8)} project=${currentProject} mode=${mode}`));
  console.log(gray("Type a message or use /help for commands."));

  try {
    while (true) {
      let rawLine = "";
      try {
        rawLine = await rl.question(promptColor(`${mode}:${currentProject}> `));
      } catch (error) {
        if (error instanceof Error && error.message.includes("readline was closed")) {
          break;
        }
        throw error;
      }
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      if (line === "/exit" || line === "/quit") {
        break;
      }

      if (line === "/help") {
        console.log(bold("Available commands:"));
        console.log(`  ${cyan("/help")}          Show this help`);
        console.log(`  ${cyan("/exit")}          Exit session`);
        console.log(`  ${cyan("/clear")}         Clear conversation`);
        console.log(`  ${cyan("/plan")}          Enter Plan mode (read-only)`);
        console.log(`  ${cyan("/approve")}       Switch to Act mode`);
        console.log(`  ${cyan("/status")}        Show session info`);
        console.log(`  ${cyan("/compact")}       Compress conversation history`);
        console.log(`  ${cyan("/model")} ${gray("<name>")}  Switch model`);
        continue;
      }

      if (line === "/clear") {
        // Clear screen and reset conversation display
        process.stdout.write("\x1b[2J\x1b[1;1H");
        footer.setup(); // Re-draw footer after clear
        console.log(infoColor("conversation display cleared"));
        continue;
      }

      if (line === "/status") {
        const snapshot = (await actor.exportSession(session.session.id)) as SessionSnapshot | null;
        const msgCount = snapshot?.messages.length ?? 0;
        const pendingCount = snapshot?.approvals.filter(
          (a: SessionSnapshot["approvals"][number]) => a.status === "pending",
        ).length ?? 0;
        const subAgentCount = snapshot?.subAgents.length ?? 0;
        console.log(bold("Session Status:"));
        console.log(`  ${gray("session")}  ${session.session.id.slice(0, 8)}`);
        console.log(`  ${gray("model")}    ${cyan(settings.model)}`);
        console.log(`  ${gray("mode")}     ${mode}`);
        console.log(`  ${gray("project")}  ${currentProject}`);
        console.log(`  ${gray("messages")} ${msgCount}`);
        if (pendingCount > 0) console.log(`  ${yellow(`approvals: ${pendingCount} pending`)}`);
        if (subAgentCount > 0) console.log(`  ${gray(`sub-agents: ${subAgentCount}`)}`);
        continue;
      }

      if (line === "/compact") {
        try {
          await actor.compactSession(session.session.id);
          console.log(infoColor("session compacted"));
        } catch (err) {
          console.log(errorColor(`compact failed: ${err instanceof Error ? err.message : String(err)}`));
        }
        continue;
      }

      if (line.startsWith("/model ")) {
        const nextModel = line.slice("/model ".length).trim();
        if (!nextModel) {
          console.log(yellow("/model <name>"));
          continue;
        }
        settings.model = nextModel;
        await actor.setSessionConfig(session.session.id, settings.model, mode);
        footer.update({ model: nextModel });
        console.log(infoColor(`model → ${nextModel}`));
        continue;
      }

      if (line === "/plan") {
        mode = "plan";
        await actor.setSessionConfig(session.session.id, settings.model, mode);
        footer.update({ mode });
        console.log(infoColor(`mode → ${mode}`));
        continue;
      }

      if (line === "/approve" || line === "/act") {
        mode = "act";
        await actor.setSessionConfig(session.session.id, settings.model, mode);
        footer.update({ mode });
        console.log(infoColor(`mode → ${mode}`));
        continue;
      }



      try {
        const runPromise = actor.runAgentTurn(session.session.id, line, settings, currentProject);
        await watchSessionProgress(actor, session.session.id, runPromise, footer);
        const result = (await runPromise) as Record<string, unknown>;
        // Check for structured error response (actor returns error instead of throwing)
        if (result?.error && typeof result.error === "string") {
          footer.update({ status: "error" });
          console.log(errorColor(`agent error: ${result.error}`));
        } else {
          const taskStatus = (result?.task as Record<string, unknown>)?.status ?? "unknown";
          console.log(dim(`task: ${taskStatus}`));
        }
      } catch (err) {
        footer.update({ status: "error" });
        const msg = err instanceof Error ? err.message : String(err);
        console.log(errorColor(`agent error: ${msg}`));
        if (msg.includes("Internal error") || msg.includes("internal_error")) {
          console.log(yellow("hint: check backend settings with /status, or server logs with AGENTOS_DEBUG=1"));
        }
      }
    }
  } finally {
    footer.teardown();
    rl.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...args] = normalizedArgv;
  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }

  const actor = await getActor();

  switch (command) {
    case "chat": {
      const project = args[0];
      if (!project) {
        throw new Error("Missing <project>");
      }
      const modeIndex = args.findIndex((token) => token === "--mode");
      let mode: "act" | "plan" | "yolo" = "act";
      if (modeIndex >= 0) {
        const candidate = args[modeIndex + 1];
        if (candidate !== "act" && candidate !== "plan" && candidate !== "yolo") {
          throw new Error("chat --mode must be one of act, plan, or yolo");
        }
        mode = candidate;
      }
      await runInteractiveChat(actor, project, mode);
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
