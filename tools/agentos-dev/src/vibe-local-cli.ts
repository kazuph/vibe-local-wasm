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
  contextWindow: number;
  maxTokens: number;
  model: string;
  systemPrompt: string;
  temperature: number;
};

type SessionSnapshot = Awaited<ReturnType<Awaited<ReturnType<typeof getActor>>["exportSession"]>>;
type SessionList = Awaited<ReturnType<Awaited<ReturnType<typeof getActor>>["hydrate"]>>;
type SessionMode = "act" | "plan" | "yolo";

type ChatCliOptions = {
  contextWindow?: number;
  debug: boolean;
  listSessions: boolean;
  maxTokens?: number;
  mode?: SessionMode;
  model?: string;
  ollamaHost?: string;
  project?: string;
  prompt?: string;
  resume: boolean;
  sessionId?: string;
  temperature?: number;
  version: boolean;
  yes: boolean;
};

type ResolvedChatSession = {
  mode: SessionMode;
  project: string;
  sessionId: string;
  snapshot: NonNullable<SessionSnapshot>;
};

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

  work.catch((err) => { workError = err; }).finally(() => {
    settled = true;
  });

  footer?.update({ status: "generating…" });

  while (!settled) {
    let snapshot: SessionSnapshot | null = null;
    try {
      snapshot = (await actor.exportSession(sessionId)) as SessionSnapshot | null;
    } catch {
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

  if (workError) {
    throw workError;
  }
}

function usage() {
  console.log(`Usage:
  pnpm run cli -- chat <project> [options]
  pnpm run cli -- chat --resume [project] [options]
  pnpm run cli -- chat --session-id <id> [project] [options]
  pnpm run cli -- chat --list-sessions

Options:
  -p, --prompt <text>         Run one prompt and exit
  -m, --model <name>          Override model
  -y, --yes                   Enable YOLO/auto-approve mode
      --debug                 Print resolved CLI settings
      --resume                Resume the most recently updated session
      --session-id <id>       Resume a specific session
      --list-sessions         List saved sessions and exit
      --ollama-host <url>     Override backend base URL
      --max-tokens <n>        Override max output tokens
      --temperature <n>       Override sampling temperature
      --context-window <n>    Store the requested context window setting
      --version               Print CLI version`);
}

let managerStarted = false;

async function ensureManager() {
  if (managerStarted) return;
  registry.start();
  managerStarted = true;
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
    contextWindow: 4096,
    model: firstModelEntry[0],
    maxTokens: 4096,
    systemPrompt: "You are a helpful coding assistant. Be concise.",
    temperature: 0.2,
  };
}

function readCliVersion() {
  const packageJsonPath = new URL("../../../package.json", import.meta.url);
  const payload = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
  return payload.version ?? "0.0.0";
}

function parseIntegerFlag(value: string, flag: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} requires an integer.`);
  }
  return parsed;
}

function parseFloatFlag(value: string, flag: string) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} requires a number.`);
  }
  return parsed;
}

function parseChatArgs(args: string[]): ChatCliOptions {
  const options: ChatCliOptions = {
    debug: false,
    listSessions: false,
    resume: false,
    version: false,
    yes: false,
  };

  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    switch (token) {
      case "--mode": {
        const candidate = args[index + 1];
        if (candidate !== "act" && candidate !== "plan" && candidate !== "yolo") {
          throw new Error("chat --mode must be one of act, plan, or yolo");
        }
        options.mode = candidate;
        index += 1;
        break;
      }
      case "--prompt":
      case "-p":
        options.prompt = args[index + 1];
        if (!options.prompt) {
          throw new Error(`${token} requires a value.`);
        }
        index += 1;
        break;
      case "--model":
      case "-m":
        options.model = args[index + 1];
        if (!options.model) {
          throw new Error(`${token} requires a value.`);
        }
        index += 1;
        break;
      case "--yes":
      case "-y":
        options.yes = true;
        break;
      case "--debug":
        options.debug = true;
        break;
      case "--resume":
        options.resume = true;
        break;
      case "--session-id":
        options.sessionId = args[index + 1];
        if (!options.sessionId) {
          throw new Error("--session-id requires a value.");
        }
        index += 1;
        break;
      case "--list-sessions":
        options.listSessions = true;
        break;
      case "--ollama-host":
        options.ollamaHost = args[index + 1];
        if (!options.ollamaHost) {
          throw new Error("--ollama-host requires a value.");
        }
        index += 1;
        break;
      case "--max-tokens":
        if (!args[index + 1]) {
          throw new Error("--max-tokens requires a value.");
        }
        options.maxTokens = parseIntegerFlag(args[index + 1], "--max-tokens");
        index += 1;
        break;
      case "--temperature":
        if (!args[index + 1]) {
          throw new Error("--temperature requires a value.");
        }
        options.temperature = parseFloatFlag(args[index + 1], "--temperature");
        index += 1;
        break;
      case "--context-window":
        if (!args[index + 1]) {
          throw new Error("--context-window requires a value.");
        }
        options.contextWindow = parseIntegerFlag(args[index + 1], "--context-window");
        index += 1;
        break;
      case "--version":
        options.version = true;
        break;
      default:
        if (token.startsWith("-")) {
          throw new Error(`Unknown option: ${token}`);
        }
        positionals.push(token);
        break;
    }
  }

  if (options.resume && options.sessionId) {
    throw new Error("Use either --resume or --session-id, not both.");
  }

  if (positionals.length > 1) {
    throw new Error(`Unexpected extra arguments: ${positionals.slice(1).join(" ")}`);
  }

  if (positionals[0]) {
    options.project = positionals[0];
  }

  return options;
}

