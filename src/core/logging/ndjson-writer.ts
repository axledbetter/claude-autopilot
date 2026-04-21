import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyRedaction, DEFAULT_REDACTION_PATTERNS } from './redaction.ts';

export interface NdjsonLoggerOptions {
  runId: string;
  logsDir?: string;
  redactionPatterns?: readonly string[];
}

export class NdjsonLogger {
  private readonly runId: string;
  private readonly filePath: string;
  private readonly stream: fs.WriteStream;
  private readonly redactionPatterns: readonly string[];

  constructor(options: NdjsonLoggerOptions) {
    this.runId = options.runId;
    this.redactionPatterns = options.redactionPatterns ?? DEFAULT_REDACTION_PATTERNS;
    const logsDir = options.logsDir ?? path.join('.claude', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    this.filePath = path.join(logsDir, `${this.runId}.ndjson`);
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
  }

  log(event: string, fields: Record<string, unknown> = {}): void {
    const entry = { ts: new Date().toISOString(), runId: this.runId, event, ...fields };
    const serialized = applyRedaction(JSON.stringify(entry), this.redactionPatterns);
    this.stream.write(serialized + '\n');
  }

  close(): Promise<void> {
    return new Promise(resolve => this.stream.end(() => resolve()));
  }

  getFilePath(): string { return this.filePath; }
}
