import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { createAgentosClient, waitForManager, agentosEndpoint } from "./client.js";
import {
  FixedFooter,
  bold,
  cyan,
  dim,
  errorColor,
  formatSubAgent,
  formatToolEvent,
  gray,
  green,
  infoColor,
  promptColor,
  red,
  toolColor,
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

function formatCliToolEvent(payload: Record<string, unknown>) {
  const name = typeof payload.name === "string" ? payload.name : "unknown";
  const input =
    payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
      ? (payload.input as Record<string, unknown>)
      : {};
  const status = typeof payload.status === "string" ? payload.status : "running";
  return `[tool:${status}] ${name} ${summarizeCliToolInput(input)}`.trim();
}

function formatSubAgentLine(subAgent: NonNullable<SessionSnapshot>["subAgents"][number]) {
  const pendingCount = subAgent.pendingApprovals.length;
  return `[sub-agent:${subAgent.status}] ${subAgent.id} mode=${subAgent.executionMode} resumes=${subAgent.resumeCount} pending=${pendingCount} prompt=${subAgent.prompt}`;
}

function parseParallelPrompts(tokens: string[]) {
  const chunks: string[] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (token === "--") {
      if (current.length > 0) {
        chunks.push(current.join(" ").trim());
        current = [];
      }
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) {
    chunks.push(current.join(" ").trim());
  }
  return chunks.filter(Boolean);
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
  const seenSubAgentStates = new Map<string, string>();

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

      for (const subAgent of snapshot.subAgents) {
        const signature = `${subAgent.status}:${subAgent.resumeCount}:${subAgent.pendingApprovals.join(",")}`;
        if (seenSubAgentStates.get(subAgent.id) === signature) {
          continue;
        }
        seenSubAgentStates.set(subAgent.id, signature);
        console.log(formatSubAgent(subAgent.id, subAgent.status, subAgent.prompt));
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

async function watchExistingSession(
  actor: Awaited<ReturnType<typeof getActor>>,
  sessionId: string,
  pollMs = 700,
) {
  let lastAssistantText = "";
  const seenToolEvents = new Set<string>();
  const seenSubAgentStates = new Map<string, string>();

  while (true) {
    const snapshot = (await actor.exportSession(sessionId)) as SessionSnapshot | null;
    if (!snapshot) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const orderedArtifacts = [...snapshot.artifacts].sort(
      (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
    );
    for (const artifact of orderedArtifacts) {
      if (artifact.kind !== "agent_tool_event" || seenToolEvents.has(artifact.id)) {
        continue;
      }
      seenToolEvents.add(artifact.id);
      console.log(formatCliToolEvent(artifact.payload));
    }

    for (const subAgent of snapshot.subAgents) {
      const signature = `${subAgent.status}:${subAgent.resumeCount}:${subAgent.pendingApprovals.join(",")}`;
      if (seenSubAgentStates.get(subAgent.id) === signature) {
        continue;
      }
      seenSubAgentStates.set(subAgent.id, signature);
      console.log(formatSubAgentLine(subAgent));
    }

    const currentText = snapshot.task?.lastResponse ?? "";
    if (currentText.startsWith(lastAssistantText) && currentText.length > lastAssistantText.length) {
      process.stdout.write(currentText.slice(lastAssistantText.length));
      lastAssistantText = currentText;
    } else if (currentText && currentText !== lastAssistantText) {
      process.stdout.write(`\n${currentText}`);
      lastAssistantText = currentText;
    }

    if (snapshot.task && snapshot.task.status !== "running") {
      if (lastAssistantText) {
        process.stdout.write("\n");
      }
      console.log(`[session] status=${snapshot.task.status}`);
      printPendingApprovals(snapshot);
      printSubAgentSummary(snapshot);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function usage() {
  console.log(`Usage:
  pnpm vibe-local:cli health
  pnpm vibe-local:cli projects
  pnpm vibe-local:cli project-info <project>
  pnpm vibe-local:cli git-status
  pnpm vibe-local:cli diff-stat
  pnpm vibe-local:cli search <query> [maxResults]
  pnpm vibe-local:cli read-file <path>
  pnpm vibe-local:cli read-agentfs-mirror <path>
  pnpm vibe-local:cli write-file <path> < content.txt
  pnpm vibe-local:cli run-script <project> <script> [timeoutMs]
  pnpm vibe-local:cli agent-run <project> <prompt...>
  pnpm vibe-local:cli agent-plan <project> <prompt...>
  pnpm vibe-local:cli agent-yolo <project> <prompt...>
  pnpm vibe-local:cli chat <project> [--mode plan|act|yolo]
  pnpm vibe-local:cli sessions
  pnpm vibe-local:cli session <sessionId>
  pnpm vibe-local:cli watch-session <sessionId>
  pnpm vibe-local:cli continue-session <sessionId>
  pnpm vibe-local:cli continue-subagent <sessionId> <subAgentId>
  pnpm vibe-local:cli approval <sessionId> <approvalId> <approve|reject> [--continue]
  pnpm vibe-local:cli parallel-run [--mode read-only|act|plan|yolo] <project> <prompt1> -- <prompt2> [-- <prompt3>...]
  pnpm vibe-local:cli agent-rewrite-file <project> <path> <prompt...>`);
}

async function getActor() {
  const endpoint = agentosEndpoint();
  await waitForManager(endpoint);
  const client = createAgentosClient();
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
    maxTokens: 1024,
    systemPrompt: "You are a helpful coding assistant. Be concise.",
    temperature: 0.2,
  };
}

function printPendingApprovals(snapshot: SessionSnapshot | null) {
  const approvals =
    snapshot?.approvals.filter((approval: SessionSnapshot["approvals"][number]) => approval.status === "pending") ??
    [];
  if (approvals.length === 0) {
    console.log("[approvals] pending approval はありません");
    return;
  }

  console.log("[approvals]");
  for (const approval of approvals) {
    console.log(
      `- ${approval.id} ${approval.toolName} ${summarizeCliToolInput(
        approval.input as Record<string, unknown>,
      )}`,
    );
  }
}

function printSubAgentSummary(snapshot: SessionSnapshot | null) {
  const subAgents = snapshot?.subAgents ?? [];
  if (subAgents.length === 0) {
    console.log("[sub-agents] まだありません");
    return;
  }

  console.log("[sub-agents]");
  for (const subAgent of subAgents) {
    console.log(
      `- ${subAgent.id} status=${subAgent.status} mode=${subAgent.executionMode} resumes=${subAgent.resumeCount} prompt=${subAgent.prompt}`,
    );
    if (subAgent.error) {
      console.log(`  error: ${subAgent.error}`);
    } else if (subAgent.finalResponse) {
      const preview = subAgent.finalResponse.replace(/\s+/g, " ").slice(0, 120);
      console.log(`  result: ${preview}`);
    }
  }
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
  const availableProjects = await actor.listProjects();

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
        console.log(`  ${cyan("/mode")} ${gray("<mode>")}   Set mode (plan/act/yolo)`);
        console.log(`  ${cyan("/status")}        Show session info`);
        console.log(`  ${cyan("/compact")}       Compress conversation history`);
        console.log(`  ${cyan("/model")} ${gray("<name>")}  Switch model`);
        console.log(`  ${cyan("/projects")}      List available projects`);
        console.log(`  ${cyan("/project")} ${gray("<n>")}   Switch project`);
        console.log(`  ${cyan("/approvals")}     Show pending approvals`);
        console.log(`  ${cyan("/continue")}      Continue agent task`);
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

      if (line.startsWith("/mode ") || line === "/plan" || line === "/approve" || line === "/act") {
        let nextMode: string;
        if (line === "/plan") {
          nextMode = "plan";
        } else if (line === "/approve" || line === "/act") {
          nextMode = "act";
        } else {
          nextMode = line.slice("/mode ".length).trim();
        }
        if (nextMode !== "plan" && nextMode !== "act" && nextMode !== "yolo") {
          console.log(yellow("mode は plan / act / yolo のみです"));
          continue;
        }
        mode = nextMode;
        await actor.setSessionConfig(session.session.id, settings.model, mode);
        footer.update({ mode });
        console.log(infoColor(`mode → ${mode}`));
        continue;
      }

      if (line === "/projects") {
        console.log("[projects]");
        for (const candidate of availableProjects) {
          console.log(`- ${candidate.relativePath} (${candidate.name})`);
        }
        continue;
      }

      if (line.startsWith("/project ")) {
        const nextProject = line.slice("/project ".length).trim();
        if (!nextProject) {
          console.log("[chat] /project <relativePath>");
          continue;
        }
        const exists = availableProjects.some(
          (candidate: Awaited<ReturnType<typeof actor.listProjects>>[number]) =>
            candidate.relativePath === nextProject,
        );
        if (!exists) {
          console.log(`[chat] unknown project: ${nextProject}`);
          continue;
        }
        currentProject = nextProject;
        footer.update({ project: currentProject });
        console.log(infoColor(`directory → ${currentProject}`));
        continue;
      }

      if (line === "/approvals") {
        printPendingApprovals((await actor.exportSession(session.session.id)) as SessionSnapshot | null);
        continue;
      }

      if (line === "/subagents") {
        printSubAgentSummary((await actor.exportSession(session.session.id)) as SessionSnapshot | null);
        continue;
      }

      if (line.startsWith("/continue-subagent ")) {
        const subAgentId = line.slice("/continue-subagent ".length).trim();
        if (!subAgentId) {
          console.log("[chat] /continue-subagent <subAgentId>");
          continue;
        }
        const actionPromise = actor.continueSubAgentTask(session.session.id, subAgentId, settings);
        await watchSessionProgress(actor, session.session.id, actionPromise, footer);
        const result = await actionPromise;
        console.log(`[sub-agent] ${result.subAgent.id} -> ${result.subAgent.status}`);
        printSubAgentSummary((await actor.exportSession(session.session.id)) as SessionSnapshot | null);
        continue;
      }

      if (line.startsWith("/parallel ")) {
        const rawTokens = line.slice("/parallel ".length).trim().split(/\s+/).filter(Boolean);
        let executionMode: "act" | "plan" | "read-only" | "yolo" = "read-only";
        let normalizedTokens = rawTokens;
        const modeCandidate = rawTokens[0];
        if (
          modeCandidate === "act" ||
          modeCandidate === "plan" ||
          modeCandidate === "read-only" ||
          modeCandidate === "yolo"
        ) {
          executionMode = modeCandidate;
          normalizedTokens = rawTokens.slice(1);
        }
        const prompts = parseParallelPrompts(normalizedTokens);
        if (prompts.length === 0) {
          console.log("[chat] /parallel [read-only|plan|act|yolo] <prompt1> -- <prompt2> [-- <prompt3>...]");
          continue;
        }
        const actionPromise = actor.runParallelAgentTasks(
          session.session.id,
          prompts,
          settings,
          currentProject,
          executionMode,
        );
        await watchSessionProgress(actor, session.session.id, actionPromise, footer);
        const result = await actionPromise;
        console.log(
          `[parallel] started ${result.subAgents.length} sub-agents in ${executionMode} mode`,
        );
        printSubAgentSummary((await actor.exportSession(session.session.id)) as SessionSnapshot | null);
        continue;
      }

      if (line === "/session") {
        const snapshot = (await actor.exportSession(session.session.id)) as SessionSnapshot | null;
        console.log(
          JSON.stringify(
            {
              session: snapshot?.session,
              task: snapshot?.task,
              pendingApprovals:
                snapshot?.approvals.filter(
                  (approval: SessionSnapshot["approvals"][number]) => approval.status === "pending",
                ) ?? [],
              subAgents: snapshot?.subAgents ?? [],
            },
            null,
            2,
          ),
        );
        continue;
      }

      if (line === "/continue") {
        const runPromise = actor.continueAgentTask(session.session.id, settings);
        await watchSessionProgress(actor, session.session.id, runPromise, footer);
        const result = await runPromise;
        console.log(dim(`task: ${result.task?.status ?? "unknown"}`));
        printPendingApprovals((await actor.exportSession(session.session.id)) as SessionSnapshot | null);
        continue;
      }

      if (line.startsWith("/approve ")) {
        const [approvalId, continueToken] = line
          .slice("/approve ".length)
          .trim()
          .split(/\s+/);
        if (!approvalId) {
          console.log("[chat] /approve <approvalId> [continue]");
          continue;
        }
        const continueAfter = continueToken === "continue";
        const actionPromise = actor.approveToolCall(
          session.session.id,
          approvalId,
          "approve",
          continueAfter,
          continueAfter ? settings : undefined,
        );
        if (continueAfter) {
          await watchSessionProgress(actor, session.session.id, actionPromise, footer);
        }
        const result = await actionPromise;
        console.log(`[approval] ${result.approval.toolName} -> ${result.approval.status}`);
        printPendingApprovals((await actor.exportSession(session.session.id)) as SessionSnapshot | null);
        continue;
      }

      if (line.startsWith("/reject ")) {
        const approvalId = line.slice("/reject ".length).trim();
        if (!approvalId) {
          console.log("[chat] /reject <approvalId>");
          continue;
        }
        const result = await actor.approveToolCall(session.session.id, approvalId, "reject", false);
        console.log(`[approval] ${result.approval.toolName} -> ${result.approval.status}`);
        printPendingApprovals((await actor.exportSession(session.session.id)) as SessionSnapshot | null);
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
        printPendingApprovals((await actor.exportSession(session.session.id)) as SessionSnapshot | null);
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
    case "health": {
      console.log(JSON.stringify(await actor.health(), null, 2));
      return;
    }
    case "projects": {
      console.log(JSON.stringify(await actor.listProjects(), null, 2));
      return;
    }
    case "project-info": {
      const project = args[0];
      if (!project) throw new Error("Missing <project>");
      console.log(JSON.stringify(await actor.projectInfo(project), null, 2));
      return;
    }
    case "git-status": {
      console.log(JSON.stringify(await actor.gitStatus(), null, 2));
      return;
    }
    case "sessions": {
      const payload = await actor.hydrate();
      console.log(
        JSON.stringify(
          payload.sessions.map((entry: any) => ({
            id: entry.session.id,
            title: entry.session.title,
            mode: entry.session.mode,
            model: entry.session.model,
            approvals: (entry.approvals ?? [])
              .filter((approval: any) => approval.status === "pending")
              .map((approval: any) => ({
                id: approval.id,
                toolName: approval.toolName,
                subAgentId: approval.subAgentId ?? null,
              })),
            task: entry.task
              ? {
                  goal: entry.task.goal,
                  status: entry.task.status,
                  continueCount: entry.task.continueCount,
                }
              : null,
          })),
          null,
          2,
        ),
      );
      return;
    }
    case "session": {
      const sessionId = args[0];
      if (!sessionId) throw new Error("Missing <sessionId>");
      console.log(JSON.stringify(await actor.exportSession(sessionId), null, 2));
      return;
    }
    case "watch-session": {
      const sessionId = args[0];
      if (!sessionId) throw new Error("Missing <sessionId>");
      await watchExistingSession(actor, sessionId);
      return;
    }
    case "diff-stat": {
      console.log(JSON.stringify(await actor.gitDiffStat(), null, 2));
      return;
    }
    case "search": {
      const query = args[0];
      if (!query) throw new Error("Missing <query>");
      const maxResults = Number.parseInt(args[1] ?? "20", 10);
      console.log(JSON.stringify(await actor.searchCode(query, maxResults), null, 2));
      return;
    }
    case "read-file": {
      const filePath = args[0];
      if (!filePath) throw new Error("Missing <path>");
      console.log(JSON.stringify(await actor.readFile(filePath), null, 2));
      return;
    }
    case "read-agentfs-mirror": {
      const filePath = args[0];
      if (!filePath) throw new Error("Missing <path>");
      console.log(JSON.stringify(await actor.readAgentFsMirror(filePath), null, 2));
      return;
    }
    case "write-file": {
      const filePath = args[0];
      if (!filePath) throw new Error("Missing <path>");
      const content = readFileSync(0, "utf8");
      console.log(JSON.stringify(await actor.writeFile(filePath, content), null, 2));
      return;
    }
    case "run-script": {
      const project = args[0];
      const script = args[1];
      if (!project || !script) throw new Error("Missing <project> or <script>");
      const timeoutMs = Number.parseInt(args[2] ?? "120000", 10);
      console.log(JSON.stringify(await actor.runScript(project, script, timeoutMs), null, 2));
      return;
    }
    case "agent-run": {
      const project = args[0];
      const prompt = args.slice(1).join(" ").trim();
      if (!project || !prompt) throw new Error("Missing <project> or <prompt...>");
      const settings = loadBackendSettings();
      const session = await actor.createSession(`CLI ${project}`);
      await actor.setSessionConfig(session.session.id, settings.model, "act");
      const runPromise = actor.runAgentTurn(session.session.id, prompt, settings, project);
      await watchSessionProgress(actor, session.session.id, runPromise);
      console.log(
        JSON.stringify(
          await runPromise,
          null,
          2,
        ),
      );
      return;
    }
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
    case "continue-session": {
      const sessionId = args[0];
      if (!sessionId) throw new Error("Missing <sessionId>");
      const settings = loadBackendSettings();
      const runPromise = actor.continueAgentTask(sessionId, settings);
      await watchSessionProgress(actor, sessionId, runPromise);
      console.log(
        JSON.stringify(
          await runPromise,
          null,
          2,
        ),
      );
      return;
    }
    case "continue-subagent": {
      const sessionId = args[0];
      const subAgentId = args[1];
      if (!sessionId || !subAgentId) throw new Error("Missing <sessionId> or <subAgentId>");
      const settings = loadBackendSettings();
      console.log(
        JSON.stringify(
          await actor.continueSubAgentTask(sessionId, subAgentId, settings),
          null,
          2,
        ),
      );
      return;
    }
    case "agent-plan": {
      const project = args[0];
      const prompt = args.slice(1).join(" ").trim();
      if (!project || !prompt) throw new Error("Missing <project> or <prompt...>");
      const settings = loadBackendSettings();
      const session = await actor.createSession(`CLI ${project}`);
      await actor.setSessionConfig(session.session.id, settings.model, "plan");
      const runPromise = actor.runAgentTurn(session.session.id, prompt, settings, project);
      await watchSessionProgress(actor, session.session.id, runPromise);
      console.log(
        JSON.stringify(
          await runPromise,
          null,
          2,
        ),
      );
      return;
    }
    case "agent-yolo": {
      const project = args[0];
      const prompt = args.slice(1).join(" ").trim();
      if (!project || !prompt) throw new Error("Missing <project> or <prompt...>");
      const settings = loadBackendSettings();
      const session = await actor.createSession(`CLI ${project}`);
      await actor.setSessionConfig(session.session.id, settings.model, "yolo");
      const runPromise = actor.runAgentTurn(session.session.id, prompt, settings, project);
      await watchSessionProgress(actor, session.session.id, runPromise);
      console.log(
        JSON.stringify(
          await runPromise,
          null,
          2,
        ),
      );
      return;
    }
    case "approval": {
      const sessionId = args[0];
      const approvalId = args[1];
      const decision = args[2];
      const continueAfter = args.includes("--continue");
      if (!sessionId || !approvalId || (decision !== "approve" && decision !== "reject")) {
        throw new Error("Usage: approval <sessionId> <approvalId> <approve|reject> [--continue]");
      }
      const settings = continueAfter ? await loadBackendSettings() : undefined;
      const actionPromise = actor.approveToolCall(sessionId, approvalId, decision, continueAfter, settings);
      if (continueAfter) {
        await watchSessionProgress(actor, sessionId, actionPromise);
      }
      console.log(
        JSON.stringify(await actionPromise, null, 2),
      );
      return;
    }
    case "parallel-run": {
      const executionModeIndex = args.findIndex((token) => token === "--mode");
      let executionMode: "act" | "plan" | "read-only" | "yolo" = "read-only";
      let normalizedArgs = [...args];
      if (executionModeIndex >= 0) {
        const candidate = normalizedArgs[executionModeIndex + 1];
        if (candidate !== "act" && candidate !== "plan" && candidate !== "read-only" && candidate !== "yolo") {
          throw new Error("parallel-run --mode must be one of read-only, act, plan, or yolo");
        }
        executionMode = candidate;
        normalizedArgs = normalizedArgs.filter((_, index) => index !== executionModeIndex && index !== executionModeIndex + 1);
      }
      const project = normalizedArgs[0];
      const prompts = parseParallelPrompts(normalizedArgs.slice(1));
      if (!project || prompts.length === 0) {
        throw new Error("Usage: parallel-run [--mode read-only|act|plan|yolo] <project> <prompt1> -- <prompt2> [-- <prompt3>...]");
      }
      const settings = loadBackendSettings();
      const session = await actor.createSession(`CLI parallel ${project}`);
      await actor.setSessionConfig(session.session.id, settings.model, "act");
      const actionPromise = actor.runParallelAgentTasks(
        session.session.id,
        prompts,
        settings,
        project,
        executionMode,
      );
      await watchSessionProgress(actor, session.session.id, actionPromise);
      console.log(
        JSON.stringify(
          await actionPromise,
          null,
          2,
        ),
      );
      return;
    }
    case "agent-rewrite-file": {
      const project = args[0];
      const filePath = args[1];
      const prompt = args.slice(2).join(" ").trim();
      if (!project || !filePath || !prompt) {
        throw new Error("Missing <project>, <path>, or <prompt...>");
      }
      const settings = loadBackendSettings();
      const session = await actor.createSession(`CLI ${project}`);
      await actor.setSessionConfig(session.session.id, settings.model, "act");
      console.log(
        JSON.stringify(
          await actor.rewriteFileWithAgent(session.session.id, filePath, prompt, settings, project),
          null,
          2,
        ),
      );
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
