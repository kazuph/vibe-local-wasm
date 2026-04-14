import { actor } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";

import { pyodideRunAgentTurn } from "./pyodide-runtime.js";

type SessionMode = "plan" | "act" | "yolo";
type ToolExecutionMode = "act" | "plan" | "read-only" | "yolo";
type ChatRole = "assistant" | "system" | "user";
type ApprovalStatus = "approved" | "failed" | "pending" | "rejected";
type SubAgentStatus = "completed" | "failed" | "queued" | "running";
type TaskStatus = "completed" | "failed" | "idle" | "running" | "waiting_approval";

type SessionRecord = {
  createdAt: string;
  id: string;
  mode: SessionMode;
  model: string;
  title: string;
  updatedAt: string;
};

type ChatMessage = {
  content: string;
  createdAt: string;
  id: string;
  role: ChatRole;
  turnIndex: number;
};

type SessionArtifact = {
  createdAt: string;
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  sessionId: string;
};

type ToolExecutionTrace = {
  approvalId?: string;
  error?: string;
  finishedAt: string;
  input: unknown;
  name: string;
  outputPreview: string;
  startedAt: string;
  status: "approval_required" | "completed" | "failed" | "rejected";
};

type ApprovalRecord = {
  createdAt: string;
  error: string;
  id: string;
  input: Record<string, unknown>;
  outputPreview: string;
  sessionId: string;
  status: ApprovalStatus;
  subAgentId: string | null;
  toolName: string;
  updatedAt: string;
};

type SubAgentRun = {
  createdAt: string;
  error: string;
  executionMode: ToolExecutionMode;
  finalResponse: string;
  id: string;
  lastResumedAt: string;
  pendingApprovals: string[];
  prompt: string;
  resumeCount: number;
  resumeReadyAt: string;
  selectedProject: string;
  sessionId: string;
  status: SubAgentStatus;
  toolCalls: ToolExecutionTrace[];
  updatedAt: string;
};

type BackendSettings = {
  apiKey: string;
  baseUrl: string;
  maxTokens: number;
  model: string;
  systemPrompt: string;
  temperature: number;
};

type TaskState = {
  continueCount: number;
  createdAt: string;
  goal: string;
  lastError: string;
  lastResponse: string;
  selectedProject: string;
  sessionId: string;
  settings: BackendSettings | null;
  status: TaskStatus;
  updatedAt: string;
};

type SessionSnapshot = {
  approvals: ApprovalRecord[];
  artifacts: SessionArtifact[];
  messages: ChatMessage[];
  subAgents: SubAgentRun[];
  task: TaskState | null;
  session: SessionRecord;
};

type CompactResult = {
  artifact: SessionArtifact | null;
  changed: boolean;
  messages: ChatMessage[];
  session: SessionRecord;
};

type AgentRunArtifactPayload = {
  executionMode: ToolExecutionMode;
  finalResponse: string;
  pendingApprovals: string[];
  prompt: string;
  runId: string;
  selectedProject: string;
  toolCalls: ToolExecutionTrace[];
};

type AgentToolEventArtifactPayload = {
  error?: string;
  eventId: string;
  executionMode: ToolExecutionMode;
  finishedAt?: string;
  input: Record<string, unknown>;
  name: string;
  outputPreview?: string;
  phase: "finished" | "started";
  prompt: string;
  runId: string;
  selectedProject: string;
  startedAt: string;
  status: "running" | "approval_required" | "completed" | "failed" | "rejected";
};

type AgentTurnResult = {
  approvals: ApprovalRecord[];
  artifact: SessionArtifact;
  message: ChatMessage;
  pendingApproval: boolean;
  session: SessionRecord;
  task: TaskState | null;
  toolCalls: ToolExecutionTrace[];
};

