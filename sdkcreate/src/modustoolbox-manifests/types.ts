export interface ManifestVersion {
  label: string;
  commit: string;
  description?: string;
  flowVersions: string[];
  providedCapabilities: string[];
  /** AND-of-OR groups. Each group must be satisfied; within a group, any member suffices. */
  requiredCapabilities: string[][];
  toolsMaxVersion?: string;
}

export interface NestedManifestSource {
  source: string;
}

export interface SuperManifest {
  source: string;
  boardManifestSources: NestedManifestSource[];
  middlewareManifestSources: NestedManifestSource[];
  appManifestSources: NestedManifestSource[];
}

export interface Chip {
  kind: string;
  model: string;
}

interface ManifestEntry {
  id: string;
  name: string;
  repositoryUrl?: string;
  description?: string;
  versions: ManifestVersion[];
  manifestSources: string[];
}

export interface Bsp extends ManifestEntry {
  kind: "bsp";
  category?: string;
  summary?: string;
  documentationUrl?: string;
  providedCapabilities: string[];
  chips: Chip[];
}

export interface MiddlewarePackage extends ManifestEntry {
  kind: "middleware";
  category?: string;
  /** AND-of-OR groups. Each group must be satisfied; within a group, any member suffices. */
  requiredCapabilities: string[][];
}

export interface CodeExample extends ManifestEntry {
  kind: "code-example";
  /** AND-of-OR groups. Each group must be satisfied; within a group, any member suffices. */
  requiredCapabilities: string[][];
}

export interface MiddlewareManifest {
  source: string;
  middleware: MiddlewarePackage[];
}

export interface AppManifest {
  source: string;
  codeExamples: CodeExample[];
}

export interface BoardManifest {
  source: string;
  bsps: Bsp[];
}

export interface ModusToolboxCatalog {
  superManifests: SuperManifest[];
  boardManifests: BoardManifest[];
  middlewareManifests: MiddlewareManifest[];
  appManifests: AppManifest[];
  bsps: Bsp[];
  middleware: MiddlewarePackage[];
  codeExamples: CodeExample[];
}

export interface LoadModusToolboxCatalogOptions {
  superManifestSources?: readonly string[];
  defaultSuperManifestSource?: string;
  readText?: (source: string) => Promise<string>;
}
