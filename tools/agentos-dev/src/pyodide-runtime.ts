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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VIBE_CODER_PATH = path.resolve(__dirname, "pyodide-core/vibe-coder.py");

let pyPromise: Promise<unknown> | null = null;

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
      const [cmd, ...cmdArgs] = argv;
      try {
        const stdout = execFileSync(cmd, cmdArgs, {
          cwd: cwd || undefined,
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          timeout: timeoutMs > 0 ? timeoutMs : 60_000,
        });
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
# Monkey-patch subprocess.run / subprocess.check_output / Popen to route
# through the JS bridge. vibe-coder.py heavily uses subprocess for Bash,
# Git, ripgrep, etc.
import subprocess as _sp

class _BridgedCompletedProcess:
    def __init__(self, args, returncode, stdout, stderr):
        self.args = args
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

def _coerce_argv(args, shell=False):
    if shell:
        # shell=True passes a single string; wrap with sh -c
        if isinstance(args, (list, tuple)):
            args = ' '.join(str(a) for a in args)
        return ['sh', '-c', str(args)]
    if isinstance(args, str):
        # subprocess.run('ls -la', shell=False) is unusual but handle it
        return args.split()
    return [str(a) for a in args]

def _bridged_run(args, **kwargs):
    argv = _coerce_argv(args, kwargs.get('shell', False))
    cwd = kwargs.get('cwd') or ''
    timeout = kwargs.get('timeout')
    timeout_ms = int(timeout * 1000) if timeout else 60_000
    result_json = _js_exec_sync(json.dumps(argv), str(cwd), timeout_ms)
    result = json.loads(result_json)
    check = kwargs.get('check', False)
    capture = kwargs.get('capture_output', False)
    want_text = kwargs.get('text', False) or kwargs.get('universal_newlines', False)
    rc = result.get('exit_code')
    if rc is None:
        rc = -1
    stdout = result.get('stdout', '') or ''
    stderr = result.get('stderr', '') or ''
    if not (capture or kwargs.get('stdout') == _sp.PIPE):
        stdout_out = None
    else:
        stdout_out = stdout if want_text else stdout.encode('utf-8')
    if not (capture or kwargs.get('stderr') == _sp.PIPE):
        stderr_out = None
    else:
        stderr_out = stderr if want_text else stderr.encode('utf-8')
    cp = _BridgedCompletedProcess(args, rc, stdout_out, stderr_out)
    if check and rc != 0:
        err = _sp.CalledProcessError(rc, args, output=stdout_out, stderr=stderr_out)
        raise err
    return cp

def _bridged_check_output(args, **kwargs):
    kwargs['capture_output'] = True
    kwargs['check'] = True
    cp = _bridged_run(args, **kwargs)
    return cp.stdout

_sp.run = _bridged_run
_sp.check_output = _bridged_check_output

# Note: Popen is not patched. vibe-coder.py uses it for long-running
# processes (MCP servers, sandbox agents). Those features are skipped
# for this initial Pyodide integration.

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

# Expose module to subsequent runPython calls
import builtins
builtins.vibe_coder = _mod
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
