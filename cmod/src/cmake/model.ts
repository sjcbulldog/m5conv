/**
 * Rich, cross-referenced object model built on top of the raw JSON shapes
 * in `types.ts`.
 */
import type {
  CMakeTargetType,
  RawBacktraceGraph,
  RawCodemodel,
  RawCommandFragment,
  RawCompileGroup,
  RawConfiguration,
  RawDirectory,
  RawDirectoryRef,
  RawFileSet,
  RawIndexFile,
  RawInstaller,
  RawLink,
  RawProjectRef,
  RawSource,
  RawTarget,
  RawTargetRef,
} from "./types.js";

export interface BacktraceLocation {
  file: string;
  line?: number;
  command?: string;
  parent?: BacktraceLocation;
}

export class BacktraceGraph {
  constructor(private readonly raw: RawBacktraceGraph) {}

  resolve(index: number | undefined): BacktraceLocation | undefined {
    if (index === undefined) return undefined;
    const node = this.raw.nodes[index];
    if (!node) return undefined;
    return {
      file: this.raw.files[node.file],
      line: node.line,
      command:
        node.command !== undefined ? this.raw.commands[node.command] : undefined,
      parent: this.resolve(node.parent),
    };
  }
}

export class CommandFragment {
  constructor(
    public readonly fragment: string,
    public readonly role: RawCommandFragment["role"] | undefined,
    public readonly backtrace?: BacktraceLocation,
  ) {}
}

export class CompileGroup {
  readonly language: string;
  readonly sysroot?: string;
  readonly flags: CommandFragment[];
  readonly defines: Array<{ define: string; backtrace?: BacktraceLocation }>;
  readonly includes: Array<{
    path: string;
    isSystem: boolean;
    backtrace?: BacktraceLocation;
  }>;
  readonly precompileHeaders: Array<{
    header: string;
    backtrace?: BacktraceLocation;
  }>;
  readonly languageStandard?: string;
  readonly sources: Source[] = [];

  constructor(raw: RawCompileGroup, bt: BacktraceGraph) {
    this.language = raw.language;
    this.sysroot = raw.sysroot?.path;
    this.flags =
      raw.compileCommandFragments?.map(
        (f) => new CommandFragment(f.fragment, undefined, bt.resolve(f.backtrace)),
      ) ?? [];
    this.defines =
      raw.defines?.map((d) => ({
        define: d.define,
        backtrace: bt.resolve(d.backtrace),
      })) ?? [];
    this.includes =
      raw.includes?.map((i) => ({
        path: i.path,
        isSystem: !!i.isSystem,
        backtrace: bt.resolve(i.backtrace),
      })) ?? [];
    this.precompileHeaders =
      raw.precompileHeaders?.map((p) => ({
        header: p.header,
        backtrace: bt.resolve(p.backtrace),
      })) ?? [];
    this.languageStandard = raw.languageStandard?.standard;
  }
}

export class Source {
  readonly path: string;
  readonly isGenerated: boolean;
  readonly backtrace?: BacktraceLocation;
  compileGroup?: CompileGroup;
  sourceGroup?: SourceGroup;
  fileSet?: FileSet;

  constructor(raw: RawSource, bt: BacktraceGraph) {
    this.path = raw.path;
    this.isGenerated = !!raw.isGenerated;
    this.backtrace = bt.resolve(raw.backtrace);
  }
}

export class SourceGroup {
  readonly sources: Source[] = [];
  constructor(public readonly name: string) {}
}

export class FileSet {
  constructor(
    public readonly name: string,
    public readonly type: string,
    public readonly visibility: string,
    public readonly baseDirectories: string[],
  ) {}
  static from(raw: RawFileSet): FileSet {
    return new FileSet(raw.name, raw.type, raw.visibility, raw.baseDirectories);
  }
}

export class LinkInfo {
  readonly language: string;
  readonly lto?: boolean;
  readonly sysroot?: string;
  readonly fragments: CommandFragment[];

