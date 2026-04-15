/**
 * Pyodide runtime — loads vibe-coder.py (the original Python agent core)
 * inside Pyodide WASM and bridges host I/O (HTTP, subprocess) via JS.
 *
 * This is the "vibe-local-wasm" essence: vibe-coder.py runs unchanged in
 * Pyodide, and its urllib/subprocess calls are monkey-patched to route
 * through Node's child_process. That way the original Python agent code
 * is what actually drives LLM calls and tool execution.
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, isMainThread, workerData } from "node:worker_threads";

import { REPO_ROOT } from "./config.js";
import {
  BLOCKED_EXECUTABLES,
  PATH_VALUE_FLAGS,
  SYSTEM_EXEC_DIRS,
  WATCH_IGNORED_DIRS,
  WATCH_IGNORED_EXTS,
  isAllowedAccessPath as sharedIsAllowedAccessPath,
  isPathInside,
  isSystemExecutablePath as sharedIsSystemExecutablePath,
  looksLikeUrl,
  resolveAccessPath as sharedResolveAccessPath,
  resolveExecutable as sharedResolveExecutable,
  stripHtmlTags as sharedStripHtmlTags,
  truncateContent as sharedTruncateContent,
  validateCommandArgs as sharedValidateCommandArgs,
  validatePathLikeArg as sharedValidatePathLikeArg,
} from "./shared/capability-policy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VIBE_CODER_PATH = path.resolve(__dirname, "pyodide-core/vibe-coder.py");
const EXECUTION_ROOT = path.resolve(process.cwd());
const TMP_ROOT = path.resolve(tmpdir());
const SANDBOX_HOME = path.join(TMP_ROOT, "vibe-local-wasm-home");
const SANDBOX_CONFIG_HOME = path.join(SANDBOX_HOME, ".config");
const SANDBOX_CACHE_HOME = path.join(SANDBOX_HOME, ".cache");
const SANDBOX_DATA_HOME = path.join(SANDBOX_HOME, ".local", "share");

mkdirSync(SANDBOX_HOME, { recursive: true });
mkdirSync(SANDBOX_CONFIG_HOME, { recursive: true });
mkdirSync(SANDBOX_CACHE_HOME, { recursive: true });
mkdirSync(SANDBOX_DATA_HOME, { recursive: true });

function isAllowedAccessPath(candidate: string) {
  return sharedIsAllowedAccessPath(candidate, EXECUTION_ROOT, TMP_ROOT);
}

function resolveAccessPath(raw: string, baseDir = EXECUTION_ROOT) {
  return sharedResolveAccessPath(raw, EXECUTION_ROOT, TMP_ROOT, baseDir);
}

function resolveExecutionCwd(raw?: string) {
  if (!raw) {
    return EXECUTION_ROOT;
  }
  const resolved = resolveAccessPath(raw, EXECUTION_ROOT);
  if (!existsSync(resolved)) {
    throw new Error(`Working directory does not exist: ${raw}`);
  }
  return resolved;
}

function isSystemExecutablePath(candidate: string) {
  return sharedIsSystemExecutablePath(candidate);
}

function resolveExecutable(command: string, cwd: string) {
  return sharedResolveExecutable(command, cwd, EXECUTION_ROOT, TMP_ROOT);
}

function validatePathLikeArg(value: string, cwd: string) {
  sharedValidatePathLikeArg(value, cwd, EXECUTION_ROOT, TMP_ROOT);
}

function validateCommandArgs(args: string[], cwd: string) {
  sharedValidateCommandArgs(args, cwd, EXECUTION_ROOT, TMP_ROOT);
}

function splitCommand(command: string) {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (const char of command) {
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

function childProcessEnv() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: SANDBOX_HOME,
    XDG_CACHE_HOME: SANDBOX_CACHE_HOME,
    XDG_CONFIG_HOME: SANDBOX_CONFIG_HOME,
    XDG_DATA_HOME: SANDBOX_DATA_HOME,
    npm_config_userconfig: "/dev/null",
    PIP_CONFIG_FILE: "/dev/null",
    PYTHONNOUSERSITE: "1",
  };
}

const WEB_SEARCH_MIN_INTERVAL_MS = 2_000;
const WEB_SEARCH_MAX_PER_SESSION = 50;
let lastWebSearchAt = 0;
let webSearchCount = 0;
type RuntimeAgentContext = {
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
};
let currentAgentContext: RuntimeAgentContext | null = null;

type RuntimeTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

type RuntimeTask = {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  status: RuntimeTaskStatus;
  blocks: string[];
  blockedBy: string[];
};

let nextTaskId = 1;
const runtimeTasks = new Map<string, RuntimeTask>();

function sleepSync(ms: number) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stripHtml(text: string) {
  return sharedStripHtmlTags(text);
}

function normalizeCharsetLabel(label: string | null | undefined) {
  if (!label) return "utf-8";
  const normalized = label.trim().toLowerCase();
  switch (normalized) {
    case "shift-jis":
    case "shift_jis":
    case "sjis":
    case "ms932":
    case "windows-31j":
    case "cp932":
      return "shift_jis";
    case "euc-jp":
    case "euc_jp":
      return "euc-jp";
    case "utf8":
      return "utf-8";
    default:
      return normalized;
  }
}

function detectHtmlCharset(buffer: Buffer) {
  const probe = buffer.subarray(0, Math.min(buffer.length, 4096)).toString("latin1");
  const metaCharset =
    probe.match(/<meta[^>]+charset=["']?\s*([A-Za-z0-9._-]+)/i)?.[1] ??
    probe.match(/content=["'][^"']*charset=\s*([A-Za-z0-9._-]+)/i)?.[1] ??
    probe.match(/<\?xml[^>]+encoding=["']\s*([A-Za-z0-9._-]+)/i)?.[1] ??
    null;
  return normalizeCharsetLabel(metaCharset);
}

function decodeHtmlResponse(buffer: Buffer) {
  const charset = detectHtmlCharset(buffer);
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function extractHtmlMetadata(html: string) {
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const heading = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  const subheading = stripHtml(html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? "");
  return { title, heading, subheading };
}

function fetchWebText(url: string) {
  const out = execFileSync(
    "curl",
    ["-s", "-L", "--max-time", "30", "-A", "vibe-local-wasm/1.0", url],
    { encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 35_000 },
  ) as Buffer;
  const html = decodeHtmlResponse(out);
  const meta = extractHtmlMetadata(html);
  const body = stripHtml(html);
  const prefix = [
    meta.title ? `Title: ${meta.title}` : "",
    meta.heading ? `Heading: ${meta.heading}` : "",
    meta.subheading ? `Subheading: ${meta.subheading}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return [prefix, body].filter(Boolean).join("\n\n").slice(0, 5000) || "(empty)";
}

function decodeDuckDuckGoUrl(rawUrl: string) {
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) {
      return decodeURIComponent(uddg);
    }
    if (rawUrl.startsWith("//")) {
      return `https:${rawUrl}`;
    }
    return parsed.toString();
  } catch {
    return rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
  }
}

function formatWebSearchResults(
  query: string,
  results: Array<{ title: string; url: string; snippet: string }>,
) {
  if (results.length === 0) {
    return `No search results found for "${query}".`;
  }
  const lines = [`Search results for: ${query}`, ""];
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`);
    lines.push(`   ${result.url}`);
    if (result.snippet) {
      lines.push(`   ${result.snippet}`);
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

function parseDuckDuckGoResults(html: string, maxResults = 8) {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const titleLinkRegex =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

  let match: RegExpExecArray | null;
  while ((match = titleLinkRegex.exec(html)) !== null && results.length < maxResults) {
    const url = decodeDuckDuckGoUrl(match[1] ?? "");
    const title = stripHtml(match[2] ?? "");
    if (!url || !title) continue;
    if (url.includes("/y.js?") || url.includes("ad_provider") || url.includes("duckduckgo.com/y.js")) {
      continue;
    }

    const nearbyHtml = html.slice(match.index, match.index + 2_000);
    const snippetMatch = nearbyHtml.match(
      /<[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/,
    );
    const snippet = stripHtml(snippetMatch?.[1] ?? "");
    results.push({ title, url, snippet });
  }

  return results;
}

function runWebSearch(query: string) {
  if (!query.trim()) {
    throw new Error("query required");
  }
  if (webSearchCount >= WEB_SEARCH_MAX_PER_SESSION) {
    return "Error: search limit reached for this session. Use WebFetch on specific URLs instead.";
  }

  const now = Date.now();
  const waitMs = WEB_SEARCH_MIN_INTERVAL_MS - (now - lastWebSearchAt);
  if (waitMs > 0) {
    sleepSync(waitMs);
  }
  lastWebSearchAt = Date.now();
  webSearchCount += 1;

  const lang = String(process.env.LANG ?? "").toLowerCase();
  const region = lang.includes("ja")
    ? "jp-ja"
    : lang.includes("zh")
      ? "cn-zh"
      : lang.includes("ko")
        ? "kr-kr"
        : "wt-wt";
  const url = `https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query, kl: region }).toString()}`;

  try {
    const html = execFileSync(
      "curl",
      [
        "-s",
        "-L",
        "--max-time",
        "30",
        "-A",
        "vibe-local-wasm/1.0 (+https://github.com/ochyai/vibe-local)",
        "-H",
        `Accept-Language: ${lang.includes("ja") ? "ja,en;q=0.9" : "en-US,en;q=0.9"}`,
        url,
      ],
      {
        encoding: "utf8",
        env: childProcessEnv(),
        maxBuffer: 8 * 1024 * 1024,
        timeout: 35_000,
      },
    );
    const lowered = html.toLowerCase();
    if (
      (lowered.includes("captcha") ||
        lowered.includes("verify you are human") ||
        lowered.includes("are you a robot") ||
        lowered.includes("unusual traffic")) &&
      !html.includes('class="result__a"')
    ) {
      return "Web search blocked by CAPTCHA. You may be rate-limited. Try again later or use WebFetch on a specific URL.";
    }
    return formatWebSearchResults(query, parseDuckDuckGoResults(html));
  } catch (err) {
    return `Web search failed (network error): ${err instanceof Error ? err.message : String(err)}`;
  }
}

function splitNotebookSourceLines(source: string) {
  if (source === "") return [];
  return source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function writeNotebookAtomically(notebookPath: string, notebook: unknown) {
  const tmpPath = `${notebookPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(notebook, null, 1)}\n`, "utf8");
  try {
    renameSync(tmpPath, notebookPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

function editNotebook(params: Record<string, unknown>) {
  const rawPath = String(params.notebook_path ?? "");
  if (!rawPath) {
    throw new Error("no notebook_path provided");
  }

  const notebookPath = resolveHostPath(rawPath);
  const rawCellNumber = Number(params.cell_number ?? 0);
  if (!Number.isFinite(rawCellNumber) || !Number.isInteger(rawCellNumber)) {
    throw new Error("cell_number must be a number");
  }
  if (rawCellNumber < 0) {
    throw new Error("cell_number cannot be negative");
  }
  const cellNumber = rawCellNumber;
  const newSource = String(params.new_source ?? "");
  const editMode = String(params.edit_mode ?? "replace");
  const rawCellType = params.cell_type;
  const cellType = rawCellType === undefined || rawCellType === null ? undefined : String(rawCellType);
  if (cellType !== undefined && !["code", "markdown", "raw"].includes(cellType)) {
    throw new Error(`invalid cell_type '${cellType}'. Must be: code, markdown, or raw`);
  }

  let notebook: unknown;
  try {
    notebook = JSON.parse(readFileSync(notebookPath, "utf8"));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`notebook is not valid JSON: ${err.message}`);
    }
    throw new Error(`reading notebook: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof notebook !== "object" || notebook === null || !("cells" in notebook)) {
    throw new Error("notebook has no 'cells' key — may be corrupted");
  }

  const mutableNotebook = notebook as { cells?: unknown[] };
  if (!Array.isArray(mutableNotebook.cells)) {
    throw new Error("notebook 'cells' is not a list — may be corrupted");
  }
  const cells = mutableNotebook.cells as Array<Record<string, unknown>>;

  if (editMode === "insert") {
    const effectiveCellType = cellType ?? "code";
    const newCell: Record<string, unknown> = {
      cell_type: effectiveCellType,
      metadata: {},
      source: splitNotebookSourceLines(newSource),
    };
    if (effectiveCellType === "code") {
      newCell.outputs = [];
      newCell.execution_count = null;
    }
    cells.splice(Math.min(cellNumber, cells.length), 0, newCell);
  } else if (editMode === "delete") {
    if (cellNumber >= cells.length) {
      throw new Error(`cell ${cellNumber} out of range (0-${cells.length - 1})`);
    }
    cells.splice(cellNumber, 1);
  } else if (editMode === "replace") {
    if (cellNumber >= cells.length) {
      throw new Error(`cell ${cellNumber} out of range (0-${cells.length - 1})`);
    }
    const existingCell = cells[cellNumber] ?? {};
    const oldType = String(existingCell.cell_type ?? "code");
    const effectiveCellType = cellType ?? oldType;
    existingCell.source = splitNotebookSourceLines(newSource);
    existingCell.cell_type = effectiveCellType;
    if (oldType === "code" && effectiveCellType !== "code") {
      delete existingCell.outputs;
      delete existingCell.execution_count;
    } else if (oldType !== "code" && effectiveCellType === "code") {
      existingCell.outputs ??= [];
      existingCell.execution_count ??= null;
    }
    cells[cellNumber] = existingCell;
  } else {
    throw new Error("edit_mode must be one of: replace, insert, delete");
  }

  mutableNotebook.cells = cells;
  writeNotebookAtomically(notebookPath, mutableNotebook);
  return `Notebook ${editMode}d cell ${cellNumber} in ${notebookPath}`;
}

function formatTaskList() {
  if (runtimeTasks.size === 0) {
    return "No tasks.";
  }
  const lines = Array.from(runtimeTasks.entries())
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([taskId, task]) => {
      const openBlockers = task.blockedBy.filter((blockerId) => {
        const blocker = runtimeTasks.get(blockerId);
        return blocker !== undefined && blocker.status !== "completed";
      });
      const blocked = openBlockers.length > 0 ? `  blockedBy: [${openBlockers.join(", ")}]` : "";
      return `  #${taskId}. [${task.status}] ${task.subject}${blocked}`;
    });
  return `Tasks:\n${lines.join("\n")}`;
}

function getReachableTaskIds(startId: string) {
  const visited = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);
    const task = runtimeTasks.get(currentId);
    if (task) {
      stack.push(...task.blocks);
    }
  }
  return visited;
}

function createTask(params: Record<string, unknown>) {
  const subject = String(params.subject ?? "").trim();
  const description = String(params.description ?? "").trim();
  const activeFormRaw = String(params.activeForm ?? "").trim();
  if (!subject) {
    throw new Error("subject is required");
  }
  if (!description) {
    throw new Error("description is required");
  }
  if (runtimeTasks.size >= 200) {
    return "Error: task limit reached (200). Delete old tasks before creating new ones.";
  }
  const taskId = String(nextTaskId++);
  runtimeTasks.set(taskId, {
    id: taskId,
    subject,
    description,
    activeForm: activeFormRaw || `Working on: ${subject}`,
    status: "pending",
    blocks: [],
    blockedBy: [],
  });
  return `Created task #${taskId}: ${subject}`;
}

function getTask(params: Record<string, unknown>) {
  const taskId = String(params.taskId ?? "").trim();
  if (!taskId) {
    throw new Error("taskId is required");
  }
  const task = runtimeTasks.get(taskId);
  if (!task) {
    return `Error: task #${taskId} not found`;
  }
  const lines = [
    `Task #${taskId}`,
    `  Subject: ${task.subject}`,
    `  Status: ${task.status}`,
    `  ActiveForm: ${task.activeForm}`,
    `  Description: ${task.description}`,
  ];
  if (task.blocks.length > 0) {
    lines.push(`  Blocks: [${task.blocks.join(", ")}]`);
  }
  if (task.blockedBy.length > 0) {
    lines.push(`  BlockedBy: [${task.blockedBy.join(", ")}]`);
  }
  return lines.join("\n");
}

function updateTask(params: Record<string, unknown>) {
  const taskId = String(params.taskId ?? "").trim();
  if (!taskId) {
    throw new Error("taskId is required");
  }
  const task = runtimeTasks.get(taskId);
  if (!task) {
    return `Error: task #${taskId} not found`;
  }

  const status = params.status;
  if (status !== undefined && status !== null && status !== "") {
    const nextStatus = String(status);
    if (!["pending", "in_progress", "completed", "deleted"].includes(nextStatus)) {
      return `Error: invalid status '${nextStatus}'. Must be: completed, deleted, in_progress, pending`;
    }
    if (nextStatus === "deleted") {
      runtimeTasks.delete(taskId);
      for (const otherTask of runtimeTasks.values()) {
        otherTask.blocks = otherTask.blocks.filter((value) => value !== taskId);
        otherTask.blockedBy = otherTask.blockedBy.filter((value) => value !== taskId);
      }
      return `Deleted task #${taskId}`;
    }
    task.status = nextStatus as RuntimeTaskStatus;
  }

  if (typeof params.subject === "string" && params.subject) {
    task.subject = params.subject;
  }
  if (typeof params.description === "string" && params.description) {
    task.description = params.description;
  }

  const addBlocks = Array.isArray(params.addBlocks) ? params.addBlocks.map(String) : [];
  for (const blockId of addBlocks) {
    if (getReachableTaskIds(blockId).has(taskId)) {
      return `Error: adding block #${blockId} would create a dependency cycle`;
    }
    if (!task.blocks.includes(blockId)) {
      task.blocks.push(blockId);
    }
    const otherTask = runtimeTasks.get(blockId);
    if (otherTask && !otherTask.blockedBy.includes(taskId)) {
      otherTask.blockedBy.push(taskId);
    }
  }

  const addBlockedBy = Array.isArray(params.addBlockedBy) ? params.addBlockedBy.map(String) : [];
  for (const blockerId of addBlockedBy) {
    if (getReachableTaskIds(taskId).has(blockerId)) {
      return `Error: adding blockedBy #${blockerId} would create a dependency cycle`;
    }
    if (!task.blockedBy.includes(blockerId)) {
      task.blockedBy.push(blockerId);
    }
    const otherTask = runtimeTasks.get(blockerId);
    if (otherTask && !otherTask.blocks.includes(taskId)) {
      otherTask.blocks.push(taskId);
    }
  }

  return `Updated task #${taskId}: [${task.status}] ${task.subject}`;
}

function readLineFromTerminal(prompt: string) {
  const buffer = Buffer.alloc(1);
  const useTty = process.stdin.isTTY;
  const fd = useTty ? openSync("/dev/tty", "rs") : process.stdin.fd;
  let output = "";
  try {
    process.stdout.write(prompt);
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, 1, null);
      if (bytesRead === 0) {
        return output === "" ? null : output;
      }
      const chunk = buffer.toString("utf8", 0, bytesRead);
      if (chunk === "\r") {
        continue;
      }
      if (chunk === "\n") {
        break;
      }
      output += chunk;
    }
    return output;
  } finally {
    if (useTty) {
      closeSync(fd);
    }
  }
}

function askUserQuestion(params: Record<string, unknown>) {
  const question = String(params.question ?? "").trim();
  if (!question) {
    throw new Error("question is required");
  }
  const options = Array.isArray(params.options) ? params.options.map(String) : [];
  process.stdout.write(`\nQuestion: ${question}\n`);
  if (options.length > 0) {
    options.forEach((option, index) => {
      process.stdout.write(`  ${index + 1}. ${option}\n`);
    });
    process.stdout.write("  Enter number or type your own answer:\n");
  } else {
    process.stdout.write("  Type your answer:\n");
  }

  let answer: string | null;
  try {
    answer = readLineFromTerminal("  > ");
  } catch {
    return "User cancelled the question.";
  }
  if (answer === null) {
    return "User cancelled the question.";
  }
  const trimmed = answer.trim();
  if (!trimmed) {
    return "User provided no answer.";
  }
  if (options.length > 0 && /^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    if (index >= 0 && index < options.length) {
      return `User chose: ${options[index]}`;
    }
  }
  return `User answered: ${trimmed}`;
}

function buildFunctionSchema(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
      },
    },
  };
}

const SUBAGENT_TOOL_SCHEMAS = {
  Read: buildFunctionSchema(
    "Read",
    "Read a file from disk with optional offset and line limit.",
    {
      file_path: { type: "string", description: "Path to the file to read" },
      offset: { type: "integer", description: "0-indexed line offset" },
      limit: { type: "integer", description: "Maximum number of lines to read" },
    },
    ["file_path"],
  ),
  Glob: buildFunctionSchema(
    "Glob",
    "Find files matching a glob pattern.",
    {
      pattern: { type: "string", description: "Glob pattern to match" },
    },
    ["pattern"],
  ),
  Grep: buildFunctionSchema(
    "Grep",
    "Search file contents with ripgrep.",
    {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "Optional glob filter for files" },
    },
    ["pattern"],
  ),
  WebFetch: buildFunctionSchema(
    "WebFetch",
    "Fetch a URL and return readable text content.",
    {
      url: { type: "string", description: "URL to fetch" },
    },
    ["url"],
  ),
  WebSearch: buildFunctionSchema(
    "WebSearch",
    "Search the web using DuckDuckGo and return titles, URLs, and snippets.",
    {
      query: { type: "string", description: "Search query" },
    },
    ["query"],
  ),
  Bash: buildFunctionSchema(
    "Bash",
    "Run a shell command within the allowed execution root.",
    {
      command: { type: "string", description: "Command to run" },
      timeout: { type: "integer", description: "Timeout in milliseconds" },
    },
    ["command"],
  ),
  Write: buildFunctionSchema(
    "Write",
    "Write full file contents to disk.",
    {
      file_path: { type: "string", description: "Path to the file to write" },
      content: { type: "string", description: "Complete file contents" },
    },
    ["file_path", "content"],
  ),
  Edit: buildFunctionSchema(
    "Edit",
    "Replace text inside a file.",
    {
      file_path: { type: "string", description: "Path to the file to edit" },
      old_string: { type: "string", description: "Text to replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace all occurrences" },
    },
    ["file_path", "old_string", "new_string"],
  ),
} as const;

function chatCompletionsSync(
  context: RuntimeAgentContext,
  messages: Array<Record<string, unknown>>,
  tools?: Array<Record<string, unknown>>,
) {
  const url = `${context.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const headers = [
    "-H",
    "Content-Type: application/json",
  ];
  if (process.env.OPENAI_API_KEY) {
    headers.push("-H", `Authorization: Bearer ${process.env.OPENAI_API_KEY}`);
  }
  const body = JSON.stringify({
    model: context.model,
    messages,
    tools: tools && tools.length > 0 ? tools : undefined,
    stream: false,
    max_tokens: context.maxTokens,
    temperature: context.temperature,
  });
  const raw = execFileSync(
    "curl",
    ["-sS", "-L", "--max-time", "60", "-X", "POST", url, ...headers, "--data-raw", body],
    {
      encoding: "utf8",
      env: childProcessEnv(),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 65_000,
    },
  );
  const parsed = JSON.parse(raw) as Record<string, any>;
  if (parsed.error) {
    const message =
      typeof parsed.error === "string"
        ? parsed.error
        : parsed.error.message ?? JSON.stringify(parsed.error);
    throw new Error(message);
  }
  if (Array.isArray(parsed.choices)) {
    return (parsed.choices[0]?.message ?? {}) as Record<string, any>;
  }
  if (parsed.message && typeof parsed.message === "object") {
    return parsed.message as Record<string, any>;
  }
  throw new Error("Unexpected chat response shape");
}

function executeSubAgentAllowedTool(name: string, params: Record<string, unknown>) {
  switch (name) {
    case "Bash": {
      const cmd = String(params.command ?? "");
      if (!cmd) return { ok: false, error: "No command" };
      const timeoutMs = Number(params.timeout ?? 120_000);
      try {
        const argv = splitCommand(cmd);
        const stdout = runRestrictedCommand(argv, EXECUTION_ROOT, timeoutMs);
        return { ok: true, output: stdout.trim() || "(no output)" };
      } catch (err) {
        const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; code?: number; message?: string };
        const so = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString("utf8") ?? "";
        const se = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString("utf8") ?? e.message ?? "";
        const rc = typeof e.code === "number" ? e.code : -1;
        return { ok: true, output: [so, se].filter(Boolean).join("\n") + `\n(exit code: ${rc})` };
      }
    }
    case "Read": {
      const filePath = resolveHostPath(String(params.file_path ?? ""));
      const offset = Number(params.offset ?? 0);
      const limit = Number(params.limit ?? 2000);
      const content = readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      const numbered = lines
        .slice(offset, offset + limit)
        .map((line, i) => `${String(offset + i + 1).padStart(6)}\t${line}`)
        .join("\n");
      return { ok: true, output: numbered };
    }
    case "Write": {
      const filePath = resolveHostPath(String(params.file_path ?? ""));
      const content = String(params.content ?? "");
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf8");
      return {
        ok: true,
        output: `Wrote ${content.length} chars to ${path.relative(REPO_ROOT, filePath) || filePath}`,
      };
    }
    case "Edit": {
      const filePath = resolveHostPath(String(params.file_path ?? ""));
      const oldStr = String(params.old_string ?? "");
      const newStr = String(params.new_string ?? "");
      const replaceAll = Boolean(params.replace_all);
      if (!oldStr) return { ok: false, error: "old_string is required" };
      const before = readFileSync(filePath, "utf8");
      if (!before.includes(oldStr)) {
        return { ok: false, error: `old_string not found in ${filePath}` };
      }
      const after = replaceAll ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
      writeFileSync(filePath, after, "utf8");
      return { ok: true, output: `Edited ${path.relative(REPO_ROOT, filePath) || filePath}` };
    }
    case "Glob": {
      const pattern = String(params.pattern ?? "");
      if (!pattern) return { ok: false, error: "pattern required" };
      try {
        const stdout = execFileSync(
          "rg",
          ["--files", "--hidden", "--glob", pattern, "--glob", "!**/node_modules/**", "--glob", "!**/.git/**"],
          {
            cwd: EXECUTION_ROOT,
            encoding: "utf8",
            env: childProcessEnv(),
            maxBuffer: 16 * 1024 * 1024,
            timeout: 20_000,
          },
        );
        return { ok: true, output: stdout.split("\n").filter(Boolean).slice(0, 100).join("\n") || "(no matches)" };
      } catch (err) {
        const e = err as { code?: number; message?: string };
        if (e.code === 1) return { ok: true, output: "(no matches)" };
        return { ok: false, error: e.message ?? String(err) };
      }
    }
    case "Grep": {
      const pattern = String(params.pattern ?? "");
      if (!pattern) return { ok: false, error: "pattern required" };
      const rgArgs = ["-n", "--hidden", "--glob", "!**/node_modules/**", "--glob", "!**/.git/**"];
      if (params.path) rgArgs.push("-g", String(params.path));
      rgArgs.push(pattern, REPO_ROOT);
      try {
        const stdout = execFileSync("rg", rgArgs, {
          cwd: EXECUTION_ROOT,
          encoding: "utf8",
          env: childProcessEnv(),
          maxBuffer: 16 * 1024 * 1024,
          timeout: 20_000,
        });
        return { ok: true, output: stdout.split("\n").filter(Boolean).slice(0, 50).join("\n") || "(no matches)" };
      } catch (err) {
        const e = err as { code?: number; message?: string };
        if (e.code === 1) return { ok: true, output: "(no matches)" };
        return { ok: false, error: e.message ?? String(err) };
      }
    }
    case "WebFetch": {
      const url = String(params.url ?? "");
      if (!url) return { ok: false, error: "url required" };
      try {
        return { ok: true, output: fetchWebText(url) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    case "WebSearch":
      return { ok: true, output: runWebSearch(String(params.query ?? "")) };
    default:
      return { ok: false, error: `Tool '${name}' is not allowed in this sub-agent` };
  }
}

function truncateContent(value: string, limit: number, suffix: string) {
  return sharedTruncateContent(value, limit, suffix);
}

function runSubAgentLoop(
  task: Record<string, unknown>,
  context: RuntimeAgentContext,
  dispatchTool: (name: string, params: Record<string, unknown>) => { ok: boolean; output?: string; error?: string },
) {
  const prompt = String(task.prompt ?? "");
  if (!prompt) {
    return "Error: prompt is required";
  }

  const rawMaxTurns = Number(task.max_turns ?? 10);
  const maxTurns = Number.isFinite(rawMaxTurns) ? Math.max(1, Math.min(Math.trunc(rawMaxTurns), 20)) : 10;
  const allowWrites = Boolean(task.allow_writes);
  const allowedTools = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);
  if (allowWrites) {
    allowedTools.add("Bash");
    allowedTools.add("Write");
    allowedTools.add("Edit");
  }

  const label = String(task._agent_label ?? "").trim();
  const labelDisplay = label ? ` [${label}]` : "";
  const promptPreview = truncateContent(prompt, 80, "...");
  const startedAt = Date.now();
  process.stdout.write(`\n  🤖${labelDisplay} Sub-agent working on: ${promptPreview}\n`);

  const messages: Array<Record<string, unknown>> = [
    {
      role: "system",
      content:
        "You are a sub-agent assistant. Complete the given task using the available tools. " +
        "Be thorough but concise. When you have enough information, provide a clear final answer. " +
        "Do NOT ask follow-up questions — just complete the task and respond.\n" +
        `Working directory: ${EXECUTION_ROOT}\nPlatform: ${process.platform}\n`,
    },
    { role: "user", content: prompt },
  ];

  const tools = Array.from(allowedTools).map((toolName) => SUBAGENT_TOOL_SCHEMAS[toolName as keyof typeof SUBAGENT_TOOL_SCHEMAS]);
  let lastText = "";
  let resultText = "";

  for (let turn = 0; turn < maxTurns; turn += 1) {
    let message: Record<string, any>;
    try {
      message = chatCompletionsSync(context, messages, tools);
    } catch (err) {
      resultText = `Sub-agent error on turn ${turn + 1}: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }

    const text = String(message.content ?? "");
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    lastText = text;

    if (toolCalls.length === 0) {
      resultText = text;
      break;
    }

    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      const fn = (toolCall as Record<string, any>).function ?? {};
      const toolName = String(fn.name ?? "");
      const toolCallId = String((toolCall as Record<string, any>).id ?? `call_${messages.length}`);
      let toolArgs: Record<string, unknown> = {};
      try {
        toolArgs = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : (fn.arguments ?? {});
      } catch {
        toolArgs = { raw: fn.arguments };
      }

      let toolOutput: string;
      if (!allowedTools.has(toolName)) {
        toolOutput = `Error: tool '${toolName}' is not allowed in this sub-agent`;
      } else {
        const toolResult = dispatchTool(toolName, toolArgs);
        toolOutput = toolResult.ok ? String(toolResult.output ?? "") : `Error: ${toolResult.error ?? "unknown error"}`;
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        name: toolName,
        content: truncateContent(toolOutput, 10_000, "\n...(truncated)"),
      });
    }

    const totalChars = messages.reduce((sum, entry) => sum + String(entry.content ?? "").length, 0);
    if (totalChars > 80_000) {
      for (let index = 2; index < messages.length - 4; index += 1) {
        const entry = messages[index];
        if (entry?.role === "tool" && typeof entry.content === "string" && entry.content.length > 500) {
          entry.content = `${entry.content.slice(0, 500)}\n...(truncated by sub-agent context limit)`;
        }
      }
    }
  }

  if (!resultText) {
    resultText = `Sub-agent reached max turns (${maxTurns}). Last response: ${truncateContent(lastText, 2000, "...")}`;
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write(`  🤖${labelDisplay} Sub-agent finished (${elapsedSec}s)\n`);
  return truncateContent(resultText, 20_000, "\n...(truncated)");
}

type ParallelWorkerPayload = {
  kind: "parallel-subagent";
  task: Record<string, unknown>;
  context: RuntimeAgentContext;
  resultPath: string;
  doneBuffer: SharedArrayBuffer;
};

function runParallelAgents(
  tasks: Record<string, unknown>[],
  context: RuntimeAgentContext,
) {
  const limitedTasks = tasks.slice(0, 4);
  if (limitedTasks.length === 0) {
    return "Error: at least one task is required";
  }

  process.stdout.write(`\n  🤖 Launching ${limitedTasks.length} parallel agents...\n`);
  const currentModulePath = fileURLToPath(import.meta.url);
  const builtWorkerPath = path.resolve(__dirname, "../dist/pyodide-runtime.js");
  const workerEntry =
    currentModulePath.endsWith(".ts") && existsSync(builtWorkerPath)
      ? { url: pathToFileURL(builtWorkerPath), execArgv: [] as string[] }
      : { url: new URL(import.meta.url), execArgv: ["--import", "tsx"] };

  const workers = limitedTasks.map((task, index) => {
    const resultPath = path.join(TMP_ROOT, `vlw-subagent-${process.pid}-${Date.now()}-${index}.json`);
    const doneBuffer = new SharedArrayBuffer(4);
    const payload: ParallelWorkerPayload = {
      kind: "parallel-subagent",
      task: { ...task, _agent_label: `Agent ${index + 1}/${limitedTasks.length}` },
      context,
      resultPath,
      doneBuffer,
    };
    const worker = new Worker(workerEntry.url, {
      workerData: payload,
      execArgv: workerEntry.execArgv,
    });
    return { worker, resultPath, done: new Int32Array(doneBuffer), task, index };
  });

  const startedAt = Date.now();
  let nextHeartbeatAt = startedAt + 10_000;
  for (const entry of workers) {
    while (Atomics.load(entry.done, 0) === 0) {
      const now = Date.now();
      if (now >= nextHeartbeatAt) {
        const completed = workers.filter((item) => Atomics.load(item.done, 0) === 1).length;
        process.stdout.write(`  ⏳ Parallel agents: ${completed}/${workers.length} done, ${Math.round((now - startedAt) / 1000)}s elapsed...\n`);
        nextHeartbeatAt = now + 10_000;
      }
      Atomics.wait(entry.done, 0, 0, 1_000);
    }
  }

  const results = workers.map((entry) => {
    entry.worker.terminate().catch(() => {});
    try {
      const raw = readFileSync(entry.resultPath, "utf8");
      unlinkSync(entry.resultPath);
      return JSON.parse(raw) as { prompt: string; result: string; duration: number; error: string | null };
    } catch (err) {
      return {
        prompt: String(entry.task.prompt ?? "").slice(0, 100),
        result: "",
        duration: 300,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const succeeded = results.filter((item) => !item.error).length;
  const failed = results.length - succeeded;
  const totalTime = Math.max(...results.map((item) => item.duration), 0);
  const outputParts: string[] = [];
  results.forEach((result, index) => {
    const status = result.error ? "FAIL" : "OK";
    outputParts.push(`┌─── Agent ${index + 1}/${results.length} [${status}] ───`);
    outputParts.push(`│ Task: ${truncateContent(result.prompt, 80, "...")}`);
    outputParts.push(`│ Time: ${result.duration.toFixed(1)}s`);
    if (result.error) {
      outputParts.push(`│ Error: ${result.error}`);
    } else {
      const resultText = truncateContent(result.result, 3000, "\n...(result truncated)");
      resultText.split("\n").forEach((line) => outputParts.push(`│ ${line}`));
    }
    outputParts.push(`└${"─".repeat(40)}`);
  });
  let summary = `Summary: ${succeeded}/${results.length} succeeded`;
  if (failed > 0) {
    summary += `, ${failed} failed`;
  }
  summary += ` (total wall time: ${totalTime.toFixed(1)}s)`;
  outputParts.push(summary);
  process.stdout.write(`  🤖 All ${results.length} agents finished (${succeeded} OK, ${failed} failed, ${totalTime.toFixed(1)}s)\n`);
  return outputParts.join("\n");
}

if (!isMainThread && workerData && (workerData as ParallelWorkerPayload).kind === "parallel-subagent") {
  const data = workerData as ParallelWorkerPayload;
  const done = new Int32Array(data.doneBuffer);
  try {
    const start = Date.now();
    const result = runSubAgentLoop(data.task, data.context, executeSubAgentAllowedTool);
    writeFileSync(
      data.resultPath,
      JSON.stringify({
        prompt: String(data.task.prompt ?? "").slice(0, 100),
        result,
        duration: (Date.now() - start) / 1000,
        error: null,
      }),
      "utf8",
    );
  } catch (err) {
    writeFileSync(
      data.resultPath,
      JSON.stringify({
        prompt: String(data.task.prompt ?? "").slice(0, 100),
        result: "",
        duration: 0,
        error: err instanceof Error ? err.message : String(err),
      }),
      "utf8",
    );
  } finally {
    Atomics.store(done, 0, 1);
    Atomics.notify(done, 0);
  }
}

function runRestrictedCommand(argv: string[], cwd: string, timeoutMs: number) {
  if (argv.length === 0) {
    throw new Error("Empty argv");
  }
  const effectiveCwd = resolveExecutionCwd(cwd);
  const [rawExecutable, ...args] = argv;
  const executable = resolveExecutable(rawExecutable, effectiveCwd);
  validateCommandArgs(args, effectiveCwd);
  return execFileSync(executable, args, {
    cwd: effectiveCwd,
    encoding: "utf8",
    env: childProcessEnv(),
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs > 0 ? timeoutMs : 60_000,
  });
}

/**
 * Resolve a tool-provided path against the execution root. Absolute paths are
 * allowed only when they stay inside the current execution directory or /tmp.
 */
