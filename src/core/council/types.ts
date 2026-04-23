// adapter is a closed union — extending to a new provider requires an intentional
// code change in config.ts and cli/council.ts
export interface CouncilModelEntry {
  adapter: 'claude' | 'openai';
  model: string;
  label: string;
}

export interface CouncilConfig {
  models: CouncilModelEntry[];
  synthesizer: CouncilModelEntry;
  timeoutMs: number;
  minSuccessfulResponses: number;
  parallelInputMaxTokens: number;
  synthesisInputMaxTokens: number;
}

export type ModelResponseStatus = 'ok' | 'timeout' | 'error';

export interface ModelResponse {
  label: string;
  status: ModelResponseStatus;
  text?: string;
  error?: string;
  latencyMs: number;
}

export interface SynthesisResponse {
  label: string;
  text: string;
  latencyMs: number;
}

export type CouncilStatus = 'success' | 'partial' | 'failed';

export interface CouncilResult {
  // snake_case: wire-format field, consistent with MCP handler schema_version convention
  schema_version: 1;
  // snake_case: wire-format field
  run_id: string;
  status: CouncilStatus;
  prompt: string;
  responses: ModelResponse[];
  synthesis?: SynthesisResponse;
}
