// Phase 5.6 — DNS TXT challenge verification with real timeout bound.
//
// Codex spec pass-2 WARNING #4: node:dns/promises.resolveTxt does not
// honor AbortSignal, so we use Promise.race to bound the overall call.

import { resolveTxt } from 'node:dns/promises';

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export async function verifyTxtChallenge(
  fqdn: string,
  expectedToken: string,
  timeoutMs = 5_000,
): Promise<VerifyResult> {
  const lookup = (async (): Promise<VerifyResult> => {
    try {
      const records = await resolveTxt(fqdn);
      for (const chunkArr of records) {
        const value = chunkArr.join('');
        if (value === expectedToken) return { ok: true };
      }
      return { ok: false, reason: 'no_matching_txt_record' };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') return { ok: false, reason: 'no_txt_records' };
      return { ok: false, reason: code ?? 'dns_error' };
    }
  })();
  const timeout = new Promise<VerifyResult>((resolve) =>
    setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs),
  );
  return Promise.race([lookup, timeout]);
}