function resolveHostPath(raw: string): string {
  return resolveAccessPath(raw, EXECUTION_ROOT);
}

let pyPromise: Promise<unknown> | null = null;

/**
 * Tool dispatcher — JS-side handler for Python tool calls.
 * The caller (e.g. actor) provides this when calling runPyodideAgentTurn.
 * Returns a JSON-serializable result that Python will wrap as the tool output.
 */
export type ToolDispatcher = (
  toolName: string,
  params: Record<string, unknown>,
) => Promise<{ ok: boolean; output?: string; error?: string }>;

// Currently installed dispatcher (set per call). Initialized to a stub
// that just reports "no dispatcher" to Python.
let currentDispatcher: ToolDispatcher = async (name) => ({
  ok: false,
  error: `No tool dispatcher registered for '${name}'`,
});

async function initPyodide() {
  if (pyPromise) return pyPromise;
  pyPromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — pyodide has no bundled types
    const pyodideMod = await import("pyodide");
    const loadPyodide = (pyodideMod as { loadPyodide: (opts?: unknown) => Promise<unknown> }).loadPyodide;
    const py = (await loadPyodide()) as {
      FS: { writeFile: (path: string, data: string) => void };
      loadPackage: (name: string) => Promise<void>;
      globals: { set: (name: string, value: unknown) => void };
      runPython: (code: string) => unknown;
    };
    await py.loadPackage("sqlite3");

    const src = readFileSync(VIBE_CODER_PATH, "utf8");
    py.FS.writeFile("/vibe_coder.py", src);

    // --- JS bridge: synchronous HTTP via curl ------------------------------

    const jsHttpSync = (
      url: string,
      method: string,
      hjson: string,
      body: string | null,
    ): string => {
      const args = ["-s", "-X", method, "-w", "\n__VLW_STATUS:%{http_code}"];
      try {
        const headers = JSON.parse(hjson) as Record<string, string>;
        for (const [k, v] of Object.entries(headers)) {
          args.push("-H", `${k}: ${v}`);
        }
      } catch {
        // ignore bad header JSON
      }
      if (body !== null) {
        args.push("--data-raw", body);
      }
      args.push(url);
      try {
        return execFileSync("curl", args, {
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          timeout: 300_000,
        });
      } catch (err) {
        return "ERROR:" + (err instanceof Error ? err.message : String(err));
      }
    };
    py.globals.set("_js_http_sync", jsHttpSync);

    // --- JS bridge: synchronous subprocess ---------------------------------
    //
    // argvJson: JSON-encoded string[] — first element is command, rest are args
    // Returns: JSON string with {ok, stdout, stderr, exit_code}

    const jsExecSync = (argvJson: string, cwd: string, timeoutMs: number): string => {
      let argv: string[];
      try {
        argv = JSON.parse(argvJson) as string[];
      } catch (err) {
        return JSON.stringify({
          ok: false,
          stdout: "",
          stderr: `Invalid argv JSON: ${err instanceof Error ? err.message : String(err)}`,
          exit_code: null,
        });
      }
      if (argv.length === 0) {
        return JSON.stringify({ ok: false, stdout: "", stderr: "Empty argv", exit_code: null });
      }
      try {
        if (argv[0] === "sh" && argv[1] === "-c") {
          return JSON.stringify({
            ok: false,
            stdout: "",
            stderr: "shell=true subprocess execution is blocked by the access policy",
            exit_code: null,
          });
        }
        const stdout = runRestrictedCommand(argv, cwd, timeoutMs);
        return JSON.stringify({ ok: true, stdout, stderr: "", exit_code: 0 });
      } catch (err) {
        const e = err as {
          stdout?: Buffer | string;
          stderr?: Buffer | string;
          code?: number;
          message?: string;
        };
        return JSON.stringify({
          ok: false,
          stdout: typeof e.stdout === "string" ? e.stdout : e.stdout?.toString("utf8") ?? "",
          stderr: typeof e.stderr === "string" ? e.stderr : e.stderr?.toString("utf8") ?? e.message ?? "",
          exit_code: typeof e.code === "number" ? e.code : null,
        });
      }
    };
    py.globals.set("_js_exec_sync", jsExecSync);

    // --- JS bridge: synchronous tool dispatch (Option C) -------------------
    //
    // vibe-coder.py's ToolRegistry is monkey-patched so every tool.execute
    // calls this function. Arguments are the Python tool name (e.g. "Bash",
    // "Read") and a JSON-encoded params dict. Result must be a JSON string
    // with { ok, output, error? }.
    //
    // Python's tool.execute is synchronous, so this function must return
    // synchronously. For now we implement the handlers directly here using
    // execFileSync / readFileSync / writeFileSync / curl, reusing the
    // existing TS tool helpers where they happen to be sync-compatible.

    const jsToolDispatch = (name: string, paramsJson: string): string => {
      let params: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(paramsJson);
        if (parsed && typeof parsed === "object") params = parsed as Record<string, unknown>;
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: `Bad params JSON: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      try {
        switch (name) {
          case "Bash": {
            const cmd = String(params.command ?? "");
            if (!cmd) return JSON.stringify({ ok: false, error: "No command" });
            const timeoutMs = Number(params.timeout ?? 120_000);
            try {
              const argv = splitCommand(cmd);
              const stdout = runRestrictedCommand(argv, EXECUTION_ROOT, timeoutMs);
              return JSON.stringify({ ok: true, output: stdout.trim() || "(no output)" });
            } catch (err) {
              const e = err as {
                stdout?: Buffer | string;
                stderr?: Buffer | string;
                code?: number;
                message?: string;
              };
              const so = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString("utf8") ?? "";
              const se = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString("utf8") ?? e.message ?? "";
              const rc = typeof e.code === "number" ? e.code : -1;
              return JSON.stringify({
                ok: true, // non-zero exit is still a "successful" tool run in agent semantics
                output: [so, se].filter(Boolean).join("\n") + `\n(exit code: ${rc})`,
              });
            }
          }
          case "Read": {
            const filePath = resolveHostPath(String(params.file_path ?? ""));
            const offset = Number(params.offset ?? 0);
            const limit = Number(params.limit ?? 2000);
            const content = readFileSync(filePath, "utf8");
            const lines = content.split("\n");
            const sliced = lines.slice(offset, offset + limit);
            // Match cat -n format
            const numbered = sliced
              .map((line, i) => `${String(offset + i + 1).padStart(6)}\t${line}`)
              .join("\n");
            return JSON.stringify({ ok: true, output: numbered });
          }
          case "Write": {
            const filePath = resolveHostPath(String(params.file_path ?? ""));
            const content = String(params.content ?? "");
            mkdirSync(path.dirname(filePath), { recursive: true });
            writeFileSync(filePath, content, "utf8");
            return JSON.stringify({
              ok: true,
              output: `Wrote ${content.length} chars to ${path.relative(REPO_ROOT, filePath) || filePath}`,
            });
          }
          case "Edit": {
            const filePath = resolveHostPath(String(params.file_path ?? ""));
            const oldStr = String(params.old_string ?? "");
            const newStr = String(params.new_string ?? "");
            const replaceAll = Boolean(params.replace_all);
            if (!oldStr) return JSON.stringify({ ok: false, error: "old_string is required" });
            const before = readFileSync(filePath, "utf8");
            if (!before.includes(oldStr)) {
              return JSON.stringify({ ok: false, error: `old_string not found in ${filePath}` });
            }
            const after = replaceAll ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
            writeFileSync(filePath, after, "utf8");
            return JSON.stringify({ ok: true, output: `Edited ${path.relative(REPO_ROOT, filePath) || filePath}` });
          }
          case "Glob": {
            const pattern = String(params.pattern ?? "");
            if (!pattern) return JSON.stringify({ ok: false, error: "pattern required" });
            // Use rg --files --glob for a sync glob
            try {
              const stdout = execFileSync(
                "rg",
                ["--files", "--hidden", "--glob", pattern, "--glob", "!**/node_modules/**", "--glob", "!**/.git/**"],
                {
                  cwd: EXECUTION_ROOT,
                  encoding: "utf8",
                  env: childProcessEnv(),
                  maxBuffer: 16 * 1024 * 1024,
                  timeout: 20_000,
                },
              );
              const files = stdout.split("\n").filter(Boolean).slice(0, 100);
              return JSON.stringify({ ok: true, output: files.join("\n") || "(no matches)" });
            } catch (err) {
              const e = err as { code?: number; message?: string };
              if (e.code === 1) return JSON.stringify({ ok: true, output: "(no matches)" });
              return JSON.stringify({ ok: false, error: e.message ?? String(err) });
            }
          }
          case "Grep": {
            const pattern = String(params.pattern ?? "");
            if (!pattern) return JSON.stringify({ ok: false, error: "pattern required" });
            const rgArgs = ["-n", "--hidden", "--glob", "!**/node_modules/**", "--glob", "!**/.git/**"];
            if (params.path) rgArgs.push("-g", String(params.path));
            rgArgs.push(pattern, REPO_ROOT);
            try {
             const stdout = execFileSync("rg", rgArgs, {
                cwd: EXECUTION_ROOT,
                encoding: "utf8",
                env: childProcessEnv(),
                maxBuffer: 16 * 1024 * 1024,
                timeout: 20_000,
              });
              const lines = stdout.split("\n").filter(Boolean).slice(0, 50);
              return JSON.stringify({ ok: true, output: lines.join("\n") || "(no matches)" });
            } catch (err) {
              const e = err as { code?: number; message?: string };
              if (e.code === 1) return JSON.stringify({ ok: true, output: "(no matches)" });
              return JSON.stringify({ ok: false, error: e.message ?? String(err) });
            }
          }
          case "WebFetch": {
            const url = String(params.url ?? "");
            if (!url) return JSON.stringify({ ok: false, error: "url required" });
            try {
              return JSON.stringify({ ok: true, output: fetchWebText(url) });
            } catch (err) {
              return JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          case "WebSearch": {
            const query = String(params.query ?? "");
            return JSON.stringify({ ok: true, output: runWebSearch(query) });
          }
          case "NotebookEdit": {
            try {
              return JSON.stringify({ ok: true, output: editNotebook(params) });
            } catch (err) {
              return JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          case "TaskCreate": {
            try {
              return JSON.stringify({ ok: true, output: createTask(params) });
            } catch (err) {
              return JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          case "TaskList": {
            return JSON.stringify({ ok: true, output: formatTaskList() });
          }
          case "TaskGet": {
            try {
              return JSON.stringify({ ok: true, output: getTask(params) });
            } catch (err) {
              return JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          case "TaskUpdate": {
            try {
              return JSON.stringify({ ok: true, output: updateTask(params) });
            } catch (err) {
              return JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          case "AskUserQuestion": {
            try {
              return JSON.stringify({ ok: true, output: askUserQuestion(params) });
            } catch (err) {
              return JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          case "SubAgent": {
            if (currentAgentContext === null) {
              return JSON.stringify({
                ok: false,
                error: "SubAgent is only available during a full agent turn",
              });
            }
            try {
              return JSON.stringify({
                ok: true,
                output: runSubAgentLoop(params, currentAgentContext, executeSubAgentAllowedTool),
              });
            } catch (err) {
              return JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          case "ParallelAgents": {
            if (currentAgentContext === null) {
              return JSON.stringify({
                ok: false,
                error: "ParallelAgents is only available during a full agent turn",
              });
            }
            const tasks = Array.isArray(params.tasks) ? params.tasks.filter((task) => task && typeof task === "object") : [];
            try {
              return JSON.stringify({
                ok: true,
                output: runParallelAgents(tasks as Record<string, unknown>[], currentAgentContext),
              });
            } catch (err) {
              return JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          default:
            return JSON.stringify({
              ok: false,
              error: `Tool '${name}' is not yet bridged to JS. Python-side execution would be used.`,
            });
        }
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    py.globals.set("_js_tool_dispatch", jsToolDispatch);

    // --- Install Python-side bridges and load vibe_coder.py ----------------

    py.runPython(`
import sys, json
sys.path.insert(0, '/')

# --- urllib.request bridge -------------------------------------------------
import urllib.request, urllib.error
from io import BytesIO

def _bridged_urlopen(req, data=None, timeout=None, **kw):
    if hasattr(req, 'full_url'):
        url = req.full_url
        method = req.get_method()
        headers = dict(req.headers)
        body = req.data if data is None else data
    else:
        url = str(req)
        method = 'POST' if data else 'GET'
        headers = {}
        body = data
    if body and isinstance(body, (bytes, bytearray)):
        body = bytes(body).decode('utf-8', errors='replace')
    raw = _js_http_sync(url, method, json.dumps(headers), body)
    status = 200
    if '__VLW_STATUS:' in raw:
        idx = raw.rindex('__VLW_STATUS:')
        try:
            status = int(raw[idx+13:].strip())
        except ValueError:
            pass
        raw = raw[:idx].rstrip('\\n')
    if raw.startswith('ERROR:'):
        raise urllib.error.URLError(raw)
    class _R(BytesIO):
        def __init__(self, d, st):
            super().__init__(d)
            self.status = st
            self.code = st
        def getcode(self):
            return self.status
        def __enter__(self):
            return self
        def __exit__(self, *a):
            pass
    return _R(raw.encode('utf-8'), status)

urllib.request.urlopen = _bridged_urlopen

# --- subprocess bridge -----------------------------------------------------
# Monkey-patch subprocess.run / check_output / Popen to route through the
# JS bridge. vibe-coder.py heavily uses subprocess (Bash, Git, rg, etc.).
#
# Popen is patched as a synchronous shim: __init__ runs the command via the
# JS bridge immediately, caches the result, and subsequent communicate()/
# wait()/poll() calls return the cached values. This is sufficient for
# BashTool's usage pattern which always calls communicate() right after.
import subprocess as _sp
import os as _os

_PIPE = _sp.PIPE
_DEVNULL = _sp.DEVNULL

def _coerce_argv(args, shell=False):
    if shell:
        if isinstance(args, (list, tuple)):
            args = ' '.join(str(a) for a in args)
        return ['sh', '-c', str(args)]
    if isinstance(args, str):
        return args.split()
    return [str(a) for a in args]

def _invoke_js_exec(args, cwd=None, shell=False, timeout=None):
    argv = _coerce_argv(args, shell)
    timeout_ms = int(timeout * 1000) if timeout else 60_000
    raw = _js_exec_sync(json.dumps(argv), str(cwd or ''), timeout_ms)
    return json.loads(raw)

class _BridgedCompletedProcess:
    def __init__(self, args, returncode, stdout, stderr):
        self.args = args
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

def _bridged_run(args, **kwargs):
    result = _invoke_js_exec(
        args, cwd=kwargs.get('cwd'), shell=kwargs.get('shell', False),
        timeout=kwargs.get('timeout'),
    )
    rc = result.get('exit_code') if result.get('exit_code') is not None else -1
    stdout = result.get('stdout', '') or ''
    stderr = result.get('stderr', '') or ''
    want_text = kwargs.get('text', False) or kwargs.get('universal_newlines', False)
    capture = kwargs.get('capture_output', False)
    so = (stdout if want_text else stdout.encode('utf-8')) if (capture or kwargs.get('stdout') == _PIPE) else None
    se = (stderr if want_text else stderr.encode('utf-8')) if (capture or kwargs.get('stderr') == _PIPE) else None
    cp = _BridgedCompletedProcess(args, rc, so, se)
    if kwargs.get('check') and rc != 0:
        raise _sp.CalledProcessError(rc, args, output=so, stderr=se)
    return cp

def _bridged_check_output(args, **kwargs):
    kwargs['capture_output'] = True
    kwargs['check'] = True
    return _bridged_run(args, **kwargs).stdout

_sp.run = _bridged_run
_sp.check_output = _bridged_check_output

class _BridgedPopen:
    """Synchronous shim for subprocess.Popen.

    Runs the command immediately in __init__ via the JS bridge and caches
    the result. communicate(), wait(), and poll() return the cached output.
    This is NOT a true async process — it's a synchronous execution that
    mimics the Popen API for callers that use communicate() immediately.
    """

    def __init__(self, args, **kwargs):
        self.args = args
        self._kwargs = kwargs
        self._text = kwargs.get('text', False) or kwargs.get('universal_newlines', False)
        shell = kwargs.get('shell', False)
        cwd = kwargs.get('cwd')
        timeout = kwargs.get('timeout')
        # Execute right now
        result = _invoke_js_exec(args, cwd=cwd, shell=shell, timeout=timeout)
        rc = result.get('exit_code') if result.get('exit_code') is not None else -1
        stdout_str = result.get('stdout', '') or ''
        stderr_str = result.get('stderr', '') or ''
        self.returncode = rc
        self.pid = 0
        if self._text:
            self._stdout_buf = stdout_str
            self._stderr_buf = stderr_str
        else:
            self._stdout_buf = stdout_str.encode('utf-8')
            self._stderr_buf = stderr_str.encode('utf-8')
        self.stdout = None
        self.stderr = None
        self.stdin = None

    def communicate(self, input=None, timeout=None):
        return (self._stdout_buf, self._stderr_buf)

    def wait(self, timeout=None):
        return self.returncode

    def poll(self):
        return self.returncode

    def kill(self):
        pass

    def terminate(self):
        pass

    def send_signal(self, sig):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

_sp.Popen = _BridgedPopen

# Stub os.killpg / os.getpgid — the BashTool uses these in timeout cleanup
# but our _BridgedPopen never actually spawns a process, so these should
# be no-ops (and the caller already handles ProcessLookupError).
def _noop_getpgid(pid):
    return 0
def _noop_killpg(pgid, sig):
    pass
_os.getpgid = _noop_getpgid
_os.killpg = _noop_killpg

# --- Load vibe_coder.py ----------------------------------------------------
import importlib.util
spec = importlib.util.spec_from_file_location('vibe_coder', '/vibe_coder.py')
_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(_mod)

# --- Patch OllamaClient adapter for OpenAI-format backends -----------------
_orig_adapter = _mod.OllamaClient._native_to_openai_response
def _smart_adapter(data):
    # If backend returned OpenAI format, pass through unchanged
    if isinstance(data, dict) and 'choices' in data:
        return data
    return _orig_adapter(data)
_mod.OllamaClient._native_to_openai_response = staticmethod(_smart_adapter)

# --- Patch message preparation to preserve OpenAI tool_call shape ----------
# vibe-coder.py's _prepare_messages_for_native drops the "type": "function"
# field from tool_calls, which llama.cpp's /api/chat endpoint rejects with
# "Missing tool call type". We reinstate it after the original prep runs.
_orig_prepare = _mod.OllamaClient._prepare_messages_for_native
def _patched_prepare(messages):
    prepared = _orig_prepare(messages)
    for msg in prepared:
        tool_calls = msg.get('tool_calls')
        if tool_calls:
            for tc in tool_calls:
                if isinstance(tc, dict) and 'type' not in tc:
                    tc['type'] = 'function'
    return prepared
_mod.OllamaClient._prepare_messages_for_native = staticmethod(_patched_prepare)

# --- ToolRegistry bridge ---------------------------------------------------
# Replace each registered tool's execute() method with a JS dispatcher.
# This is the core of Option C: vibe-coder.py's Agent loop runs as usual,
# but every tool call round-trips to JS for the actual work.
import types as _types

def _make_bridge_execute(tool_name):
    def _bridge_execute(self, params):
        # Params may be a JsProxy from the LLM; convert to a plain dict
        if hasattr(params, 'to_py'):
            params = params.to_py()
        elif not isinstance(params, dict):
            params = dict(params) if params else {}
        raw = _js_tool_dispatch(tool_name, json.dumps(params, default=str))
        try:
            result = json.loads(raw)
        except Exception:
            return f"Error: invalid dispatch result: {raw[:200]}"
        if result.get('ok'):
            out = result.get('output', '')
            if not isinstance(out, str):
                out = json.dumps(out)
            return out
        return f"Error ({tool_name}): {result.get('error', 'unknown error')}"
    return _bridge_execute

def _register_bridge_only_tools(registry):
    """Register tools that need constructor dependencies but are JS-bridged here."""
    try:
        if registry.get("SubAgent") is None:
            registry.register(_mod.SubAgentTool(_mod.Config(), None, registry, None))
    except Exception:
        pass
    try:
        if registry.get("ParallelAgents") is None:
            coordinator = _mod.MultiAgentCoordinator(_mod.Config(), None, registry, None)
            registry.register(_mod.ParallelAgentTool(coordinator))
    except Exception:
        pass
    return registry

def install_tool_bridge(registry):
    """Replace every tool.execute in this registry with a JS-bridged version."""
    _register_bridge_only_tools(registry)
    for name, tool_instance in list(registry._tools.items()):
        bridged = _make_bridge_execute(name)
        tool_instance.execute = _types.MethodType(bridged, tool_instance)
    return registry

# Expose module + helpers to subsequent runPython calls
import builtins
builtins.vibe_coder = _mod
builtins.install_tool_bridge = install_tool_bridge
builtins._vlw_bridge_ready = True
`);
    return py;
  })();
  return pyPromise;
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

export type PyodideChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type PyodideChatInput = {
  baseUrl: string;
  model: string;
  messages: PyodideChatMessage[];
  maxTokens?: number;
  temperature?: number;
};

export type PyodideChatResult = {
  ok: boolean;
  content: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
  };
  error?: string;
};

/**
 * Call vibe-coder.py's OllamaClient.chat() via Pyodide.
 * This is a single-turn LLM call — no tool execution loop.
 */
export async function pyodideChat(input: PyodideChatInput): Promise<PyodideChatResult> {
  const py = (await initPyodide()) as {
    globals: { set: (name: string, value: unknown) => void };
    runPython: (code: string) => unknown;
  };
  py.globals.set(
    "_chat_input",
    JSON.stringify({
      baseUrl: input.baseUrl,
      model: input.model,
      messages: input.messages,
      max_tokens: input.maxTokens ?? 2048,
      temperature: input.temperature ?? 0.2,
    }),
  );
  const resultJson = py.runPython(`
import json, builtins
mod = builtins.vibe_coder
inp = json.loads(_chat_input)

cfg = mod.Config()
cfg.ollama_host = inp['baseUrl']
cfg.model = inp['model']
cfg.sidecar_model = inp['model']
cfg.debug = False
if hasattr(cfg, 'max_tokens'):
    cfg.max_tokens = int(inp['max_tokens'])
if hasattr(cfg, 'temperature'):
    cfg.temperature = float(inp['temperature'])

try:
    client = mod.OllamaClient(cfg)
    result = client.chat(
        model=inp['model'],
        messages=inp['messages'],
        stream=False,
    )
    content = result.get('choices', [{}])[0].get('message', {}).get('content', '')
    usage = result.get('usage', {})
    _out = {'ok': True, 'content': content, 'usage': usage}
except Exception as e:
    import traceback
    _out = {
        'ok': False,
        'content': '',
        'error': f'{type(e).__name__}: {e}',
        'traceback': traceback.format_exc(),
    }
json.dumps(_out)
`) as string;
  return JSON.parse(resultJson) as PyodideChatResult;
}

/** Returns true if the runtime has been initialized (or pre-warmed). */
export function isPyodideReady(): boolean {
  return pyPromise !== null;
}

/** Kick off Pyodide loading in the background without awaiting. */
export function prewarmPyodide(): void {
  void initPyodide();
}

// ----------------------------------------------------------------------------
// Tool execution via vibe-coder.py's own tool classes.
// This exists primarily for testing/debugging — the real integration path
// uses ToolRegistry with a JS dispatch bridge (see runPyodideAgentTurn).
// ----------------------------------------------------------------------------

export type PyodideToolCallResult = {
  ok: boolean;
  output: string;
  error?: string;
};

export type PyodideToolBridgeContext = RuntimeAgentContext;

/**
 * Execute one of vibe-coder.py's built-in Tool subclasses (Bash, Read, Write,
 * Glob, Grep, etc.) directly inside Pyodide via its native Python execute().
 * Used to verify that the subprocess/file bridge is working end-to-end.
 */
export async function pyodideToolCall(
  toolClassName: string,
  params: Record<string, unknown>,
): Promise<PyodideToolCallResult> {
  const py = (await initPyodide()) as {
    globals: { set: (name: string, value: unknown) => void };
    runPython: (code: string) => unknown;
  };
  py.globals.set(
    "_tool_call_input",
    JSON.stringify({ className: toolClassName, params }),
  );
  const resultJson = py.runPython(`
import json, builtins, traceback
mod = builtins.vibe_coder
inp = json.loads(_tool_call_input)
try:
    cls = getattr(mod, inp['className'])
    instance = cls()
    output = instance.execute(inp['params'])
    if not isinstance(output, str):
        output = str(output)
    _res = {'ok': True, 'output': output}
except Exception as e:
    _res = {'ok': False, 'output': '', 'error': f'{type(e).__name__}: {e}', 'traceback': traceback.format_exc()}
json.dumps(_res)
`) as string;
  return JSON.parse(resultJson) as PyodideToolCallResult;
}

export type PyodideAgentTurnInput = {
  baseUrl: string;
  model: string;
  messages: PyodideChatMessage[];
  maxTokens?: number;
  temperature?: number;
  maxIterations?: number;
  /** Restrict tool registry to these names. Undefined → all defaults. */
  allowedTools?: string[];
};

export type PyodideToolEvent = {
  name: string;
  args: Record<string, unknown>;
  output: string;
};

export type PyodideAgentTurnResult = {
  ok: boolean;
  content: string;
  iterations: number;
  toolEvents: PyodideToolEvent[];
  error?: string;
};

/**
 * Run a full tool-enabled agent turn through vibe-coder.py's OllamaClient
 * and ToolRegistry. The ToolRegistry is bridged to JS so every tool.execute
 * call round-trips through _js_tool_dispatch (Option C).
 *
 * This is a simplified loop — it does NOT use vibe-coder.py's full Agent
 * class (which includes plan mode, RAG, checkpoints, etc.). Instead it
 * reuses the core pieces: OllamaClient for LLM, ToolRegistry for tools,
 * and implements the loop in Python via runPython.
 */
export async function pyodideRunAgentTurn(
  input: PyodideAgentTurnInput,
): Promise<PyodideAgentTurnResult> {
  const py = (await initPyodide()) as {
    globals: { set: (name: string, value: unknown) => void };
    runPython: (code: string) => unknown;
  };
  py.globals.set(
    "_agent_turn_input",
    JSON.stringify({
      baseUrl: input.baseUrl,
      model: input.model,
      messages: input.messages,
      max_tokens: input.maxTokens ?? 2048,
      temperature: input.temperature ?? 0.2,
      max_iterations: input.maxIterations ?? 8,
      allowed_tools: input.allowedTools ?? null,
    }),
  );
  currentAgentContext = {
    baseUrl: input.baseUrl,
    model: input.model,
    maxTokens: input.maxTokens ?? 2048,
    temperature: input.temperature ?? 0.2,
  };
  try {
    const resultJson = py.runPython(`
import json, builtins, traceback
mod = builtins.vibe_coder
install = builtins.install_tool_bridge
inp = json.loads(_agent_turn_input)

try:
    # Build config + client
    cfg = mod.Config()
    cfg.ollama_host = inp['baseUrl']
    cfg.model = inp['model']
    cfg.sidecar_model = inp['model']
    cfg.debug = False
    if hasattr(cfg, 'max_tokens'):
        cfg.max_tokens = int(inp['max_tokens'])
    if hasattr(cfg, 'temperature'):
        cfg.temperature = float(inp['temperature'])

    # Fresh bridged registry per turn
    registry = mod.ToolRegistry().register_defaults()
    install(registry)
    all_schemas = registry.get_schemas()
    allowed = inp.get('allowed_tools')
    if allowed is None:
        tools_schema = all_schemas
    else:
        allowed_set = set(allowed)
        tools_schema = [s for s in all_schemas if s['function']['name'] in allowed_set]

    client = mod.OllamaClient(cfg)
    current = list(inp['messages'])
    tool_events = []
    max_iter = int(inp.get('max_iterations', 8))

    final_content = ''
    iterations = 0
    for i in range(max_iter):
        iterations = i + 1
        resp = client.chat(
            model=inp['model'],
            messages=current,
            tools=tools_schema if tools_schema else None,
            stream=False,
        )
        msg = resp.get('choices', [{}])[0].get('message', {}) or {}
        tool_calls = msg.get('tool_calls') or []

        if not tool_calls:
            final_content = msg.get('content', '') or ''
            break

        # Record the assistant message so the LLM can reference tool_calls
        current.append({
            'role': 'assistant',
            'content': msg.get('content', '') or '',
            'tool_calls': tool_calls,
        })

        # Execute each tool via the bridged registry
        for tc in tool_calls:
            fn = tc.get('function', {}) or {}
            name = fn.get('name', '')
            raw_args = fn.get('arguments', '{}') or '{}'
            try:
                args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
            except Exception:
                args = {'_raw': raw_args}
            tool = registry.get(name)
            if tool is None:
                output = f"Error: no tool named '{name}'"
            else:
                try:
                    output = tool.execute(args)
                    if not isinstance(output, str):
                        output = str(output)
                except Exception as e:
                    output = f'Error: {type(e).__name__}: {e}'
            tool_events.append({
                'name': name,
                'args': args,
                'output': output[:1000] if len(output) > 1000 else output,
            })
            current.append({
                'role': 'tool',
                'tool_call_id': tc.get('id', f'call_{len(tool_events)}'),
                'name': name,
                'content': output,
            })
    else:
        final_content = '(max iterations reached)'

    _res = {
        'ok': True,
        'content': final_content,
        'iterations': iterations,
        'toolEvents': tool_events,
    }
except Exception as e:
    _res = {
        'ok': False,
        'content': '',
        'iterations': 0,
        'toolEvents': [],
        'error': f'{type(e).__name__}: {e}',
        'traceback': traceback.format_exc(),
    }
json.dumps(_res, default=str)
`) as string;
    return JSON.parse(resultJson) as PyodideAgentTurnResult;
  } finally {
    currentAgentContext = null;
  }
}

/**
 * Execute a tool through vibe-coder.py's ToolRegistry AFTER installing the
 * JS bridge. This is the "Option C" path — the Python tool instance's
 * execute() method is replaced at runtime with a call to _js_tool_dispatch,
 * which lets JS decide how to handle every tool the Agent invokes.
 *
 * Used to validate the bridge end-to-end before wiring Agent.run() in.
 */
export async function pyodideToolCallViaBridge(
  toolName: string,
  params: Record<string, unknown>,
): Promise<PyodideToolCallResult> {
  const py = (await initPyodide()) as {
    globals: { set: (name: string, value: unknown) => void };
    runPython: (code: string) => unknown;
  };
  py.globals.set(
    "_bridge_tool_input",
    JSON.stringify({ name: toolName, params }),
  );
  const resultJson = py.runPython(`
import json, builtins, traceback
mod = builtins.vibe_coder
install = builtins.install_tool_bridge
inp = json.loads(_bridge_tool_input)
try:
    # Build a fresh registry with defaults, then install the bridge
    registry = mod.ToolRegistry().register_defaults()
    install(registry)
    tool = registry.get(inp['name'])
    if tool is None:
        _res = {'ok': False, 'output': '', 'error': f"No tool named '{inp['name']}'"}
    else:
        output = tool.execute(inp['params'])
        _res = {'ok': True, 'output': output if isinstance(output, str) else str(output)}
except Exception as e:
    _res = {'ok': False, 'output': '', 'error': f'{type(e).__name__}: {e}', 'traceback': traceback.format_exc()}
json.dumps(_res)
`) as string;
  return JSON.parse(resultJson) as PyodideToolCallResult;
}

export async function pyodideToolCallViaBridgeWithContext(
  toolName: string,
  params: Record<string, unknown>,
  context: PyodideToolBridgeContext,
): Promise<PyodideToolCallResult> {
  currentAgentContext = context;
  try {
    return await pyodideToolCallViaBridge(toolName, params);
  } finally {
    currentAgentContext = null;
  }
}
