import type { Finding } from '../core/findings/types.ts';

export function encodeAnnotationProperty(s: string): string {
  return s
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

export function encodeAnnotationData(s: string): string {
  return s
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function severityToCommand(s: Finding['severity']): 'error' | 'warning' | 'notice' {
  if (s === 'critical') return 'error';
  if (s === 'warning') return 'warning';
  return 'notice';
}

export function emitAnnotations(findings: Finding[]): void {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  for (const f of findings) {
    const cmd = severityToCommand(f.severity);
    const props: string[] = [`file=${encodeAnnotationProperty(f.file)}`];
    if (f.line !== undefined) {
      props.push(`line=${f.line}`, `endLine=${f.line}`);
    }
    props.push(`title=${encodeAnnotationProperty(f.category)}`);
    process.stdout.write(`::${cmd} ${props.join(',')}::${encodeAnnotationData(f.message)}\n`);
  }
}
