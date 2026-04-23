// src/core/schema-alignment/llm-check.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReviewEngine } from '../../adapters/review-engine/types.ts';
import type { SchemaEntity, LayerScanResult, AlignmentFinding } from './types.ts';

const TOTAL_CHAR_BUDGET = 6000;

function truncateTop(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const dropped = text.length - maxChars;
  return `<!-- [schema-alignment: truncated ${dropped} chars] -->\n` + text.slice(dropped);
}

export async function runLlmCheck(
  migrationFiles: string[],
  gapResults: LayerScanResult[],
  engine: ReviewEngine,
): Promise<AlignmentFinding[]> {
  let budget = TOTAL_CHAR_BUDGET;
  const migrationSnippets: string[] = [];

  for (const f of migrationFiles) {
    if (budget <= 0) break;
    let content: string;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const snippet = truncateTop(content, Math.floor(budget * 0.6));
    migrationSnippets.push(`### Migration: ${path.basename(f)}\n\`\`\`sql\n${snippet}\n\`\`\``);
    budget -= snippet.length;
  }

  const entitySummary = gapResults.map(r => {
    const isDestructive = r.entity.operation === 'drop_column' || r.entity.operation === 'rename_column';
    const gaps = isDestructive
      ? [r.typeLayer, r.apiLayer, r.uiLayer]
          .map((e, i) => e !== null ? (['type', 'api', 'ui'][i]) : null)
          .filter(Boolean).join(', ')
      : [r.typeLayer === null ? 'type' : null, r.apiLayer === null ? 'api' : null, r.uiLayer === null ? 'ui' : null]
          .filter(Boolean).join(', ');
    return `- ${r.entity.operation} ${r.entity.table}${r.entity.column ? '.' + r.entity.column : ''}: ${isDestructive ? 'stale ref in' : 'missing in'} [${gaps}]`;
  }).join('\n');

  const prompt = [
    'You are reviewing schema-layer alignment for a software project.',
    '',
    migrationSnippets.length > 0
      ? `The following migration files were changed:\n\n${migrationSnippets.join('\n\n')}`
      : '(no readable migration files)',
    '',
    `The structural scan found these potential alignment gaps:\n${entitySummary || '(none)'}`,
    '',
    'For each gap, determine if it is a real problem. Return findings as a JSON array:',
    '[{ "table": "name", "column": "name_or_null", "operation": "add_column", "layer": "type", "file": "path/to/relevant/file.ts (optional)", "message": "explanation", "severity": "warning", "confidence": "high" }]',
    'Return only valid JSON, no prose.',
  ].join('\n');

  let rawOutput: string;
  try {
    const result = await engine.review({ content: prompt, kind: 'file-batch' });
    rawOutput = result.rawOutput;
  } catch {
    return [];
  }

  const jsonMatch = rawOutput.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      table: string; column?: string; operation: string;
      layer: string; message: string; severity: string; confidence: string;
      file?: string;
    }>;
    return parsed
      .filter(item => item.table && item.layer && item.message)
      .map(item => ({
        entity: {
          table: item.table,
          column: item.column,
          operation: item.operation as SchemaEntity['operation'],
        },
        layer: item.layer as AlignmentFinding['layer'],
        message: item.message,
        file: item.file,
        severity: (item.severity === 'error' ? 'error' : 'warning') as AlignmentFinding['severity'],
        confidence: (['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'medium') as AlignmentFinding['confidence'],
      }));
  } catch {
    return [];
  }
}
