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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VIBE_CODER_PATH = path.resolve(__dirname, "pyodide-core/vibe-coder.py");
const EXECUTION_ROOT = path.resolve(process.cwd());
const TMP_ROOT = path.resolve(tmpdir());
const SANDBOX_HOME = path.join(TMP_ROOT, "vibe-local-wasm-home");
const SANDBOX_CONFIG_HOME = path.join(SANDBOX_HOME, ".config");
const SANDBOX_CACHE_HOME = path.join(SANDBOX_HOME, ".cache");
const SANDBOX_DATA_HOME = path.join(SANDBOX_HOME, ".local", "share");
const SYSTEM_EXEC_DIRS = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/libexec",
  "/usr/local/bin",
  "/opt/homebrew/bin",
];
const BLOCKED_EXECUTABLES = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "fish",
  "python",
  "python3",
  "node",
  "nodejs",
  "ruby",
  "perl",
  "php",
  "lua",
  "osascript",
]);
const PATH_VALUE_FLAGS = new Set(["-C", "--git-dir", "--work-tree", "--file", "--output", "--input"]);

mkdirSync(SANDBOX_HOME, { recursive: true });
mkdirSync(SANDBOX_CONFIG_HOME, { recursive: true });
mkdirSync(SANDBOX_CACHE_HOME, { recursive: true });
mkdirSync(SANDBOX_DATA_HOME, { recursive: true });

function isPathInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isAllowedAccessPath(candidate: string) {
  return isPathInside(EXECUTION_ROOT, candidate) || isPathInside(TMP_ROOT, candidate);
}

function resolveAccessPath(raw: string, baseDir = EXECUTION_ROOT) {
  if (!raw) throw new Error("Empty path");
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(baseDir, raw);
  if (!isAllowedAccessPath(absolute)) {
    throw new Error(`Path outside execution root is not allowed: ${raw}`);
  }
  return absolute;
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
  return SYSTEM_EXEC_DIRS.some((root) => isPathInside(root, candidate));
}

function resolveExecutable(command: string, cwd: string) {
  const executableName = path.basename(command);
  if (BLOCKED_EXECUTABLES.has(executableName)) {
    throw new Error(`Executable '${executableName}' is blocked by the access policy`);
  }
  if (!command.includes("/") && !path.isAbsolute(command)) {
    return command;
  }
  const absolute = path.isAbsolute(command) ? path.resolve(command) : path.resolve(cwd, command);
  if (!isAllowedAccessPath(absolute) && !isSystemExecutablePath(absolute)) {
    throw new Error(`Executable outside execution root is not allowed: ${command}`);
  }
  return absolute;
}

function looksLikeUrl(value: string) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

function validatePathLikeArg(value: string, cwd: string) {
  if (!value || value === "-" || looksLikeUrl(value)) {
    return;
  }
  if (
    path.isAbsolute(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.includes("/")
  ) {
    resolveAccessPath(value, cwd);
  }
}

function validateCommandArgs(args: string[], cwd: string) {
  let expectPathValue = false;
  for (const arg of args) {
    if (expectPathValue) {
      validatePathLikeArg(arg, cwd);
      expectPathValue = false;
      continue;
    }
    if (PATH_VALUE_FLAGS.has(arg)) {
      expectPathValue = true;
      continue;
    }
    if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      validatePathLikeArg(arg.split("=", 2)[1] ?? "", cwd);
      continue;
    }
    validatePathLikeArg(arg, cwd);
  }
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
              const out = execFileSync(
                "curl",
                ["-s", "-L", "--max-time", "30", "-A", "vibe-local-wasm/1.0", url],
                { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 35_000 },
              );
              // Strip HTML tags crudely for agent readability
              const text = out
                .replace(/<script[\s\S]*?<\/script>/gi, "")
                .replace(/<style[\s\S]*?<\/style>/gi, "")
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 5000);
              return JSON.stringify({ ok: true, output: text || "(empty)" });
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

def install_tool_bridge(registry):
    """Replace every tool.execute in this registry with a JS-bridged version."""
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
