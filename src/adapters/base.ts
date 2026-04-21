// src/adapters/base.ts

export interface AdapterBase {
  name: string;
  apiVersion: string;
  getCapabilities(): Capabilities;
}

export interface Capabilities {
  [feature: string]: boolean | number | string;
}

export const CORE_ADAPTER_API_VERSION_MAJOR = 1;

export function checkApiVersionCompatibility(adapterApiVersion: string): boolean {
  const parts = adapterApiVersion.split('.');
  const major = parseInt(parts[0] ?? '0', 10);
  return major === CORE_ADAPTER_API_VERSION_MAJOR;
}
