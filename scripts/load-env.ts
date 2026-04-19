import { config } from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

const ENV_CANDIDATES = ['.env.local', '.env.dev', '.env.development', '.env'];

/**
 * Load the first env file found in the project root.
 * Call once at the top of any script that needs env vars (OPENAI_API_KEY, etc.).
 */
export function loadEnv(): void {
  const root = process.cwd();
  for (const candidate of ENV_CANDIDATES) {
    const p = path.join(root, candidate);
    if (fs.existsSync(p)) {
      config({ path: p });
      return;
    }
  }
}

/** Returns the detected env file path, or null if none found. */
export function detectEnvFile(): string | null {
  const root = process.cwd();
  for (const candidate of ENV_CANDIDATES) {
    const p = path.join(root, candidate);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
