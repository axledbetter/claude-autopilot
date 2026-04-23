const HIGH_IMPACT_PATTERNS = [
  /^src\/core\/pipeline\//,
  /^src\/adapters\//,
  /^src\/core\/findings\//,
  /^src\/core\/config\//,
];

export interface SelectResult {
  selected: string[];
  fullRun: boolean;
  reason: string;
}

export function selectSnapshots(
  changedFiles: string[],
  allSnapshotFiles: string[],
  index: Record<string, string[]>,
  importMap: Record<string, string[]>,
  options: { highImpactPatterns?: RegExp[]; volumeThreshold?: number } = {},
): SelectResult {
  const patterns = options.highImpactPatterns ?? HIGH_IMPACT_PATTERNS;
  const volumeThreshold = options.volumeThreshold ?? 10;

  if (changedFiles.length > volumeThreshold) {
    return { selected: allSnapshotFiles, fullRun: true, reason: 'volume override (>10 files changed)' };
  }

  for (const f of changedFiles) {
    for (const p of patterns) {
      if (p.test(f)) {
        return { selected: allSnapshotFiles, fullRun: true, reason: `high-impact path matched: ${f}` };
      }
    }
  }

  // Build: sourceFile → snapFiles that cover it
  const sourceToSnaps: Record<string, string[]> = {};
  for (const [snapFile, sources] of Object.entries(index)) {
    for (const src of sources) {
      if (!sourceToSnaps[src]) sourceToSnaps[src] = [];
      sourceToSnaps[src]!.push(snapFile);
    }
  }

  const selected = new Set<string>();
  for (const changed of changedFiles) {
    for (const snap of sourceToSnaps[changed] ?? []) selected.add(snap);
    for (const importer of importMap[changed] ?? []) {
      for (const snap of sourceToSnaps[importer] ?? []) selected.add(snap);
    }
  }

  return {
    selected: [...selected],
    fullRun: false,
    reason: selected.size === 0
      ? 'no snapshots matched changed files'
      : `${selected.size} snapshot(s) selected`,
  };
}
