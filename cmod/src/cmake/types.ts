/**
 * Raw JSON shapes for the CMake File API "codemodel" v2 object kind.
 * See: https://cmake.org/cmake/help/latest/manual/cmake-file-api.7.html
 */

export interface RawIndexFile {
  cmake: {
    generator: { multiConfig: boolean; name: string; platform?: string };
    paths: { cmake: string; cpack: string; ctest: string; root: string };
    version: {
      major: number;
      minor: number;
      patch: number;
      string: string;
      suffix: string;
      isDirty: boolean;
    };
  };
  objects: RawObjectRef[];
  reply: Record<string, RawObjectRef | Record<string, RawObjectRef>>;
}

export interface RawObjectRef {
  kind: string;
  version: { major: number; minor: number };
  jsonFile: string;
}

export interface RawCodemodel {
  kind?: "codemodel";
  version: { major: number; minor: number };
  paths: { source: string; build: string };
  configurations: RawConfiguration[];
}

export interface RawConfiguration {
  name: string;
  directories: RawDirectoryRef[];
  projects: RawProjectRef[];
  targets: RawTargetRef[];
}

export interface RawDirectoryRef {
  source: string;
  build: string;
  parentIndex?: number;
  childIndexes?: number[];
  projectIndex: number;
  targetIndexes?: number[];
  minimumCMakeVersion?: { string: string };
  hasInstallRule?: boolean;
  jsonFile: string;
}

export interface RawProjectRef {
  name: string;
  parentIndex?: number;
  childIndexes?: number[];
  directoryIndexes: number[];
  targetIndexes?: number[];
}

export interface RawTargetRef {
  name: string;
  id: string;
  directoryIndex: number;
  projectIndex: number;
  jsonFile: string;
}

export interface RawDirectory {
  paths: { source: string; build: string };
  installers: RawInstaller[];
  backtraceGraph: RawBacktraceGraph;
}

export interface RawInstaller {
  component: string;
  type: string;
  destination?: string;
  paths?: Array<string | { from: string; to: string }>;
  isExcludeFromAll?: boolean;
  isForAllComponents?: boolean;
  isOptional?: boolean;
  targetId?: string;
  targetIndex?: number;
  targetIsImportLibrary?: boolean;
  targetInstallNamelink?: string;
  exportName?: string;
  exportTargets?: Array<{ id: string; index: number }>;
  scriptFile?: string;
  backtrace?: number;
}

export type CMakeTargetType =
  | "EXECUTABLE"
  | "STATIC_LIBRARY"
  | "SHARED_LIBRARY"
  | "MODULE_LIBRARY"
  | "OBJECT_LIBRARY"
  | "INTERFACE_LIBRARY"
  | "UTILITY";

export interface RawTarget {
  name: string;
  id: string;
  type: CMakeTargetType;
  backtrace?: number;
  folder?: { name: string };
  paths: { source: string; build: string };
  nameOnDisk?: string;
  artifacts?: Array<{ path: string }>;
  isGeneratorProvided?: boolean;
  install?: {
    prefix: { path: string };
    destinations: Array<{ path: string; backtrace?: number }>;
  };
  launchers?: Array<{ command: string; arguments?: string[]; type: string }>;
  link?: RawLink;
  archive?: { commandFragments?: RawCommandFragment[]; lto?: boolean };
  linkLibraries?: Array<{ id?: string; fragment?: string; backtrace?: number }>;
  dependencies?: Array<{ id: string; backtrace?: number }>;
  orderDependencies?: Array<{ id: string; backtrace?: number }>;
  sources: RawSource[];
  sourceGroups?: Array<{ name: string; sourceIndexes: number[] }>;
  compileGroups?: RawCompileGroup[];
  backtraceGraph: RawBacktraceGraph;
  fileSets?: RawFileSet[];
}

export interface RawLink {
  language: string;
  commandFragments?: RawCommandFragment[];
  lto?: boolean;
  sysroot?: { path: string };
}

export interface RawCommandFragment {
  fragment: string;
  role: "flags" | "libraries" | "libraryPath" | "frameworkPath";
  backtrace?: number;
}

export interface RawSource {
  path: string;
  compileGroupIndex?: number;
  sourceGroupIndex?: number;
  isGenerated?: boolean;
  fileSetIndex?: number;
  backtrace?: number;
}

export interface RawCompileGroup {
  language: string;
  sourceIndexes: number[];
  sysroot?: { path: string };
  compileCommandFragments?: Array<{ fragment: string; backtrace?: number }>;
  includes?: Array<{ path: string; isSystem?: boolean; backtrace?: number }>;
  frameworks?: Array<{ path: string; isSystem?: boolean; backtrace?: number }>;
  precompileHeaders?: Array<{ header: string; backtrace?: number }>;
  languageStandard?: { backtraces?: number[]; standard: string };
  defines?: Array<{ define: string; backtrace?: number }>;
}

export interface RawFileSet {
  name: string;
  type: string;
  visibility: string;
  baseDirectories: string[];
}

export interface RawBacktraceGraph {
  nodes: Array<{
    file: number;
    line?: number;
    command?: number;
    parent?: number;
  }>;
  commands: string[];
  files: string[];
}