function nowIso() {
  return new Date().toISOString();
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function sessionModeToExecutionMode(mode: SessionMode): ToolExecutionMode {
  if (mode === "plan") return "plan";
  if (mode === "yolo") return "yolo";
  return "act";
}

function createAgentSystemPrompt(
  selectedProject: string,
  extraPrompt: string,
  executionMode: ToolExecutionMode,
) {
  return [
    "You are the coding mode of vibe-local running through the vendored Python core in Pyodide.",
    "Prefer using the original Python agent behavior and keep host-side logic to filesystem, subprocess, and HTTP bridging.",
    executionMode === "yolo"
      ? "YOLO mode is enabled. Finish the task end-to-end unless the tool layer blocks you."
      : "",
    selectedProject ? `Prefer the project: ${selectedProject}` : "",
    extraPrompt.trim(),
  ]
    .filter(Boolean)
    .join("\n");
}

async function persistMessage(
  dbClient: RawAccess,
  sessionId: string,
  role: ChatRole,
  content: string,
) {
  const snapshot = await requireSnapshot(dbClient, sessionId);
  const trimmed = content.trim();
  const createdAt = nowIso();
  const turnIndex = snapshot.messages.length;
  const message = {
    id: crypto.randomUUID(),
    role,
    content: trimmed,
    createdAt,
    turnIndex,
  } satisfies ChatMessage;

  let nextTitle = snapshot.session.title;
  if (role === "user" && (!nextTitle || nextTitle === "New session")) {
    nextTitle = trimmed.replace(/\s+/g, " ").slice(0, 36) || "New session";
  }

  await dbClient.execute(
    `
      INSERT INTO messages(id, session_id, role, content_json, created_at, turn_index)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    message.id,
    sessionId,
    message.role,
    JSON.stringify({ text: message.content }),
    message.createdAt,
    message.turnIndex,
  );

  await dbClient.execute(
    `
      UPDATE sessions
      SET title = ?, updated_at = ?
      WHERE id = ?
    `,
    nextTitle,
    createdAt,
    sessionId,
  );

  return {
    message,
    session: {
      ...snapshot.session,
      title: nextTitle,
      updatedAt: createdAt,
    } satisfies SessionRecord,
  };
}

async function persistArtifact(
  dbClient: RawAccess,
  sessionId: string,
  kind: string,
  payload: Record<string, unknown>,
) {
  const artifact = {
    id: crypto.randomUUID(),
    sessionId,
    kind,
    createdAt: nowIso(),
    payload,
  } satisfies SessionArtifact;

  await dbClient.execute(
    `
      INSERT OR REPLACE INTO artifacts(id, session_id, kind, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    artifact.id,
    artifact.sessionId,
    artifact.kind,
    JSON.stringify(artifact.payload),
    artifact.createdAt,
  );

  await dbClient.execute(
    `
      UPDATE sessions
      SET updated_at = ?
      WHERE id = ?
    `,
    artifact.createdAt,
    sessionId,
  );

  return artifact;
}

async function persistAgentToolEvent(
  dbClient: RawAccess,
  sessionId: string,
  payload: AgentToolEventArtifactPayload,
) {
  await persistArtifact(dbClient, sessionId, "agent_tool_event", payload);
}

async function getTaskState(dbClient: RawAccess, sessionId: string) {
  const rows = await dbClient.execute<{
    continue_count: number;
    created_at: string;
    goal: string;
    last_error: string;
    last_response: string;
    selected_project: string;
    session_id: string;
    settings_json: string;
    status: TaskStatus;
    updated_at: string;
  }>(
    `
      SELECT
        session_id, goal, selected_project, status, last_response, last_error,
        continue_count, settings_json, created_at, updated_at
      FROM task_state
      WHERE session_id = ?
    `,
    sessionId,
  );

  const row = rows[0];
  if (!row) return null;

  return {
    sessionId: row.session_id,
    goal: row.goal,
    selectedProject: row.selected_project,
    status: row.status,
    lastResponse: row.last_response,
    lastError: row.last_error,
    continueCount: Number(row.continue_count),
    settings: row.settings_json.trim()
      ? (JSON.parse(row.settings_json) as BackendSettings)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies TaskState;
}

async function saveTaskState(
  dbClient: RawAccess,
  task: Omit<TaskState, "createdAt" | "updatedAt"> & {
    createdAt?: string;
    updatedAt?: string;
  },
) {
  const createdAt = task.createdAt ?? nowIso();
  const updatedAt = task.updatedAt ?? createdAt;

  await dbClient.execute(
    `
      INSERT INTO task_state(
        session_id, goal, selected_project, status, last_response, last_error,
        continue_count, settings_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        goal = excluded.goal,
        selected_project = excluded.selected_project,
        status = excluded.status,
        last_response = excluded.last_response,
        last_error = excluded.last_error,
        continue_count = excluded.continue_count,
        settings_json = excluded.settings_json,
        updated_at = excluded.updated_at
    `,
    task.sessionId,
    task.goal,
    task.selectedProject,
    task.status,
    task.lastResponse,
    task.lastError,
    task.continueCount,
    JSON.stringify(task.settings ?? null),
    createdAt,
    updatedAt,
  );

  return await getTaskState(dbClient, task.sessionId);
}

function toSessionRecord(row: {
  created_at: string;
  id: string;
  mode: SessionMode;
  model: string;
  title: string;
  updated_at: string;
}) {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    mode: row.mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies SessionRecord;
}

function parseMessageRows(
  rows: Array<{
    id: string;
    role: ChatRole;
    content_json: string;
    created_at: string;
    turn_index: number;
  }>,
) {
  return rows.map((row) => {
    const parsed = JSON.parse(row.content_json) as { text?: string };
    return {
      id: row.id,
      role: row.role,
      content: parsed.text ?? "",
      createdAt: row.created_at,
      turnIndex: Number(row.turn_index),
    } satisfies ChatMessage;
  });
}

function parseArtifactRows(
  rows: Array<{
    id: string;
    session_id: string;
    kind: string;
    payload_json: string;
    created_at: string;
  }>,
) {
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    createdAt: row.created_at,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  })) satisfies SessionArtifact[];
}

