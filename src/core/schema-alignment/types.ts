// src/core/schema-alignment/types.ts

export interface SchemaEntity {
  table: string;
  column?: string;
  operation: 'create_table' | 'add_column' | 'drop_column' | 'rename_column' | 'create_type';
  oldName?: string; // rename_column only: the previous column name
}

export interface Evidence {
  file: string;
  line: number;
  snippet: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface LayerScanResult {
  entity: SchemaEntity;
  typeLayer: Evidence | null;
  apiLayer: Evidence | null;
  uiLayer: Evidence | null;
}

export interface AlignmentFinding {
  entity: SchemaEntity;
  layer: 'type' | 'api' | 'ui';
  message: string;
  file?: string;
  severity: 'warning' | 'error';
  confidence: 'high' | 'medium' | 'low';
}

export interface SchemaAlignmentConfig {
  enabled?: boolean;
  migrationGlobs?: string[];
  layerRoots?: {
    types?: string[];
    api?: string[];
    ui?: string[];
  };
  llmCheck?: boolean;
  severity?: 'warning' | 'error';
}