function applyFlagOverrides(settings: BackendSettings, options: ChatCliOptions): BackendSettings {
  return {
    ...settings,
    baseUrl: options.ollamaHost ?? settings.baseUrl,
    contextWindow: options.contextWindow ?? settings.contextWindow,
    maxTokens: options.maxTokens ?? settings.maxTokens,
    model: options.model ?? settings.model,
    temperature: options.temperature ?? settings.temperature,
  };
}

function resolveMode(options: ChatCliOptions, snapshot?: NonNullable<SessionSnapshot>): SessionMode {
  if (options.yes) {
    return "yolo";
  }
  return options.mode ?? snapshot?.session.mode ?? "act";
}

function resolveProjectFromSnapshot(snapshot: NonNullable<SessionSnapshot>, fallback?: string) {
  return fallback ?? snapshot.task?.selectedProject ?? "";
}

async function listSessions(actor: Awaited<ReturnType<typeof getActor>>) {
  const payload = (await actor.hydrate()) as SessionList;
  if (payload.sessions.length === 0) {
    console.log("No saved sessions.");
    return;
  }

  for (const snapshot of payload.sessions) {
    const updatedAt = snapshot.session.updatedAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
    console.log(
      [
        snapshot.session.id.slice(0, 8),
        snapshot.session.mode,
        snapshot.session.model || "-",
        updatedAt,
        snapshot.session.title,
      ].join("\t"),
    );
  }
}