function parseApprovalRows(
  rows: Array<{
    created_at: string;
    error_text: string;
    id: string;
    input_json: string;
    output_preview: string;
    session_id: string;
    status: ApprovalStatus;
    sub_agent_id: string | null;
    tool_name: string;
    updated_at: string;
  }>,
) {
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    input: JSON.parse(row.input_json) as Record<string, unknown>,
    status: row.status,
    subAgentId: row.sub_agent_id,
    outputPreview: row.output_preview,
    error: row.error_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })) satisfies ApprovalRecord[];
}

function parseSubAgentRows(
  rows: Array<{
    created_at: string;
    id: string;
    prompt: string;
    result_json: string;
    selected_project: string;
    session_id: string;
    status: SubAgentStatus;
    updated_at: string;
  }>,
) {
  return rows.map((row) => {
    const parsed = JSON.parse(row.result_json) as {
      executionMode?: ToolExecutionMode;
      error?: string;
      finalResponse?: string;
      lastResumedAt?: string;
      pendingApprovals?: string[];
      resumeCount?: number;
      resumeReadyAt?: string;
      toolCalls?: ToolExecutionTrace[];
    };
    return {
      id: row.id,
      sessionId: row.session_id,
      prompt: row.prompt,
      selectedProject: row.selected_project,
      executionMode: parsed.executionMode ?? "read-only",
      status: row.status,
      finalResponse: parsed.finalResponse ?? "",
      error: parsed.error ?? "",
      lastResumedAt: parsed.lastResumedAt ?? "",
      pendingApprovals: parsed.pendingApprovals ?? [],
      resumeCount: parsed.resumeCount ?? 0,
      resumeReadyAt: parsed.resumeReadyAt ?? "",
      toolCalls: parsed.toolCalls ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } satisfies SubAgentRun;
  });
}