  constructor(raw: RawLink, bt: BacktraceGraph) {
    this.language = raw.language;
    this.lto = raw.lto;
    this.sysroot = raw.sysroot?.path;
    this.fragments =
      raw.commandFragments?.map(
        (f) => new CommandFragment(f.fragment, f.role, bt.resolve(f.backtrace)),
      ) ?? [];
  }

  flags(): CommandFragment[] {
    return this.fragments.filter((f) => f.role === "flags");
  }
  libraries(): CommandFragment[] {
    return this.fragments.filter((f) => f.role === "libraries");
  }
  libraryPaths(): CommandFragment[] {
    return this.fragments.filter((f) => f.role === "libraryPath");
  }
}

export class Installer {
  constructor(
    public readonly raw: RawInstaller,
    public readonly backtrace?: BacktraceLocation,
  ) {}
  get type(): string {
    return this.raw.type;
  }
  get component(): string {
    return this.raw.component;
  }
  get destination(): string | undefined {
    return this.raw.destination;
  }
}

export class Directory {
  readonly source: string;
  readonly build: string;
  readonly jsonFile: string;
  readonly minimumCMakeVersion?: string;
  readonly hasInstallRule: boolean;
  parent?: Directory;
  readonly children: Directory[] = [];
  project!: Project;
  readonly targets: Target[] = [];
  readonly installers: Installer[] = [];

  constructor(public readonly ref: RawDirectoryRef) {
    this.source = ref.source;
    this.build = ref.build;
    this.jsonFile = ref.jsonFile;
    this.minimumCMakeVersion = ref.minimumCMakeVersion?.string;
    this.hasInstallRule = !!ref.hasInstallRule;
  }

  loadDetails(detail: RawDirectory): void {
    const bt = new BacktraceGraph(detail.backtraceGraph);
    for (const inst of detail.installers) {
      this.installers.push(new Installer(inst, bt.resolve(inst.backtrace)));
    }
  }
}

export class Project {
  readonly name: string;
  parent?: Project;
  readonly children: Project[] = [];
  readonly directories: Directory[] = [];
  readonly targets: Target[] = [];

  constructor(public readonly ref: RawProjectRef) {
    this.name = ref.name;
  }
}

export class Target {
  readonly id: string;
  readonly name: string;
  readonly type: CMakeTargetType;
  readonly jsonFile: string;
  readonly nameOnDisk?: string;
  readonly folder?: string;
  readonly sourcePath: string;
  readonly buildPath: string;
  readonly isGeneratorProvided: boolean;
  readonly artifacts: string[];
  readonly sources: Source[] = [];
  readonly sourceGroups: SourceGroup[] = [];
  readonly compileGroups: CompileGroup[] = [];
  readonly fileSets: FileSet[] = [];
  readonly link?: LinkInfo;
  readonly archiveFragments: CommandFragment[];
  readonly backtrace?: BacktraceLocation;

  readonly dependencyIds: string[];
  readonly orderDependencyIds: string[];
  readonly linkLibraryIds: string[];
  readonly linkLibraryFragments: CommandFragment[];

  readonly dependencies: Target[] = [];
  readonly orderDependencies: Target[] = [];
  readonly linkLibraries: Target[] = [];

  directory!: Directory;
  project!: Project;

