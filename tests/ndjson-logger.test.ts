import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { NdjsonLogger } from '../src/core/logging/ndjson-writer.ts';

test('NdjsonLogger writes events + redacts secrets', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-log-'));
  const logger = new NdjsonLogger({ runId: 'r1', logsDir: tmpDir });
  logger.log('pipeline.start', { topic: 'x' });
  logger.log('adapter.call', { apiKey: 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  await logger.close();

  const contents = await fs.readFile(path.join(tmpDir, 'r1.ndjson'), 'utf8');
  const lines = contents.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).event, 'pipeline.start');
  assert.ok(!contents.includes('sk-aaa'));

  await fs.rm(tmpDir, { recursive: true, force: true });
});
