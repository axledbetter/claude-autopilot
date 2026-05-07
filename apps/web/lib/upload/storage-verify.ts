import { createServiceRoleClient } from '@/lib/supabase/service';
import { BUCKET } from './storage';

export async function readObject(path: string): Promise<Buffer | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) return null;
  if (data instanceof Blob || (typeof (data as Blob).arrayBuffer === 'function')) {
    return Buffer.from(await (data as Blob).arrayBuffer());
  }
  return Buffer.from(data as unknown as ArrayBuffer);
}

export async function existingBytesEqual(path: string, expected: Buffer): Promise<boolean> {
  const got = await readObject(path);
  if (!got) return false;
  return got.length === expected.length && got.equals(expected);
}
