// src/cli/mcp.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../core/config/loader.ts';
import { loadAdapter } from '../adapters/loader.ts';
import type { ReviewEngine } from '../adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../core/config/types.ts';
import { handleReviewDiff } from '../core/mcp/handlers/review-diff.ts';
import { handleScanFiles } from '../core/mcp/handlers/scan-files.ts';
import { handleGetFindings } from '../core/mcp/handlers/get-findings.ts';
import { handleFixFinding } from '../core/mcp/handlers/fix-finding.ts';
import { handleValidateFix } from '../core/mcp/handlers/validate-fix.ts';
import { handleGetCapabilities } from '../core/mcp/handlers/get-capabilities.ts';

export async function runMcp(options: { cwd?: string; configPath?: string } = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let config: GuardrailConfig = { configVersion: 1 };
  if (fs.existsSync(configPath)) {
    const loaded = await loadConfig(configPath);
    if (loaded) config = loaded;
  }

  // Determine adapter name and options from config
  const engineRef = (config as Record<string, unknown>).reviewEngine;
  const ref =
    typeof engineRef === 'string'
      ? engineRef
      : (engineRef as { adapter?: string } | undefined)?.adapter ?? 'auto';
  const engineOptions =
    typeof engineRef === 'object' && engineRef !== null
      ? (engineRef as { options?: Record<string, unknown> }).options
      : undefined;

  const engine = await loadAdapter<ReviewEngine>({ point: 'review-engine', ref, options: engineOptions });
  const adapterName = engine.name;

  const server = new Server(
    { name: 'guardrail', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'review_diff',
        description: 'Review git-changed files against a base ref. Returns structured findings.',
        inputSchema: {
          type: 'object',
          properties: {
            base: { type: 'string', description: 'Base ref to diff against (default: upstream or HEAD~1)' },
            cwd: { type: 'string', description: 'Working directory (default: process.cwd())' },
            static_only: { type: 'boolean', description: 'Skip LLM review, run static rules only' },
          },
        },
      },
      {
        name: 'scan_files',
        description: 'Review specific files or directories. Does not require git.',
        inputSchema: {
          type: 'object',
          required: ['files'],
          properties: {
            files: { type: 'array', items: { type: 'string' }, description: 'File or directory paths to scan' },
            cwd: { type: 'string' },
            ask: { type: 'string', description: 'Targeted question, e.g. "is there SQL injection risk?"' },
          },
        },
      },
      {
        name: 'get_findings',
        description: 'Return findings from a prior review_diff or scan_files run by run_id.',
        inputSchema: {
          type: 'object',
          required: ['run_id'],
          properties: {
            run_id: { type: 'string' },
            severity: { type: 'string', enum: ['critical', 'warning', 'note'], description: 'Minimum severity to include' },
            cwd: { type: 'string' },
          },
        },
      },
      {
        name: 'fix_finding',
        description: 'Apply an LLM-generated fix for a specific finding. Validates file checksum before applying.',
        inputSchema: {
          type: 'object',
          required: ['run_id', 'finding_id'],
          properties: {
            run_id: { type: 'string' },
            finding_id: { type: 'string' },
            cwd: { type: 'string' },
            dry_run: { type: 'boolean', description: 'Return patch without applying' },
          },
        },
      },
      {
        name: 'validate_fix',
        description: 'Run the configured testCommand and return pass/fail.',
        inputSchema: {
          type: 'object',
          properties: {
            cwd: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      {
        name: 'get_capabilities',
        description: 'Return adapter, enabled rules, and workspace metadata.',
        inputSchema: {
          type: 'object',
          properties: { cwd: { type: 'string' } },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const a = args as Record<string, unknown>;

    try {
      let result: unknown;
      switch (name) {
        case 'review_diff':
          result = await handleReviewDiff(
            {
              base: a['base'] as string | undefined,
              cwd: a['cwd'] as string | undefined,
              static_only: a['static_only'] as boolean | undefined,
            },
            config,
            engine,
          );
          break;
        case 'scan_files':
          result = await handleScanFiles(
            {
              files: a['files'] as string[],
              cwd: a['cwd'] as string | undefined,
              ask: a['ask'] as string | undefined,
            },
            config,
            engine,
          );
          break;
        case 'get_findings':
          result = await handleGetFindings({
            run_id: a['run_id'] as string,
            severity: a['severity'] as 'critical' | 'warning' | 'note' | undefined,
            cwd: a['cwd'] as string | undefined,
          });
          break;
        case 'fix_finding':
          result = await handleFixFinding(
            {
              run_id: a['run_id'] as string,
              finding_id: a['finding_id'] as string,
              cwd: a['cwd'] as string | undefined,
              dry_run: a['dry_run'] as boolean | undefined,
            },
            config,
            engine,
          );
          break;
        case 'validate_fix':
          result = await handleValidateFix(
            {
              cwd: a['cwd'] as string | undefined,
              files: a['files'] as string[] | undefined,
            },
            config,
          );
          break;
        case 'get_capabilities':
          result = await handleGetCapabilities(
            { cwd: a['cwd'] as string | undefined },
            config,
            adapterName,
          );
          break;
        default:
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
            isError: true,
          };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string }).code ?? 'unknown_error';
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg, code }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
