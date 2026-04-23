// src/core/static-rules/rules/schema-alignment.ts
import type { StaticRule } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';
import type { SchemaAlignmentConfig, LayerScanResult, AlignmentFinding } from '../../schema-alignment/types.ts';
import type { ReviewEngine } from '../../../adapters/review-engine/types.ts';
import { detect } from '../../schema-alignment/detector.ts';
import { extract } from '../../schema-alignment/extractor/index.ts';
import { scanLayers } from '../../schema-alignment/scanner.ts';
import { runLlmCheck } from '../../schema-alignment/llm-check.ts';

function isDestructive(entity: { operation: string }): boolean {
  return entity.operation === 'drop_column' || entity.operation === 'rename_column';
}

function toFinding(af: AlignmentFinding): Finding {
  return {
    id: `schema-alignment:${af.entity.table}:${af.entity.column ?? ''}:${af.layer}`,
    source: 'static-rules',
    severity: af.severity === 'error' ? 'critical' : 'warning',
    category: 'schema-alignment',
    file: af.file ?? af.entity.table,
    message: af.message,
    suggestion: `Update the ${af.layer} layer to reflect the schema change in "${af.entity.column ?? af.entity.table}"`,
    protectedPath: false,
    createdAt: new Date().toISOString(),
  };
}

function structuralFinding(result: LayerScanResult, layer: 'type' | 'api' | 'ui', defaultSev: 'warning' | 'error'): Finding {
  const destructive = isDestructive(result.entity);
  const name = result.entity.column ?? result.entity.table;
  const message = destructive
    ? `Stale reference to dropped/renamed "${name}" still present in ${layer} layer after schema change`
    : `No reference to "${name}" found in ${layer} layer — update may be missing after schema change`;
  const severity: Finding['severity'] = destructive ? 'critical' : (defaultSev === 'error' ? 'critical' : 'warning');
  return {
    id: `schema-alignment:${result.entity.table}:${result.entity.column ?? ''}:${layer}`,
    source: 'static-rules',
    severity,
    category: 'schema-alignment',
    file: result.entity.table,
    message,
    suggestion: `Check the ${layer} layer for references to "${name}"`,
    protectedPath: false,
    createdAt: new Date().toISOString(),
  };
}

export const schemaAlignmentRule: StaticRule = {
  name: 'schema-alignment',
  severity: 'warning',

  async check(touchedFiles: string[], config: Record<string, unknown> = {}): Promise<Finding[]> {
    const saConfig = config['schema-alignment'] as SchemaAlignmentConfig | undefined;
    if (saConfig?.enabled === false) return [];

    const cwd = process.cwd();
    const migrationFiles = detect(touchedFiles, saConfig);
    if (migrationFiles.length === 0) return [];

    const allEntities = migrationFiles.flatMap(f => extract(f));
    if (allEntities.length === 0) return [];

    const scanResults = scanLayers(allEntities, cwd, saConfig);

    // For destructive ops: gap = evidence WAS found (stale ref remains)
    // For add/create: gap = evidence NOT found (layer not updated)
    const gapResults = scanResults.filter(r => {
      if (isDestructive(r.entity)) return r.typeLayer !== null || r.apiLayer !== null || r.uiLayer !== null;
      return r.typeLayer === null || r.apiLayer === null || r.uiLayer === null;
    });

    if (gapResults.length === 0) return [];

    const defaultSev = saConfig?.severity ?? 'warning';
    const llmEnabled = saConfig?.llmCheck !== false;
    const engine = config['_engine'] as ReviewEngine | undefined;

    // Structural mode — always compute these so we can fall back if LLM path yields nothing
    const structural: Finding[] = [];
    for (const r of gapResults) {
      if (isDestructive(r.entity)) {
        if (r.typeLayer) structural.push(structuralFinding(r, 'type', defaultSev));
        if (r.apiLayer) structural.push(structuralFinding(r, 'api', defaultSev));
        if (r.uiLayer) structural.push(structuralFinding(r, 'ui', defaultSev));
      } else {
        if (!r.typeLayer) structural.push(structuralFinding(r, 'type', defaultSev));
        if (!r.apiLayer) structural.push(structuralFinding(r, 'api', defaultSev));
        if (!r.uiLayer) structural.push(structuralFinding(r, 'ui', defaultSev));
      }
    }

    if (llmEnabled && engine) {
      const llmFindings = await runLlmCheck(migrationFiles, gapResults, engine);
      // Fall back to structural findings if the LLM returned nothing parseable —
      // avoids silently dropping real gaps when the model is down or returns prose.
      return llmFindings.length > 0 ? llmFindings.map(toFinding) : structural;
    }

    return structural;
  },
};