async function getSnapshot(dbClient: RawAccess, sessionId: string) {
  const sessionRows = await dbClient.execute<{
    created_at: string;
    id: string;
    mode: SessionMode;
    model: string;
    title: string;
    updated_at: string;
  }>(
    `
      SELECT id, title, model, mode, created_at, updated_at
      FROM sessions
      WHERE id = ?
    `,
    sessionId,
  );

  const row = sessionRows[0];
  if (!row) {
    return null;
  }

  const [
    messageRows,
    artifactRows,
    approvalRows,
    subAgentRows,
    task,
  ] = await Promise.all([
    dbClient.execute<{
      id: string;
      role: ChatRole;
      content_json: string;
      created_at: string;
      turn_index: number;
    }>(
      `
        SELECT id, role, content_json, created_at, turn_index
        FROM messages
        WHERE session_id = ?
        ORDER BY turn_index ASC
      `,
      sessionId,
    ),
    dbClient.execute<{
      id: string;
      session_id: string;
      kind: string;
      payload_json: string;
      created_at: string;
    }>(
      `
        SELECT id, session_id, kind, payload_json, created_at
        FROM artifacts
        WHERE session_id = ?
        ORDER BY created_at ASC
      `,
      sessionId,
    ),
    dbClient.execute<{
      created_at: string;
      error_text: string;
      id: string;
      input_json: string;
      output_preview: string;
      session_id: string;
      status: ApprovalStatus;
      sub_agent_id: string | null;
      tool_name: string;
      updated_at: string;
    }>(
      `
        SELECT
          id, session_id, tool_name, input_json, status, sub_agent_id,
          output_preview, error_text, created_at, updated_at
        FROM approvals
        WHERE session_id = ?
        ORDER BY created_at ASC
      `,
      sessionId,
    ),
    dbClient.execute<{
      created_at: string;
      id: string;
      prompt: string;
      result_json: string;
      selected_project: string;
      session_id: string;
      status: SubAgentStatus;
      updated_at: string;
    }>(
      `
        SELECT
          id, session_id, prompt, selected_project, status, result_json, created_at, updated_at
        FROM sub_agents
        WHERE session_id = ?
        ORDER BY created_at ASC
      `,
      sessionId,
    ),
    getTaskState(dbClient, sessionId),
  ]);

  return {
    session: toSessionRecord(row),
    approvals: parseApprovalRows(approvalRows),
    messages: parseMessageRows(messageRows),
    artifacts: parseArtifactRows(artifactRows),
    subAgents: parseSubAgentRows(subAgentRows),
    task,
  } satisfies SessionSnapshot;
}

async function requireSnapshot(dbClient: RawAccess, sessionId: string) {
  const snapshot = await getSnapshot(dbClient, sessionId);
  if (!snapshot) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  return snapshot;
}

async function listSessionSummaries(dbClient: RawAccess) {
  const rows = await dbClient.execute<{ id: string }>(
    `
      SELECT id
      FROM sessions
      ORDER BY updated_at DESC
    `,
  );

  const snapshots = await Promise.all(rows.map(async (row) => await getSnapshot(dbClient, row.id)));
  return snapshots.filter((snapshot): snapshot is SessionSnapshot => snapshot !== null);
}

