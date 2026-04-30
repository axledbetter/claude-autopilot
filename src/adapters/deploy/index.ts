// src/adapters/deploy/index.ts
//
// Public surface for the deploy-adapter package + factory.

import { GuardrailError } from '../../core/errors.ts';
import { FlyDeployAdapter } from './fly.ts';
import { GenericDeployAdapter } from './generic.ts';
import type { DeployAdapter, DeployConfig } from './types.ts';
import { VercelDeployAdapter } from './vercel.ts';

export * from './types.ts';
export { VercelDeployAdapter } from './vercel.ts';
export { FlyDeployAdapter } from './fly.ts';
export { GenericDeployAdapter } from './generic.ts';

/**
 * Construct the right deploy adapter for the supplied config.
 *
 * Throws `GuardrailError` (code: invalid_config) when required adapter-specific
 * fields are missing — failing fast at construction beats silently dropping
 * the deploy step.
 */
export function createDeployAdapter(config: DeployConfig): DeployAdapter {
  switch (config.adapter) {
    case 'vercel': {
      if (!config.project) {
        throw new GuardrailError(
          'deploy.adapter=vercel requires deploy.project (Vercel project ID or slug)',
          { code: 'invalid_config', provider: 'vercel' },
        );
      }
      return new VercelDeployAdapter({
        project: config.project,
        team: config.team,
        target: config.target,
      });
    }
    case 'fly': {
      // v5.6 Phase 1: Fly requires both `app` and `image`. We surface each
      // missing field with its own error so the user fixes both in one pass
      // instead of hunting through guardrail.config.yaml twice.
      if (!config.app) {
        throw new GuardrailError(
          'deploy.adapter=fly requires deploy.app (Fly app slug)',
          { code: 'invalid_config', provider: 'fly' },
        );
      }
      if (!config.image) {
        throw new GuardrailError(
          'deploy.adapter=fly requires deploy.image (e.g. registry.fly.io/<app>:<tag>)',
          { code: 'invalid_config', provider: 'fly' },
        );
      }
      return new FlyDeployAdapter({
        app: config.app,
        image: config.image,
        region: config.region,
      });
    }
    case 'generic': {
      if (!config.deployCommand) {
        throw new GuardrailError(
          'deploy.adapter=generic requires deploy.deployCommand (shell command)',
          { code: 'invalid_config', provider: 'generic' },
        );
      }
      return new GenericDeployAdapter({
        deployCommand: config.deployCommand,
        healthCheckUrl: config.healthCheckUrl,
      });
    }
    default: {
      // exhaustiveness guard — TS narrows config.adapter to never here
      const exhaustive: never = config.adapter;
      throw new GuardrailError(
        `Unknown deploy adapter: ${String(exhaustive)}`,
        { code: 'invalid_config' },
      );
    }
  }
}
