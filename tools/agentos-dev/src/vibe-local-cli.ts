import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { createClient } from "rivetkit/client";

import { AGENTOS_PORT, REPO_ROOT } from "./config.js";
import { registry } from "./registry.js";
import { runGit } from "./shared/git-utils.js";
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

type AvailableModel = {
  baseUrl: string;
  displayName: string;
  modelId: string;
  providerId: string;
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

type LoadedBackendConfig = {
  configPath: string;
  providers: Array<{
    baseUrl: string;
    id: string;
    models: AvailableModel[];
  }>;
  settings: BackendSettings;
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

function loadBackendConfig(): LoadedBackendConfig {
  const configPath = path.join(homedir(), ".config", "opencode", "config.json");
  if (!existsSync(configPath)) {
    throw new Error(`OpenCode config not found at ${configPath}`);
  }

  const payload = JSON.parse(readFileSync(configPath, "utf8")) as OpenCodeConfig;
  const providers = Object.entries(payload.provider ?? {}).map(([providerId, providerConfig]) => ({
    baseUrl: providerConfig.options?.baseURL ?? "",
    id: providerId,
    models: Object.entries(providerConfig.models ?? {}).map(([modelId, modelConfig]) => ({
      baseUrl: providerConfig.options?.baseURL ?? "",
      displayName: modelConfig.name ?? modelId,
      modelId,
      providerId,
    })),
  }));
  const preferred =
    providers.find((provider) => provider.id === "qwen-local" && provider.models.length > 0) ??
    providers.find((provider) => provider.models.length > 0) ??
    null;

  if (!preferred) {
    throw new Error("No OpenCode provider with models found.");
  }

  return {
    configPath,
    providers,
    settings: {
      apiKey:
        payload.provider?.[preferred.id]?.options?.apiKey ?? "",
      baseUrl: preferred.baseUrl,
      contextWindow: 4096,
      model: preferred.models[0]?.modelId ?? "",
      maxTokens: 4096,
      systemPrompt: "You are a helpful coding assistant. Be concise.",
      temperature: 0.2,
    },
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

function stripReasoningTags(value: string) {
  return value.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function estimateSessionTokens(snapshot: NonNullable<SessionSnapshot>) {
  const messageTokens = snapshot.messages.reduce(
    (sum: number, message: NonNullable<SessionSnapshot>["messages"][number]) =>
      sum + estimateTokens(message.content),
    0,
  );
  const artifactTokens = snapshot.artifacts.reduce((sum: number, artifact: NonNullable<SessionSnapshot>["artifacts"][number]) => {
    if (artifact.kind !== "compaction_summary") {
      return sum;
    }
    const summary = typeof artifact.payload.summary === "string" ? artifact.payload.summary : "";
    return sum + estimateTokens(summary);
  }, 0);
  const taskTokens = snapshot.task?.lastResponse ? estimateTokens(snapshot.task.lastResponse) : 0;
  return messageTokens + artifactTokens + taskTokens;
}

function buildUsageBar(used: number, total: number) {
  const width = 30;
  const pct = total > 0 ? Math.min(Math.round((used / total) * 100), 100) : 0;
  const filled = Math.round((pct / 100) * width);
  return {
    bar: `${"█".repeat(filled)}${"░".repeat(width - filled)}`,
    pct,
  };
}

function splitShellWords(inputText: string) {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (const char of inputText) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped || quote) {
    throw new Error("Unterminated quoted argument.");
  }
  if (current) {
    args.push(current);
  }
  return args;
}

function isDangerousGitArg(arg: string) {
  const normalized = arg.toLowerCase();
  const exact = new Set(["-c"]);
  const prefixes = [
    "--exec-path",
    "--upload-pack",
    "--receive-pack",
    "--config",
    "--config-env",
    "--git-dir",
    "--work-tree",
    "-c=",
  ];
  return exact.has(normalized) || prefixes.some((prefix) => normalized.startsWith(prefix));
}

function listSkillFiles(baseDir: string) {
  if (!existsSync(baseDir)) {
    return [] as Array<{ lines: number; name: string; path: string }>;
  }

  const entries = readdirSync(baseDir, { withFileTypes: true });
  const results: Array<{ lines: number; name: string; path: string }> = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const fullPath = path.join(baseDir, entry.name);
      const lines = readFileSync(fullPath, "utf8").split("\n").length;
      results.push({ lines, name: entry.name.replace(/\.md$/, ""), path: fullPath });
      continue;
    }
    if (entry.isDirectory()) {
      const skillPath = path.join(baseDir, entry.name, "SKILL.md");
      if (existsSync(skillPath) && statSync(skillPath).isFile()) {
        const lines = readFileSync(skillPath, "utf8").split("\n").length;
        results.push({ lines, name: entry.name, path: skillPath });
      }
    }
  }
  return results;
}

async function generateCommitMessage(settings: BackendSettings, diffText: string) {
  const endpoint = `${settings.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
    },
    body: JSON.stringify({
      max_tokens: Math.min(settings.maxTokens, 400),
      messages: [
        {
          content:
            "You are a commit message generator. Given a git diff, write a concise conventional commit message. Use format: <type>: <description>. Keep the first line under 72 characters. Add a blank line and bullet points only if needed. Output only the commit message.",
          role: "system",
        },
        {
          content: `Generate a commit message for this diff:\n\n${diffText}`,
          role: "user",
        },
      ],
      model: settings.model,
      stream: false,
      temperature: Math.min(settings.temperature, 0.3),
    }),
  });

  if (!response.ok) {
    throw new Error(`commit message generation failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const message = stripReasoningTags(payload.choices?.[0]?.message?.content ?? "");
  if (!message) {
    throw new Error("commit message generation returned an empty response.");
  }
  return message;
}

async function promptForCommitMessageOverride(
  rl: ReturnType<typeof createInterface>,
  proposedMessage: string,
) {
  const answer = (await rl.question(cyan("Commit with this message? [Y/n/e(dit)] "))).trim().toLowerCase();
  if (answer === "n" || answer === "no") {
    return null;
  }
  if (answer !== "e" && answer !== "edit") {
    return proposedMessage;
  }

  console.log(dim("Enter a replacement commit message. Submit an empty line to finish."));
  const lines: string[] = [];
  while (true) {
    const nextLine = await rl.question("");
    if (!nextLine) {
      break;
    }
    lines.push(nextLine);
  }
  const replacement = lines.join("\n").trim();
  return replacement || null;
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
  backendConfig: LoadedBackendConfig,
) {
  let mode = initialMode;
  let currentProject = project;
  let checkpointRef: string | null = null;
  let autoTestEnabled = false;
  let watchEnabled = false;

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
        console.log(`  ${cyan("/save")}          Export the current session snapshot`);
        console.log(`  ${cyan("/plan")}          Enter Plan mode (read-only)`);
        console.log(`  ${cyan("/approve")}       Switch to Act mode`);
        console.log(`  ${cyan("/yes")}           Enable YOLO/auto-approve mode`);
        console.log(`  ${cyan("/no")}            Return to Act mode from YOLO`);
        console.log(`  ${cyan("/status")}        Show session info`);
        console.log(`  ${cyan("/tokens")}        Show estimated context usage`);
        console.log(`  ${cyan("/config")}        Show current CLI settings`);
        console.log(`  ${cyan("/compact")}       Compress conversation history`);
        console.log(`  ${cyan("/model")} ${gray("<name>")}  Switch model`);
        console.log(`  ${cyan("/models")}         List configured models`);
        console.log(`  ${cyan("/diff")}          Show git diff`);
        console.log(`  ${cyan("/git")} ${gray("<args>")}   Run a git command`);
        console.log(`  ${cyan("/commit")}        Draft a commit message and optionally commit`);
        console.log(`  ${cyan("/checkpoint")}    Save a tracked-files git checkpoint`);
        console.log(`  ${cyan("/rollback")}      Restore the last checkpoint`);
        console.log(`  ${cyan("/autotest")}      Toggle post-edit autotest placeholder`);
        console.log(`  ${cyan("/watch")}         Toggle file-watch placeholder`);
        console.log(`  ${cyan("/skills")}        List available skill files`);
        console.log(`  ${cyan("/init")}          Create a CLAUDE.md template if missing`);
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
        console.log(`  ${gray("approve")}  ${mode === "yolo" ? "auto" : "prompted"}`);
        console.log(`  ${gray("project")}  ${currentProject}`);
        console.log(`  ${gray("messages")} ${msgCount}`);
        console.log(`  ${gray("watch")}    ${watchEnabled ? "on" : "off"}`);
        console.log(`  ${gray("autotest")} ${autoTestEnabled ? "on" : "off"}`);
        if (snapshot?.task?.status) {
          console.log(`  ${gray("task")}     ${snapshot.task.status}`);
        }
        continue;
      }

      if (line === "/tokens") {
        const snapshot = (await actor.exportSession(sessionId)) as SessionSnapshot | null;
        if (!snapshot) {
          console.log(yellow("session snapshot unavailable"));
          continue;
        }
        const used = estimateSessionTokens(snapshot);
        const { bar, pct } = buildUsageBar(used, settings.contextWindow);
        console.log(bold("Token Usage (estimated):"));
        console.log(`  [${bar}] ${pct}%`);
        console.log(`  ${used.toLocaleString()} / ${settings.contextWindow.toLocaleString()} tokens`);
        console.log(`  ${snapshot.messages.length} messages in session`);
        if (pct >= 80) {
          console.log(yellow("Context is getting full. Use /compact if needed."));
        }
        continue;
      }

      if (line === "/config") {
        console.log(bold("Configuration:"));
        console.log(`  ${gray("model")}         ${settings.model}`);
        console.log(`  ${gray("host")}          ${settings.baseUrl}`);
        console.log(`  ${gray("temperature")}   ${settings.temperature}`);
        console.log(`  ${gray("max tokens")}    ${settings.maxTokens}`);
        console.log(`  ${gray("context")}       ${settings.contextWindow}`);
        console.log(`  ${gray("auto-approve")}  ${mode === "yolo" ? "ON" : "OFF"}`);
        console.log(`  ${gray("debug")}         ${process.env.AGENTOS_DEBUG ? "ON" : "OFF"}`);
        console.log(`  ${gray("config path")}   ${backendConfig.configPath}`);
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

      if (line === "/models") {
        console.log(bold("Configured models:"));
        for (const provider of backendConfig.providers) {
          console.log(`  ${cyan(provider.id)}${provider.baseUrl ? gray(`  ${provider.baseUrl}`) : ""}`);
          for (const model of provider.models) {
            const marker = model.modelId === settings.model ? "*" : "-";
            const label = model.displayName === model.modelId
              ? model.modelId
              : `${model.modelId} (${model.displayName})`;
            console.log(`    ${marker} ${label}`);
          }
        }
        continue;
      }

      if (line === "/save") {
        const snapshot = (await actor.exportSession(sessionId)) as SessionSnapshot | null;
        if (!snapshot) {
          console.log(yellow("session snapshot unavailable"));
          continue;
        }
        const targetDir = path.join(REPO_ROOT, ".vibe-local", "sessions");
        mkdirSync(targetDir, { recursive: true });
        const targetPath = path.join(targetDir, `${sessionId}.json`);
        writeFileSync(targetPath, JSON.stringify(snapshot, null, 2));
        console.log(infoColor(`session exported → ${targetPath}`));
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

      if (line === "/yes") {
        mode = "yolo";
        await actor.setSessionConfig(sessionId, settings.model, mode);
        footer.update({ mode });
        console.log(infoColor("auto-approve enabled"));
        continue;
      }

      if (line === "/no") {
        mode = "act";
        await actor.setSessionConfig(sessionId, settings.model, mode);
        footer.update({ mode });
        console.log(infoColor("auto-approve disabled"));
        continue;
      }

      if (line === "/diff") {
        const unstaged = await runGit(["diff", "--color=always"]);
        if (!unstaged.ok) {
          console.log(errorColor(unstaged.stderr.trim() || "git diff failed"));
          continue;
        }
        if (unstaged.stdout.trim()) {
          process.stdout.write(unstaged.stdout.endsWith("\n") ? unstaged.stdout : `${unstaged.stdout}\n`);
          continue;
        }
        const staged = await runGit(["diff", "--cached", "--color=always"]);
        if (!staged.ok) {
          console.log(errorColor(staged.stderr.trim() || "git diff --cached failed"));
          continue;
        }
        if (staged.stdout.trim()) {
          console.log(dim("(staged changes)"));
          process.stdout.write(staged.stdout.endsWith("\n") ? staged.stdout : `${staged.stdout}\n`);
        } else {
          console.log(infoColor("No changes."));
        }
        continue;
      }

      if (line.startsWith("/git")) {
        const rawArgs = line.slice("/git".length).trim();
        if (!rawArgs) {
          console.log(yellow("Usage: /git <command>"));
          continue;
        }
        try {
          const gitArgs = splitShellWords(rawArgs);
          if (gitArgs.some(isDangerousGitArg)) {
            console.log(errorColor("Blocked: /git does not allow -c, --config, or exec-path options."));
            continue;
          }
          const result = await runGit(gitArgs);
          if (result.stdout) {
            process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
          }
          if (result.stderr) {
            process.stdout.write(yellow(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`));
          }
          if (!result.ok && !result.stderr && !result.stdout) {
            console.log(errorColor("git command failed"));
          }
        } catch (err) {
          console.log(errorColor(`git error: ${err instanceof Error ? err.message : String(err)}`));
        }
        continue;
      }

      if (line === "/commit") {
        const status = await runGit(["status", "--porcelain"]);
        if (!status.ok) {
          console.log(errorColor(status.stderr.trim() || "Not a git repository."));
          continue;
        }
        let staged = await runGit(["diff", "--cached", "--stat"]);
        if (!staged.ok) {
          console.log(errorColor(staged.stderr.trim() || "git diff --cached failed"));
          continue;
        }

        if (!staged.stdout.trim()) {
          if (!status.stdout.trim()) {
            console.log(infoColor("Nothing to commit, working tree clean."));
            continue;
          }
          let shouldStage = mode === "yolo";
          if (!shouldStage) {
            console.log(yellow("Nothing staged. Stage tracked file changes with git add -u?"));
            console.log(dim(status.stdout.trim()));
            const answer = (await rl.question(cyan("[y/N] "))).trim().toLowerCase();
            shouldStage = answer === "y" || answer === "yes";
          }
          if (!shouldStage) {
            console.log(yellow("Commit aborted."));
            continue;
          }
          const addResult = await runGit(["add", "-u"]);
          if (!addResult.ok) {
            console.log(errorColor(addResult.stderr.trim() || "git add -u failed"));
            continue;
          }
          staged = await runGit(["diff", "--cached", "--stat"]);
          if (!staged.ok || !staged.stdout.trim()) {
            console.log(yellow("No staged diff to commit."));
            continue;
          }
        }

        const diff = await runGit(["diff", "--cached"]);
        if (!diff.ok || !diff.stdout.trim()) {
          console.log(yellow("No diff to commit."));
          continue;
        }

        try {
          const proposed = await generateCommitMessage(settings, diff.stdout.slice(0, 4000));
          console.log(`\n${bold("Proposed commit message:")}\n${proposed}\n`);
          const finalMessage = mode === "yolo"
            ? proposed
            : await promptForCommitMessageOverride(rl, proposed);
          if (!finalMessage) {
            console.log(yellow("Commit aborted."));
            continue;
          }
          const tempPath = path.join(tmpdir(), `vibe-local-commit-${process.pid}-${Date.now()}.txt`);
          writeFileSync(tempPath, finalMessage);
          try {
            const commitResult = await runGit(["commit", "-F", tempPath]);
            if (commitResult.ok) {
              process.stdout.write(
                commitResult.stdout.endsWith("\n") ? commitResult.stdout : `${commitResult.stdout}\n`,
              );
            } else {
              console.log(errorColor("Commit failed:"));
              if (commitResult.stderr) {
                process.stdout.write(
                  commitResult.stderr.endsWith("\n") ? commitResult.stderr : `${commitResult.stderr}\n`,
                );
              }
            }
          } finally {
            unlinkSync(tempPath);
          }
        } catch (err) {
          console.log(errorColor(`commit error: ${err instanceof Error ? err.message : String(err)}`));
        }
        continue;
      }

      if (line === "/checkpoint") {
        const checkpoint = await runGit(["stash", "create", `cli-checkpoint-${sessionId.slice(0, 8)}`]);
        if (!checkpoint.ok) {
          console.log(errorColor(checkpoint.stderr.trim() || "checkpoint failed"));
          continue;
        }
        const nextRef = checkpoint.stdout.trim();
        if (!nextRef) {
          console.log(yellow("No tracked changes to checkpoint."));
          continue;
        }
        checkpointRef = nextRef;
        console.log(infoColor(`checkpoint saved → ${checkpointRef.slice(0, 12)}`));
        console.log(dim("Tracked file changes only. Use /rollback to restore this checkpoint."));
        continue;
      }

      if (line === "/rollback") {
        if (!checkpointRef) {
          console.log(yellow("No checkpoint available."));
          continue;
        }
        let confirmed = mode === "yolo";
        if (!confirmed) {
          const answer = (await rl.question(cyan("Rollback tracked files to the last checkpoint? [y/N] ")))
            .trim()
            .toLowerCase();
          confirmed = answer === "y" || answer === "yes";
        }
        if (!confirmed) {
          console.log(yellow("Rollback aborted."));
          continue;
        }
        const reset = await runGit(["reset", "--hard", "HEAD"]);
        if (!reset.ok) {
          console.log(errorColor(reset.stderr.trim() || "git reset failed"));
          continue;
        }
        const clean = await runGit(["clean", "-fd"]);
        if (!clean.ok) {
          console.log(errorColor(clean.stderr.trim() || "git clean failed"));
          continue;
        }
        const apply = await runGit(["stash", "apply", "--index", checkpointRef]);
        if (!apply.ok) {
          console.log(errorColor(apply.stderr.trim() || "rollback failed"));
          continue;
        }
        checkpointRef = null;
        process.stdout.write(apply.stdout.endsWith("\n") ? apply.stdout : `${apply.stdout}\n`);
        console.log(infoColor("rolled back to checkpoint"));
        continue;
      }

      if (line === "/autotest") {
        autoTestEnabled = !autoTestEnabled;
        console.log(`Auto-test: ${autoTestEnabled ? infoColor("ON") : errorColor("OFF")}`);
        console.log(dim("Phase 3 placeholder: command surface is wired; automatic test hooks land later."));
        continue;
      }

      if (line === "/watch") {
        watchEnabled = !watchEnabled;
        console.log(`File watcher: ${watchEnabled ? infoColor("ON") : errorColor("OFF")}`);
        console.log(dim("Phase 3 placeholder: external file change monitoring is not wired into the actor loop yet."));
        continue;
      }

      if (line === "/skills") {
        const skillFiles = [
          ...listSkillFiles(path.join(homedir(), ".config", "vibe-local", "skills")),
          ...listSkillFiles(path.join(REPO_ROOT, ".vibe-local", "skills")),
        ].sort((left, right) => left.name.localeCompare(right.name));
        if (skillFiles.length === 0) {
          console.log(yellow("No skills loaded."));
          continue;
        }
        console.log(bold("Loaded skills:"));
        for (const skillFile of skillFiles) {
          console.log(`  ${cyan(skillFile.name)} ${gray(`(${skillFile.lines} lines)`)}`);
        }
        continue;
      }

      if (line === "/init") {
        const claudeMdPath = path.join(REPO_ROOT, "CLAUDE.md");
        if (existsSync(claudeMdPath)) {
          console.log(yellow("CLAUDE.md already exists in this directory."));
          continue;
        }
        const projectName = path.basename(REPO_ROOT);
        const content = [
          `# ${projectName}`,
          "",
          "## Project Overview",
          "",
          "<!-- Describe the project here -->",
          "",
          "## Instructions for AI",
          "",
          "- Follow existing code style",
          "- Write tests for new features",
          "- Use absolute paths",
          "",
        ].join("\n");
        writeFileSync(claudeMdPath, content);
        console.log(infoColor(`Created ${claudeMdPath}`));
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

      const backendConfig = loadBackendConfig();
      const settings = applyFlagOverrides(backendConfig.settings, options);
      const resolved = await resolveChatSession(actor, options, settings);

      if (options.debug) {
        printDebugSummary(options, resolved, settings);
      }

      if (options.prompt) {
        await runSinglePrompt(actor, resolved.sessionId, options.prompt, settings, resolved.project);
        process.exit(0);
        return;
      }

      await runInteractiveChat(
        actor,
        resolved.sessionId,
        resolved.project,
        resolved.mode,
        settings,
        backendConfig,
      );
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
