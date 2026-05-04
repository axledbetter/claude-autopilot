// src/core/static-rules/rules/schema-alignment.ts
import type { StaticRule, StaticRuleContext } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';
import type { LayerScanResult, AlignmentFinding, Evidence, SchemaEntity } from '../../schema-alignment/types.ts';
import { detect } from '../../schema-alignment/detector.ts';
import { extract } from '../../schema-alignment/extractor/index.ts';
import { getPreviousFileContent } from '../../schema-alignment/git-history.ts';
import { scanLayers } from '../../schema-alignment/scanner.ts';
import { runLlmCheck } from '../../schema-alignment/llm-check.ts';

function isDestructive(entity: { operation: string }): boolean {
  return entity.operation === 'drop_column' || entity.operation === 'rename_column';
}

function toFinding(af: AlignmentFinding, fallbackFile: string): Finding {
  return {
    id: `schema-alignment:${af.entity.table}:${af.entity.column ?? ''}:${af.layer}`,
    source: 'static-rules',
    severity: af.severity === 'error' ? 'critical' : 'warning',
    category: 'schema-alignment',
    // LLM may supply an explicit `file`; otherwise fall back to the migration
    // file that triggered the check. Never use the table name as a path.
    file: af.file ?? fallbackFile,
    message: af.message,
    suggestion: `Update the ${af.layer} layer to reflect the schema change in "${af.entity.column ?? af.entity.table}"`,
    protectedPath: false,
    createdAt: new Date().toISOString(),
  };
}

function layerEvidence(result: LayerScanResult, layer: 'type' | 'api' | 'ui'): Evidence | null {
  return layer === 'type' ? result.typeLayer : layer === 'api' ? result.apiLayer : result.uiLayer;
}

function structuralFinding(
  result: LayerScanResult,
  layer: 'type' | 'api' | 'ui',
  defaultSev: 'warning' | 'error',
  sourceFile: string,
): Finding {
  const destructive = isDestructive(result.entity);
  const name = result.entity.column ?? result.entity.table;
  const message = destructive
    ? `Stale reference to dropped/renamed "${name}" still present in ${layer} layer after schema change`
    : `No reference to "${name}" found in ${layer} layer — update may be missing after schema change`;
  const severity: Finding['severity'] = destructive ? 'critical' : (defaultSev === 'error' ? 'critical' : 'warning');
  // Destructive findings have Evidence (the stale reference's actual file);
  // non-destructive findings don't have a layer file (that's the gap), so point
  // back to the migration that caused the change.
  const evidence = destructive ? layerEvidence(result, layer) : null;
  return {
    id: `schema-alignment:${result.entity.table}:${result.entity.column ?? ''}:${layer}`,
    source: 'static-rules',
    severity,
    category: 'schema-alignment',
    file: evidence?.file ?? sourceFile,
    line: evidence?.line,
    message,
    suggestion: `Check the ${layer} layer for references to "${name}"`,
    protectedPath: false,
    createdAt: new Date().toISOString(),
  };
}

export const schemaAlignmentRule: StaticRule = {
  name: 'schema-alignment',
  severity: 'warning',

  async check(touchedFiles: string[], ctx: StaticRuleContext = {}): Promise<Finding[]> {
    const saConfig = ctx.config?.['schema-alignment'];
    if (saConfig?.enabled === false) return [];

    const cwd = process.cwd();
    const migrationFiles = detect(touchedFiles, saConfig);
    if (migrationFiles.length === 0) return [];

    // Preserve source migration file for each entity so findings can point back
    // to the SQL/Prisma file that caused the change.
    type EntityWithSource = { entity: SchemaEntity; sourceFile: string };
    // For Prisma schema files, fetch the previous version from git so we only
    // emit entities for what actually changed in this diff. SQL migrations
    // are inherently a diff already; the SQL extractor ignores
    // `previousContent`, so skipping the `git show` spawn there avoids pure
    // waste (Bugbot LOW on PR #44).
    const allEntities: EntityWithSource[] = migrationFiles.flatMap(f => {
      const isPrisma = f.endsWith('.prisma');
      const previousContent = isPrisma ? getPreviousFileContent(f, cwd) : null;
      return extract(f, previousContent).map(entity => ({ entity, sourceFile: f }));
    });
    if (allEntities.length === 0) return [];

    const scanResults = scanLayers(allEntities.map(e => e.entity), cwd, saConfig);
    // Index source files back onto scan results (scanLayers preserves order)
    const resultsWithSource = scanResults.map((r, i) => ({ result: r, sourceFile: allEntities[i]!.sourceFile }));

    // For destructive ops: gap = evidence WAS found (stale ref remains)
    // For add/create: gap = evidence NOT found (layer not updated)
    const gapResults = resultsWithSource.filter(({ result: r }) => {
      if (isDestructive(r.entity)) return r.typeLayer !== null || r.apiLayer !== null || r.uiLayer !== null;
      return r.typeLayer === null || r.apiLayer === null || r.uiLayer === null;
    });

    if (gapResults.length === 0) return [];

    const defaultSev = saConfig?.severity ?? 'warning';
    const llmEnabled = saConfig?.llmCheck !== false;
    const engine = ctx.engine;

    // Structural mode — always compute these so we can fall back if LLM path yields nothing
    const structural: Finding[] = [];
    for (const { result: r, sourceFile } of gapResults) {
      if (isDestructive(r.entity)) {
        if (r.typeLayer) structural.push(structuralFinding(r, 'type', defaultSev, sourceFile));
        if (r.apiLayer) structural.push(structuralFinding(r, 'api', defaultSev, sourceFile));
        if (r.uiLayer) structural.push(structuralFinding(r, 'ui', defaultSev, sourceFile));
      } else {
        if (!r.typeLayer) structural.push(structuralFinding(r, 'type', defaultSev, sourceFile));
        if (!r.apiLayer) structural.push(structuralFinding(r, 'api', defaultSev, sourceFile));
        if (!r.uiLayer) structural.push(structuralFinding(r, 'ui', defaultSev, sourceFile));
      }
    }

    if (llmEnabled && engine) {
      const llmFindings = await runLlmCheck(migrationFiles, gapResults.map(g => g.result), engine);
      // Fall back to structural findings if the LLM returned nothing parseable —
      // avoids silently dropping real gaps when the model is down or returns prose.
      if (llmFindings.length > 0) {
        // Build table → sourceFile index so each LLM finding can be attributed
        // back to its originating migration when the model didn't return a file.
        const tableToSource = new Map<string, string>();
        for (const { entity, sourceFile } of allEntities) tableToSource.set(entity.table, sourceFile);
        return llmFindings.map(af => toFinding(af, tableToSource.get(af.entity.table) ?? migrationFiles[0]!));
      }
      return structural;
    }

    return structural;
  },
};
