# Worker Daemon Design

## Goal

`guardrail worker` starts a persistent local HTTP daemon that accepts LLM review jobs. Multiple terminals (or CI matrix jobs) dispatch chunks to it concurrently, enabling large codebases to be reviewed in parallel across N processes without each spinning up its own LLM connection.

## Design

### Commands

```bash
guardrail worker start          # start daemon in background, print port
guardrail worker stop           # kill daemon (reads port from lockfile)
guardrail worker status         # print pid, port, queue depth, jobs processed
guardrail run --use-worker      # dispatch review chunks to running worker
```

### Daemon

- Starts an HTTP server on a random available port (localhost only)
- Writes `.guardrail-cache/worker.lock` JSON: `{ pid, port, startedAt }`
- Accepts `POST /review` with JSON body `{ files: string[], config: GuardrailConfig }`
- Returns `{ findings: Finding[], usage?: { costUSD: number } }`
- Accepts `GET /status` → `{ pid, port, jobsProcessed, queueDepth, uptimeMs }`
- Accepts `POST /stop` → graceful shutdown
- Runs review using the same `runReviewPhase` pipeline as normal mode
- Worker is stateless per-request — no shared review state

### Client integration

`runCommand` checks for `.guardrail-cache/worker.lock`, verifies the PID is alive, and if `--use-worker` is set, POSTs each chunk to the worker instead of running inline. Falls back to inline if worker is unreachable.

### Lockfile lifecycle

- On start: write lockfile, register SIGTERM/SIGINT handler to delete it
- On stop: send `POST /stop`, wait up to 3s, then SIGTERM the PID
- On status: read lockfile, verify PID alive with `kill -0`

## Architecture

- `src/cli/worker.ts` — `runWorker(sub)` handles start/stop/status subcommands
- `src/core/worker/server.ts` — `startWorkerServer(config)` → HTTP server + lockfile management
- `src/core/worker/client.ts` — `dispatchToWorker(lockfilePath, files, config)` → fetch POST /review
- `src/core/worker/lockfile.ts` — read/write/check `.guardrail-cache/worker.lock`
- `src/cli/index.ts` — add `worker` subcommand
- `tests/worker.test.ts` — unit tests for lockfile + client/server protocol

## Out of Scope

- Authentication (localhost only, no token)
- Persistent job queue / retry (stateless per request)
- Cross-machine distribution
- Worker pool management (user manages N workers manually)