  constructor(
    public readonly ref: RawTargetRef,
    public readonly raw: RawTarget,
  ) {
    this.id = raw.id;
    this.name = raw.name;
    this.type = raw.type;
    this.jsonFile = ref.jsonFile;
    this.nameOnDisk = raw.nameOnDisk;
    this.folder = raw.folder?.name;
    this.sourcePath = raw.paths.source;
    this.buildPath = raw.paths.build;
    this.isGeneratorProvided = !!raw.isGeneratorProvided;
    this.artifacts = raw.artifacts?.map((a) => a.path) ?? [];

    const bt = new BacktraceGraph(raw.backtraceGraph);
    this.backtrace = bt.resolve(raw.backtrace);

    for (const sg of raw.sourceGroups ?? []) {
      this.sourceGroups.push(new SourceGroup(sg.name));
    }
    for (const fs of raw.fileSets ?? []) {
      this.fileSets.push(FileSet.from(fs));
    }
    for (const cg of raw.compileGroups ?? []) {
      this.compileGroups.push(new CompileGroup(cg, bt));
    }
    for (const s of raw.sources) {
      const src = new Source(s, bt);
      if (s.compileGroupIndex !== undefined) {
        src.compileGroup = this.compileGroups[s.compileGroupIndex];
        src.compileGroup?.sources.push(src);
      }
      if (s.sourceGroupIndex !== undefined) {
        src.sourceGroup = this.sourceGroups[s.sourceGroupIndex];
        src.sourceGroup?.sources.push(src);
      }
      if (s.fileSetIndex !== undefined) {
        src.fileSet = this.fileSets[s.fileSetIndex];
      }
      this.sources.push(src);
    }

    this.link = raw.link ? new LinkInfo(raw.link, bt) : undefined;
    this.archiveFragments =
      raw.archive?.commandFragments?.map(
        (f) => new CommandFragment(f.fragment, undefined, bt.resolve(f.backtrace)),
      ) ?? [];

    this.dependencyIds = (raw.dependencies ?? []).map((d) => d.id);
    this.orderDependencyIds = (raw.orderDependencies ?? []).map((d) => d.id);

    const linkIds: string[] = [];
    const linkFrags: CommandFragment[] = [];
    for (const ll of raw.linkLibraries ?? []) {
      if (ll.id) linkIds.push(ll.id);
      if (ll.fragment) {
        linkFrags.push(
          new CommandFragment(ll.fragment, "libraries", bt.resolve(ll.backtrace)),
        );
      }
    }
    this.linkLibraryIds = linkIds;
    this.linkLibraryFragments = linkFrags;
  }

  get isExecutable(): boolean {
    return this.type === "EXECUTABLE";
  }
  get isLibrary(): boolean {
    return (
      this.type === "STATIC_LIBRARY" ||
      this.type === "SHARED_LIBRARY" ||
      this.type === "MODULE_LIBRARY" ||
      this.type === "OBJECT_LIBRARY" ||
      this.type === "INTERFACE_LIBRARY"
    );
  }
}

export class Configuration {
  readonly name: string;
  readonly directories: Directory[] = [];
  readonly projects: Project[] = [];
  readonly targets: Target[] = [];

  constructor(public readonly raw: RawConfiguration) {
    this.name = raw.name;
  }

  findTarget(name: string): Target | undefined {
    return this.targets.find((t) => t.name === name);
  }
  findTargetById(id: string): Target | undefined {
    return this.targets.find((t) => t.id === id);
  }
  rootProjects(): Project[] {
    return this.projects.filter((p) => !p.parent);
  }
  rootDirectories(): Directory[] {
    return this.directories.filter((d) => !d.parent);
  }
}

export interface CMakeVersion {
  major: number;
  minor: number;
  patch: number;
  string: string;
  suffix: string;
  isDirty: boolean;
}

export interface CMakeGenerator {
  name: string;
  multiConfig: boolean;
  platform?: string;
}

export class CMakeModel {
  readonly cmakeVersion: CMakeVersion;
  readonly generator: CMakeGenerator;
  readonly paths: { source: string; build: string };
  readonly configurations: Configuration[] = [];

  constructor(index: RawIndexFile, codemodel: RawCodemodel) {
    this.cmakeVersion = index.cmake.version;
    this.generator = index.cmake.generator;
    this.paths = codemodel.paths;
  }

  get defaultConfiguration(): Configuration | undefined {
    return this.configurations[0];
  }

  findConfiguration(name: string): Configuration | undefined {
    return this.configurations.find((c) => c.name === name);
  }
}