async function executePyodideAgentTurn(
  dbClient: RawAccess,
  snapshot: SessionSnapshot,
  prompt: string,
  settings: BackendSettings,
  selectedProject: string,
  executionMode: ToolExecutionMode,
  continueCount: number,
): Promise<AgentTurnResult> {
  const runId = crypto.randomUUID();
  const createdAt = snapshot.task?.createdAt ?? nowIso();

  await saveTaskState(dbClient, {
    sessionId: snapshot.session.id,
    goal: prompt,
    selectedProject,
    status: "running",
    lastResponse: "",
    lastError: "",
    continueCount,
    settings,
    createdAt,
    updatedAt: nowIso(),
  });
  await persistArtifact(dbClient, snapshot.session.id, "agent_run_started", {
    executionMode,
    prompt,
    runId,
    selectedProject,
  });

  const historyMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    {
      role: "system",
      content: createAgentSystemPrompt(selectedProject, settings.systemPrompt, executionMode),
    },
    ...snapshot.messages.map((message) => ({
      role: message.role as "system" | "user" | "assistant",
      content: message.content,
    })),
    { role: "user", content: prompt },
  ];

  const baseUrl = settings.baseUrl.trim().replace(/\/v1\/?$/, "");

  try {
    const result = await pyodideRunAgentTurn({
      baseUrl,
      model: settings.model,
      messages: historyMessages,
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
      maxIterations: 8,
    });

    if (!result.ok) {
      throw new Error(result.error ?? "Pyodide agent turn failed");
    }

    const toolCalls: ToolExecutionTrace[] = [];
    for (const event of result.toolEvents) {
      const finishedAt = nowIso();
      const trace: ToolExecutionTrace = {
        name: event.name,
        input: event.args,
        outputPreview: event.output.slice(0, 500),
        startedAt: finishedAt,
        finishedAt,
        status: "completed",
      };
      toolCalls.push(trace);
      await persistAgentToolEvent(dbClient, snapshot.session.id, {
        eventId: crypto.randomUUID(),
        executionMode,
        finishedAt,
        input: event.args,
        name: event.name,
        outputPreview: event.output.slice(0, 500),
        phase: "finished",
        prompt,
        runId,
        selectedProject,
        startedAt: finishedAt,
        status: "completed",
      });
    }

    const persistedAssistant = await persistMessage(
      dbClient,
      snapshot.session.id,
      "assistant",
      result.content,
    );

    const artifact = await persistArtifact(dbClient, snapshot.session.id, "agent_run", {
      executionMode,
      finalResponse: result.content,
      pendingApprovals: [],
      prompt,
      runId,
      selectedProject,
      toolCalls,
    } satisfies AgentRunArtifactPayload);

    const task = await saveTaskState(dbClient, {
      sessionId: snapshot.session.id,
      goal: prompt,
      selectedProject,
      status: "completed",
      lastResponse: result.content,
      lastError: "",
      continueCount,
      settings,
      createdAt,
      updatedAt: nowIso(),
    });

    return {
      approvals: [],
      artifact,
      message: persistedAssistant.message,
      pendingApproval: false,
      session: persistedAssistant.session,
      task,
      toolCalls,
    };
  } catch (error) {
    const message = toErrorMessage(error);
    await saveTaskState(dbClient, {
      sessionId: snapshot.session.id,
      goal: prompt,
      selectedProject,
      status: "failed",
      lastResponse: "",
      lastError: message,
      continueCount,
      settings,
      createdAt,
      updatedAt: nowIso(),
    });
    await persistArtifact(dbClient, snapshot.session.id, "agent_run_failed", {
      error: message,
      executionMode,
      prompt,
      runId,
      selectedProject,
    });
    throw error;
  }
}

