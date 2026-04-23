// Council adapters are factory-created (not loaded via src/adapters/loader.ts),
// so they don't implement AdapterBase. `label` is a display name for output
// grouping, distinct from the machine-identifier `name` on AdapterBase.
export interface CouncilAdapter {
  readonly label: string;
  consult(prompt: string, context: string): Promise<string>;
}
