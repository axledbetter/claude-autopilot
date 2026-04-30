// src/core/errors.ts

export type ErrorCode =
  | 'auth' | 'rate_limit' | 'transient_network' | 'invalid_config'
  | 'adapter_bug' | 'user_input' | 'budget_exceeded' | 'concurrency_lock' | 'superseded'
  | 'no_previous_deploy'
  | 'not_found';

export interface GuardrailErrorOptions {
  code: ErrorCode;
  retryable?: boolean;
  provider?: string;
  step?: string;
  details?: Record<string, unknown>;
}

const DEFAULT_RETRYABLE: Record<ErrorCode, boolean> = {
  auth: false, rate_limit: true, transient_network: true, invalid_config: false,
  adapter_bug: false, user_input: false, budget_exceeded: false,
  concurrency_lock: false, superseded: false,
  no_previous_deploy: false,
  // 404 — caller-fixable (slug typo, wrong scope). Not retryable; the
  // resource won't materialize on its own.
  not_found: false,
};

export class GuardrailError extends Error {
  code: ErrorCode;
  retryable: boolean;
  provider?: string;
  step?: string;
  details: Record<string, unknown>;

  constructor(message: string, options: GuardrailErrorOptions) {
    super(message);
    this.name = 'GuardrailError';
    this.code = options.code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[options.code];
    this.provider = options.provider;
    this.step = options.step;
    this.details = options.details ?? {};
  }
}
