export type WorkspaceTemplatePolicy = 'managed_readonly' | 'seed_once';
export type WorkspaceTemplateEntryKind = 'file' | 'directory';

export interface WorkspaceTemplateEntry {
  path: string;
  kind: WorkspaceTemplateEntryKind;
  policy: WorkspaceTemplatePolicy;
  mode: '0444' | '0555' | '0644' | '0755';
  sha256: string;
  size?: number;
}

export interface WorkspaceTemplateDraftEntry extends WorkspaceTemplateEntry {
  content?: string;
  encoding?: 'utf8' | 'base64';
}

export interface WorkspaceTemplateManifest {
  schema_version: 1;
  template_version: number;
  entries: WorkspaceTemplateEntry[];
  content_digest: string;
}

export interface WorkspaceTemplatePolicies {
  schema_version: 1;
  entries: Record<string, WorkspaceTemplatePolicy>;
}

export interface WorkspaceSyncScope {
  project_name?: string;
  user_id?: string;
  kind?: 'persistent' | 'temporary';
  workspace_ids?: string[];
}
