export const GUARDRAIL_CONFIG_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['configVersion'],
  additionalProperties: false,
  properties: {
    configVersion: { const: 1 },
    preset: { type: 'string' },
    reviewEngine: { $ref: '#/definitions/adapterRef' },
    vcsHost: { $ref: '#/definitions/adapterRef' },
    migrationRunner: { $ref: '#/definitions/adapterRef' },
    reviewBot: { $ref: '#/definitions/adapterRef' },
    adapterAllowlist: { type: 'array', items: { type: 'string' } },
    protectedPaths: { type: 'array', items: { type: 'string' } },
    staticRules: {
      type: 'array',
      items: {
        oneOf: [
          { type: 'string' },
          { type: 'object', required: ['adapter'], properties: { adapter: { type: 'string' }, options: { type: 'object' } } },
        ],
      },
    },
    staticRulesParallel: { type: 'boolean' },
    stack: { type: 'string' },
    testCommand: { type: ['string', 'null'] },
    thresholds: {
      type: 'object',
      properties: {
        bugbotAutoFix: { type: 'number' },
        bugbotProposePatch: { type: 'number' },
        maxValidateRetries: { type: 'number' },
        maxCodexRetries: { type: 'number' },
        maxBugbotRounds: { type: 'number' },
      },
      additionalProperties: false,
    },
    ignore: {
      type: 'array',
      items: {
        oneOf: [
          { type: 'string' },
          {
            type: 'object',
            required: ['path'],
            properties: {
              rule: { type: 'string' },
              path: { type: 'string' },
            },
            additionalProperties: false,
          },
        ],
      },
    },
    reviewStrategy: { enum: ['auto', 'single-pass', 'file-level', 'diff', 'auto-diff'] },
    chunking: {
      type: 'object',
      properties: {
        smallTierMaxTokens: { type: 'number' },
        partialReviewTokens: { type: 'number' },
        perFileMaxTokens: { type: 'number' },
        parallelism: { type: 'number' },
        rateLimitBackoff: { enum: ['exp', 'linear', 'none'] },
      },
      additionalProperties: false,
    },
    policy: {
      type: 'object',
      properties: {
        failOn: { enum: ['critical', 'warning', 'note', 'none'] },
        newOnly: { type: 'boolean' },
        baselinePath: { type: 'string' },
      },
      additionalProperties: false,
    },
    pipeline: {
      type: 'object',
      properties: {
        runReviewOnStaticFail: { type: 'boolean' },
        runReviewOnTestFail: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    cost: {
      type: 'object',
      properties: {
        maxPerRun: { type: 'number' },
        estimateBeforeRun: { type: 'boolean' },
        pricing: { type: 'object' },
      },
      additionalProperties: false,
    },
    brand: {
      type: 'object',
      properties: {
        colorsFrom: { type: 'string' },
        colors: { type: 'array', items: { type: 'string' } },
        fonts: { type: 'array', items: { type: 'string' } },
        componentLibrary: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                tokens: { type: 'string' },
                guide: { type: 'string' },
              },
              additionalProperties: false,
            },
          ],
        },
      },
      additionalProperties: false,
    },
    'schema-alignment': {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        migrationGlobs: { type: 'array', items: { type: 'string', minLength: 1 } },
        layerRoots: {
          type: 'object',
          properties: {
            types: { type: 'array', items: { type: 'string' }, minItems: 1 },
            api: { type: 'array', items: { type: 'string' }, minItems: 1 },
            ui: { type: 'array', items: { type: 'string' }, minItems: 1 },
          },
          additionalProperties: false,
        },
        llmCheck: { type: 'boolean' },
        severity: { enum: ['warning', 'error'] },
      },
      additionalProperties: false,
    },
    cache: { type: 'object' },
    persistence: { type: 'object' },
    concurrency: { type: 'object' },
    council: {
      type: 'object',
      required: ['models', 'synthesizer'],
      additionalProperties: false,
      properties: {
        models: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            required: ['adapter', 'model', 'label'],
            additionalProperties: false,
            properties: {
              adapter: { type: 'string' },
              model: { type: 'string' },
              label: { type: 'string' },
            },
          },
        },
        synthesizer: {
          type: 'object',
          required: ['adapter', 'model', 'label'],
          additionalProperties: false,
          properties: {
            adapter: { type: 'string' },
            model: { type: 'string' },
            label: { type: 'string' },
          },
        },
        timeout_ms: { type: 'number' },
        min_successful_responses: { type: 'number' },
        parallel_input_max_tokens: { type: 'number' },
        synthesis_input_max_tokens: { type: 'number' },
      },
    },
  },
  definitions: {
    adapterRef: {
      oneOf: [
        { type: 'string' },
        { type: 'object', required: ['adapter'], properties: { adapter: { type: 'string' }, options: { type: 'object' } } },
      ],
    },
  },
} as const;
