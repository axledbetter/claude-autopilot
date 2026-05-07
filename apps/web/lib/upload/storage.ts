import { createServiceRoleClient } from '@/lib/supabase/service';

export const BUCKET = 'run-uploads';

export interface TenantScope {
  organizationId: string | null;
  userId: string;
}

export function chunkPath(scope: TenantScope, runId: string, seq: number): string {
  const root = scope.organizationId
    ? `org/${scope.organizationId}`
    : `user/${scope.userId}`;
  return `${root}/${runId}/events/${seq}.ndjson`;
}

export function manifestPath(scope: TenantScope, runId: string): string {
  const root = scope.organizationId
    ? `org/${scope.organizationId}`
    : `user/${scope.userId}`;
  return `${root}/${runId}/events.index.json`;
}

export function statePath(scope: TenantScope, runId: string): string {
  const root = scope.organizationId
    ? `org/${scope.organizationId}`
    : `user/${scope.userId}`;
  return `${root}/${runId}/state.json`;
}

export type StorageWriteErrorKind = 'duplicate' | 'other';

export class StorageWriteError extends Error {
  public readonly kind: StorageWriteErrorKind;
  constructor(kind: StorageWriteErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export async function putObject(path: string, body: Buffer, contentType: string): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, body, { contentType, upsert: false });
  if (error) {
    if (/already exists|Duplicate|409/i.test(error.message)) {
      throw new StorageWriteError('duplicate', error.message);
    }
    throw new StorageWriteError('other', error.message);
  }
}
