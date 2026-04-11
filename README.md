# vibe-local-wasm

`vibe-local-wasm` is a standalone `vibe-local + agentOS` coding agent stack for browser and CLI use.

It gives you:

- a browser UI backed by `agentOS + SQLite`
- the same actor-backed CLI/TUI entrypoint
- `Plan / Act / approve / YOLO`
- sub-agents and parallel agents

## Quick start

```bash
pnpm install
pnpm run dev
```

Then open `http://localhost:5374/`.

## Standalone command

After cloning this repo, install the command locally on your machine:

```bash
pnpm link --global
```

Then you can use:

```bash
vibe-local-wasm dev
vibe-local-wasm health
vibe-local-wasm projects
vibe-local-wasm chat vibe-local-pyodide --mode act
```

## Repo layout

- `vibe-local-pyodide/`: the React + Pyodide web client
- `tools/agentos-dev/`: the actor runtime, CLI, and sandbox wiring

## License

MIT