async function migrateVibeLocalTables(dbClient: RawAccess) {
  await dbClient.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      mode TEXT NOT NULL
    );
  `);

  await dbClient.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);

  await dbClient.execute(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);

  await dbClient.execute(`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_json TEXT NOT NULL,
      status TEXT NOT NULL,
      sub_agent_id TEXT,
      output_preview TEXT NOT NULL,
      error_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);

  try {
    await dbClient.execute(`
      ALTER TABLE approvals
      ADD COLUMN sub_agent_id TEXT
    `);
  } catch {
    // Existing databases already have the column.
  }

  await dbClient.execute(`
    CREATE TABLE IF NOT EXISTS sub_agents (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      selected_project TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);

  await dbClient.execute(`
    CREATE TABLE IF NOT EXISTS task_state (
      session_id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      selected_project TEXT NOT NULL,
      status TEXT NOT NULL,
      last_response TEXT NOT NULL,
      last_error TEXT NOT NULL,
      continue_count INTEGER NOT NULL,
      settings_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
}

export const vibeLocalActor = actor({
  options: {
    actionTimeout: 180_000,
  },
  createState: async () => ({}),
  db: db({
    onMigrate: migrateVibeLocalTables,
  }),
  actions: {
    health: async (c) => {
      const rows = await c.db.execute<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM sessions
      `);
      return {
        ok: true,
        sessionCount: Number(rows[0]?.count ?? 0),
      };
    },
    hydrate: async (c) => {
      return {
        sessions: await listSessionSummaries(c.db),
      };
    },
    createSession: async (c, title = "") => {
      const createdAt = nowIso();
      const session = {
        id: crypto.randomUUID(),
        title: title.trim() || "New session",
        model: "",
        mode: "plan" as const,
        createdAt,
        updatedAt: createdAt,
      };

      await c.db.execute(
        `
          INSERT INTO sessions(id, title, model, mode, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        session.id,
        session.title,
        session.model,
        session.mode,
        session.createdAt,
        session.updatedAt,
      );

      return {
        session,
        approvals: [],
        messages: [],
        artifacts: [],
        subAgents: [],
        task: null,
      } satisfies SessionSnapshot;
    },
    setSessionConfig: async (c, sessionId: string, model: string, mode: SessionMode) => {
      const snapshot = await requireSnapshot(c.db, sessionId);
      const updatedAt = nowIso();
      await c.db.execute(
        `
          UPDATE sessions
          SET model = ?, mode = ?, updated_at = ?
          WHERE id = ?
        `,
        model,
        mode,
        updatedAt,
        sessionId,
      );

      return {
        ...snapshot.session,
        model,
        mode,
        updatedAt,
      } satisfies SessionRecord;
    },
    appendMessage: async (c, sessionId: string, role: ChatRole, content: string) => {
      return await persistMessage(c.db, sessionId, role, content);
    },
    compactSession: async (c, sessionId: string) => {
      const snapshot = await requireSnapshot(c.db, sessionId);
      if (snapshot.messages.length <= 8) {
        return {
          changed: false,
          messages: snapshot.messages,
          artifact: null,
          session: snapshot.session,
        } satisfies CompactResult;
      }

      const oldMessages = snapshot.messages.slice(0, -8);
      const keepMessages = snapshot.messages.slice(-8);
      const summary = oldMessages
        .map((message) => `${message.role}: ${message.content.replace(/\s+/g, " ").trim()}`)
        .join(" | ")
        .slice(0, 2000);

      const artifact = {
        id: crypto.randomUUID(),
        sessionId,
        kind: "compaction_summary",
        createdAt: nowIso(),
        payload: {
          compactedMessageCount: oldMessages.length,
          summary,
        },
      } satisfies SessionArtifact;

      await c.db.execute("DELETE FROM messages WHERE session_id = ?", sessionId);
      for (const [turnIndex, message] of keepMessages.entries()) {
        await c.db.execute(
          `
            INSERT INTO messages(id, session_id, role, content_json, created_at, turn_index)
            VALUES (?, ?, ?, ?, ?, ?)
          `,
          message.id,
          sessionId,
          message.role,
          JSON.stringify({ text: message.content }),
          message.createdAt,
          turnIndex,
        );
      }

      await c.db.execute(
        `
          INSERT OR REPLACE INTO artifacts(id, session_id, kind, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `,
        artifact.id,
        artifact.sessionId,
        artifact.kind,
        JSON.stringify(artifact.payload),
        artifact.createdAt,
      );

      await c.db.execute(
        `
          UPDATE sessions
          SET updated_at = ?
          WHERE id = ?
        `,
        artifact.createdAt,
        sessionId,
      );

      return {
        changed: true,
        messages: keepMessages.map((message, turnIndex) => ({
          ...message,
          turnIndex,
        })),
        artifact,
        session: {
          ...snapshot.session,
          updatedAt: artifact.createdAt,
        },
      } satisfies CompactResult;
    },
    exportSession: async (c, sessionId: string) => {
      return await getSnapshot(c.db, sessionId);
    },
    runAgentTurn: async (
      c,
      sessionId: string,
      prompt: string,
      settings: BackendSettings,
      selectedProject = "",
    ) => {
      const existing = await requireSnapshot(c.db, sessionId);
      const persistedUser = await persistMessage(c.db, sessionId, "user", prompt);
      const executionMode = sessionModeToExecutionMode(existing.session.mode);

      try {
        return await executePyodideAgentTurn(
          c.db,
          existing,
          persistedUser.message.content,
          settings,
          selectedProject,
          executionMode,
          0,
        );
      } catch (error) {
        const errorMessage = toErrorMessage(error);
        return {
          session: existing.session,
          task: { status: "failed" as const, lastResponse: "", lastError: errorMessage, goal: prompt },
          messages: existing.messages,
          artifacts: existing.artifacts,
          approvals: existing.approvals,
          subAgents: existing.subAgents,
          error: errorMessage,
        };
      }
    },
  },
});