async function findSessionByIdPrefix(
  actor: Awaited<ReturnType<typeof getActor>>,
  sessionId: string,
) {
  const exact = (await actor.exportSession(sessionId)) as SessionSnapshot | null;
  if (exact) {
    return exact;
  }

  const payload = (await actor.hydrate()) as SessionList;
  const matches = payload.sessions.filter(
    (snapshot: SessionList["sessions"][number]) => snapshot.session.id.startsWith(sessionId),
  );
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Session id prefix is ambiguous: ${sessionId}`);
  }
  return null;
}

async function resolveChatSession(
  actor: Awaited<ReturnType<typeof getActor>>,
  options: ChatCliOptions,
  settings: BackendSettings,
): Promise<ResolvedChatSession> {
  const mode = resolveMode(options);

  if (options.sessionId) {
    const snapshot = await findSessionByIdPrefix(actor, options.sessionId);
    if (!snapshot) {
      throw new Error(`Unknown session: ${options.sessionId}`);
    }
    const project = resolveProjectFromSnapshot(snapshot, options.project);
    if (!project) {
      throw new Error("Missing <project> for this session. Pass a project argument explicitly.");
    }
    const nextMode = resolveMode(options, snapshot);
    const nextModel = options.model ?? snapshot.session.model ?? settings.model;
    await actor.setSessionConfig(snapshot.session.id, nextModel, nextMode);
    const refreshed = (await actor.exportSession(snapshot.session.id)) as SessionSnapshot | null;
    if (!refreshed) {
      throw new Error(`Unknown session: ${options.sessionId}`);
    }
    return {
      mode: nextMode,
      project,
      sessionId: refreshed.session.id,
      snapshot: refreshed,
    };
  }

  if (options.resume) {
    const payload = (await actor.hydrate()) as SessionList;
    const latest = payload.sessions[0] ?? null;
    if (!latest) {
      throw new Error("No saved sessions found.");
    }
    const project = resolveProjectFromSnapshot(latest, options.project);
    if (!project) {
      throw new Error("Missing <project> for the resumed session. Pass a project argument explicitly.");
    }
    const nextMode = resolveMode(options, latest);
    const nextModel = options.model ?? latest.session.model ?? settings.model;
    await actor.setSessionConfig(latest.session.id, nextModel, nextMode);
    const refreshed = (await actor.exportSession(latest.session.id)) as SessionSnapshot | null;
    if (!refreshed) {
      throw new Error(`Unknown session: ${latest.session.id}`);
    }
    return {
      mode: nextMode,
      project,
      sessionId: refreshed.session.id,
      snapshot: refreshed,
    };
  }

  if (!options.project) {
    throw new Error("Missing <project>");
  }

  const created = await actor.createSession(`CLI chat ${options.project}`);
  await actor.setSessionConfig(created.session.id, settings.model, mode);
  const snapshot = (await actor.exportSession(created.session.id)) as SessionSnapshot | null;
  if (!snapshot) {
    throw new Error(`Unknown session: ${created.session.id}`);
  }
  return {
    mode,
    project: options.project,
    sessionId: snapshot.session.id,
    snapshot,
  };
}

function printDebugSummary(options: ChatCliOptions, resolved: ResolvedChatSession, settings: BackendSettings) {
  console.log(dim("[debug] resolved chat options"));
  console.log(
    JSON.stringify(
      {
        contextWindow: settings.contextWindow,
        maxTokens: settings.maxTokens,
        mode: resolved.mode,
        model: settings.model,
        ollamaHost: settings.baseUrl,
        project: resolved.project,
        prompt: options.prompt ?? null,
        resume: options.resume,
        sessionId: resolved.sessionId,
        temperature: settings.temperature,
        yes: options.yes,
      },
      null,
      2,
    ),
  );
}

async function runSinglePrompt(
  actor: Awaited<ReturnType<typeof getActor>>,
  sessionId: string,
  prompt: string,
  settings: BackendSettings,
  project: string,
) {
  const runPromise = actor.runAgentTurn(sessionId, prompt, settings, project);
  await watchSessionProgress(actor, sessionId, runPromise);
  const result = (await runPromise) as Record<string, unknown>;
  if (result?.error && typeof result.error === "string") {
    throw new Error(result.error);
  }
}

async function runInteractiveChat(
  actor: Awaited<ReturnType<typeof getActor>>,
  sessionId: string,
  project: string,
  initialMode: SessionMode,
  settings: BackendSettings,
) {
  let mode = initialMode;
  let currentProject = project;

  const footer = new FixedFooter({
    model: settings.model,
    mode,
    project: currentProject,
    sessionId: sessionId.slice(0, 8),
  });
  footer.setup();

  const rl = createInterface({ input, output });
  console.log(infoColor(`session=${sessionId.slice(0, 8)} project=${currentProject} mode=${mode}`));
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
        process.stdout.write("\x1b[2J\x1b[1;1H");
        footer.setup();
        console.log(infoColor("conversation display cleared"));
        continue;
      }

      if (line === "/status") {
        const snapshot = (await actor.exportSession(sessionId)) as SessionSnapshot | null;
        const msgCount = snapshot?.messages.length ?? 0;
        console.log(bold("Session Status:"));
        console.log(`  ${gray("session")}  ${sessionId.slice(0, 8)}`);
        console.log(`  ${gray("model")}    ${cyan(settings.model)}`);
        console.log(`  ${gray("mode")}     ${mode}`);
        console.log(`  ${gray("project")}  ${currentProject}`);
        console.log(`  ${gray("messages")} ${msgCount}`);
        if (snapshot?.task?.status) {
          console.log(`  ${gray("task")}     ${snapshot.task.status}`);
        }
        continue;
      }

      if (line === "/compact") {
        try {
          await actor.compactSession(sessionId);
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
        await actor.setSessionConfig(sessionId, settings.model, mode);
        footer.update({ model: nextModel });
        console.log(infoColor(`model → ${nextModel}`));
        continue;
      }

      if (line === "/plan") {
        mode = "plan";
        await actor.setSessionConfig(sessionId, settings.model, mode);
        footer.update({ mode });
        console.log(infoColor(`mode → ${mode}`));
        continue;
      }

      if (line === "/approve" || line === "/act") {
        mode = "act";
        await actor.setSessionConfig(sessionId, settings.model, mode);
        footer.update({ mode });
        console.log(infoColor(`mode → ${mode}`));
        continue;
      }

      try {
        const runPromise = actor.runAgentTurn(sessionId, line, settings, currentProject);
        await watchSessionProgress(actor, sessionId, runPromise, footer);
        const result = (await runPromise) as Record<string, unknown>;
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

  if (command === "--version") {
    console.log(readCliVersion());
    return;
  }

  switch (command) {
    case "chat": {
      const options = parseChatArgs(args);
      if (options.version) {
        console.log(readCliVersion());
        return;
      }
      if (options.debug) {
        process.env.AGENTOS_DEBUG = "1";
      }

      const actor = await getActor();

      if (options.listSessions) {
        await listSessions(actor);
        process.exit(0);
        return;
      }

      const settings = applyFlagOverrides(loadBackendSettings(), options);
      const resolved = await resolveChatSession(actor, options, settings);

      if (options.debug) {
        printDebugSummary(options, resolved, settings);
      }

      if (options.prompt) {
        await runSinglePrompt(actor, resolved.sessionId, options.prompt, settings, resolved.project);
        process.exit(0);
        return;
      }

      await runInteractiveChat(actor, resolved.sessionId, resolved.project, resolved.mode, settings);
      process.exit(0);
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
