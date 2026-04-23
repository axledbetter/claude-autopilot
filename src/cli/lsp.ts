import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Finding } from '../core/findings/types.ts';

// LSP DiagnosticSeverity values (spec §3.16.1)
const DSev = { Error: 1, Warning: 2, Information: 3 } as const;

export function findingToUri(filePath: string, cwd: string): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  // file:// with three slashes on Unix, four on Windows (file:///C:/...)
  return `file://${abs.startsWith('/') ? '' : '/'}${abs}`;
}

export function findingToDiagnostic(f: Finding): {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity: number;
  source: string;
  code: string;
  message: string;
} {
  const line = Math.max(0, (f.line ?? 1) - 1); // LSP is 0-indexed; findings are 1-indexed
  return {
    range: { start: { line, character: 0 }, end: { line, character: 999 } },
    severity: f.severity === 'critical' ? DSev.Error : f.severity === 'warning' ? DSev.Warning : DSev.Information,
    source: 'guardrail',
    code: f.id,
    message: f.suggestion ? `${f.message}\n\n${f.suggestion}` : f.message,
  };
}

export function groupByUri(findings: Finding[], cwd: string): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    const uri = findingToUri(f.file, cwd);
    const arr = map.get(uri) ?? [];
    arr.push(f);
    map.set(uri, arr);
  }
  return map;
}

export function encodeMessage(body: object): Buffer {
  const json = JSON.stringify(body);
  const byteLen = Buffer.byteLength(json, 'utf8');
  return Buffer.from(`Content-Length: ${byteLen}\r\n\r\n${json}`, 'utf8');
}

/** Parse as many complete LSP messages as possible from `buf`. Returns parsed objects and remaining bytes. */
export function parseMessages(buf: Buffer): { messages: unknown[]; remaining: Buffer } {
  const messages: unknown[] = [];
  let remaining = buf;

  while (remaining.length > 0) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;

    const headers = remaining.slice(0, headerEnd).toString('utf8');
    const match = headers.match(/Content-Length:\s*(\d+)/i);
    if (!match) { remaining = remaining.slice(headerEnd + 4); continue; }

    const contentLength = parseInt(match[1]!, 10);
    const bodyStart = headerEnd + 4;
    if (remaining.length < bodyStart + contentLength) break;

    const body = remaining.slice(bodyStart, bodyStart + contentLength).toString('utf8');
    remaining = remaining.slice(bodyStart + contentLength);

    try { messages.push(JSON.parse(body)); } catch { /* skip malformed */ }
  }

  return { messages, remaining };
}

export async function runLsp(options: { cwd?: string } = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const cacheFile = path.join(cwd, '.guardrail-cache', 'findings.json');

  let initialized = false;
  let didShutdown = false;

  function send(msg: object): void {
    process.stdout.write(encodeMessage(msg));
  }

  function notify(method: string, params: object): void {
    send({ jsonrpc: '2.0', method, params });
  }

  function respond(id: number | string | null, result: unknown): void {
    send({ jsonrpc: '2.0', id, result });
  }

  function respondError(id: number | string | null, code: number, message: string): void {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  function readFindings(): Finding[] {
    if (!fs.existsSync(cacheFile)) return [];
    try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Finding[]; }
    catch { return []; }
  }

  function publishAll(findings: Finding[]): void {
    const byUri = groupByUri(findings, cwd);
    for (const [uri, ff] of byUri) {
      notify('textDocument/publishDiagnostics', {
        uri,
        diagnostics: ff.map(findingToDiagnostic),
      });
    }
  }

  function publishForUri(uri: string, findings: Finding[]): void {
    notify('textDocument/publishDiagnostics', {
      uri,
      diagnostics: findings.filter(f => findingToUri(f.file, cwd) === uri).map(findingToDiagnostic),
    });
  }

  // Watch cache dir so editors see diagnostics update after a guardrail run
  let watcher: fs.FSWatcher | null = null;

  function startWatching(): void {
    const dir = path.dirname(cacheFile);
    if (!fs.existsSync(dir)) return;
    try {
      watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        if (filename === 'findings.json' && initialized) publishAll(readFindings());
      });
    } catch { /* watch unavailable */ }
  }

  type LspMessage = { jsonrpc: string; id?: number | string; method?: string; params?: unknown };

  function handle(msg: LspMessage): void {
    const { id, method, params } = msg;
    if (!method) return; // response, ignore

    switch (method) {
      case 'initialize':
        respond(id!, {
          capabilities: {
            textDocumentSync: { openClose: true, change: 1 /* full */ },
          },
          serverInfo: { name: 'guardrail', version: '4.1.0' },
        });
        break;

      case 'initialized':
        initialized = true;
        startWatching();
        publishAll(readFindings());
        break;

      case 'textDocument/didOpen':
      case 'textDocument/didChange': {
        const p = params as { textDocument?: { uri?: string } } | undefined;
        const uri = p?.textDocument?.uri;
        if (uri) publishForUri(uri, readFindings());
        break;
      }

      case 'textDocument/didClose':
        // Keep diagnostics visible after close
        break;

      case 'shutdown':
        didShutdown = true;
        watcher?.close();
        respond(id!, null);
        break;

      case 'exit':
        process.exit(didShutdown ? 0 : 1);
        break;

      case '$/cancelRequest':
        break;

      default:
        if (id !== undefined) respondError(id, -32601, `Method not found: ${method}`);
    }
  }

  // Frame-aware stdin reader
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const { messages, remaining } = parseMessages(buf);
    buf = remaining;
    for (const msg of messages) handle(msg as LspMessage);
  });

  process.stdin.on('end', () => {
    watcher?.close();
    process.exit(0);
  });

  return new Promise<void>(() => { /* event-loop keeps us alive */ });
}
