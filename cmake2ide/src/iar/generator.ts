/**
 * Orchestrates generation of an IAR EWB workspace from a CMake codemodel.
 *
 * For a chosen "root" target, this:
 *   1. Walks transitive target dependencies and selects every EXECUTABLE.
 *   2. For each executable, flattens its own sources plus the sources of
 *      every OBJECT_LIBRARY transitively reachable via dependencies and
 *      linkLibraries into a single .ewp project.
 *   3. Copies referenced source files from the CMake source directory into
 *      `dest/<exe-name>/src/`, preserving the path relative to the source
 *      directory.
 *   4. Writes one .ewp per executable and a single .eww workspace.
 */
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CMakeModel, Target } from "../cmake/index.js";
import { renderEwp, type IarEwpInput, type IarFileEntry } from "./ewp.js";
import { renderEww } from "./eww.js";

const HEADER_EXTS = new Set([".h", ".hh", ".hpp", ".hxx", ".inc"]);

export interface IarGeneratorOptions {
  sourceDir: string;
  destDir: string;
  workspaceName?: string;
}

interface ProjectPlan {
  exe: Target;
  cpu: string;
  chipEntry: string | undefined;
  outputFile: string;
  defines: Set<string>;
  includes: string[];
  /** Resolved absolute paths of include dirs that lie under the source tree. */
  absIncludeDirs: string[];
  sources: Array<{ absSource: string; projectRelPath: string; group: string }>;
  /** Absolute source-tree roots for every target that contributes to the project.
   *  Used to copy the complete asset directory (all files) into the IAR workspace. */
  assetSourceDirs: string[];
  /** Extra linker flags not handled natively by IAR IDE project settings. */
  extraLinkFlags: string[];
  /** Absolute path to the linker ICF file extracted from --config= flag. */
  icfFile?: string;
  /** Absolute path for the CMSE import library output (--import_cmse_lib_out). */
  cmseLibOut?: string;
  /** Absolute path of the CMSE import library to link into the non-secure project (--import_cmse_lib_in). */
  cmseLibIn?: string;
}

const SOURCE_EXTS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".c++",
  ".s",
  ".S",
  ".asm",
  ".h",
  ".hpp",
  ".hh",
  ".hxx",
  ".inc",
]);

export class IarGenerator {
  private iarDevicesDir?: string;

  constructor(
    private readonly model: CMakeModel,
    private readonly opts: IarGeneratorOptions,
  ) {}

  async generate(rootTargetName?: string): Promise<{
    workspaceFile: string;
    projects: string[];
  }> {
    const cfg = this.model.defaultConfiguration;
    if (!cfg) throw new Error("CMake model has no configurations");

    const root = rootTargetName
      ? cfg.findTarget(rootTargetName)
      : this.findRoot(cfg.targets);
    if (!root) throw new Error("Could not determine a root target");

    const executables = this.collectExecutables(root);
    if (executables.length === 0) {
      throw new Error(`No EXECUTABLE targets reachable from ${root.name}`);
    }

    await fs.mkdir(this.opts.destDir, { recursive: true });

    this.iarDevicesDir = await this.findIarDevicesDir();
    const projectRefs: Array<{ ewpRelPath: string; name: string; dependencies?: string[] }> = [];
    const hexPathMap = new Map<string, string>();
    const buildDirFwd = this.model.paths.build.replace(/\\/g, "/");
    const destDirFwd = this.opts.destDir.replace(/\\/g, "/");

    // Pass 1: build all plans so we can resolve cross-project paths (e.g. CMSE veneer).
    const plans: ProjectPlan[] = [];
    for (const exe of executables) {
      plans.push(await this.buildPlan(exe));
    }

    // Build a map from the cmake-build absolute path of each CMSE import library output
    // to the IAR project name and filename that will produce it.  This lets the
    // non-secure project reference the correct IAR-relative path.
    const cmseLibOutMap = new Map<string, { projName: string; filename: string }>();
    for (const plan of plans) {
      if (plan.cmseLibOut) {
        const projName = IarGenerator.stripElfExt(plan.exe.name);
        cmseLibOutMap.set(plan.cmseLibOut, { projName, filename: path.basename(plan.cmseLibOut) });
      }
    }

    // Pass 2: write all projects.
    for (const plan of plans) {
      // Resolve cmseLibIn (non-secure project) → path relative to its own $PROJ_DIR$.
      let resolvedCmseLibIn: string | undefined;
      if (plan.cmseLibIn) {
        const entry = cmseLibOutMap.get(plan.cmseLibIn);
        if (entry) {
          resolvedCmseLibIn = `$PROJ_DIR$/../${entry.projName}/Debug/Exe/${entry.filename}`;
        }
      }
      await this.writeProject(plan, resolvedCmseLibIn);
      const pname = IarGenerator.stripElfExt(plan.exe.name);
      projectRefs.push({ ewpRelPath: `${pname}/${pname}.ewp`, name: pname });
      // Map the cmake-build hex path to the IAR output hex path.
      hexPathMap.set(
        `${buildDirFwd}/${pname}.hex`,
        `${destDirFwd}/${pname}/Debug/Exe/${pname}.hex`,
      );
    }

    // If the root is a UTILITY target (e.g. SignCombine), generate an IAR
    // project for it with a BUILDACTION pre-build command and workspace
    // dependencies on the executable projects.
    if (root.type === "UTILITY") {
      const scRelPath = await this.writeSignCombineProject(root, hexPathMap);
      if (scRelPath) {
        const scName = path.basename(scRelPath, ".ewp");
        projectRefs.push({
          ewpRelPath: scRelPath,
          name: scName,
          dependencies: projectRefs.map((r) => r.name),
        });
      }
    }

    const wsName = this.opts.workspaceName ?? path.basename(this.model.paths.source);
    const wsFile = path.join(this.opts.destDir, `${wsName}.eww`);
    await fs.writeFile(
      wsFile,
      renderEww({ projects: projectRefs.map((r) => ({ path: r.ewpRelPath, dependencies: r.dependencies })) }),
      "utf8",
    );

    return { workspaceFile: wsFile, projects: projectRefs.map((r) => r.ewpRelPath) };
  }

  // ----- target graph traversal -----

  private findRoot(targets: Target[]): Target | undefined {
    const referenced = new Set<string>();
    for (const t of targets) {
      for (const d of t.dependencies) referenced.add(d.id);
      for (const d of t.linkLibraries) referenced.add(d.id);
    }
    return targets.find((t) => !referenced.has(t.id));
  }

  private collectExecutables(root: Target): Target[] {
    const out: Target[] = [];
    const visited = new Set<string>();
    const walk = (t: Target): void => {
      if (visited.has(t.id)) return;
      visited.add(t.id);
      if (t.isExecutable) out.push(t);
      for (const d of t.dependencies) walk(d);
      for (const d of t.linkLibraries) walk(d);
    };
    walk(root);
    return out;
  }

  /** Flatten exe + transitive OBJECT_LIBRARY deps into a single project plan. */
  private async buildPlan(exe: Target): Promise<ProjectPlan> {
    const defines = new Set<string>();
    const includesOrdered: string[] = [];
    const includesSeen = new Set<string>();
    const absIncludeDirs: string[] = [];
    const absIncludeDirsSeen = new Set<string>();
    const sources: ProjectPlan["sources"] = [];

    const projDir = path.join(this.opts.destDir, exe.name);
    const visited = new Set<string>();

    const visit = (t: Target): void => {
      if (visited.has(t.id)) return;
      visited.add(t.id);

      for (const cg of t.compileGroups) {
        for (const d of cg.defines) defines.add(d.define);
        for (const inc of cg.includes) {
          const rebased = this.rebaseIncludeForProject(inc.path, projDir);
          if (!includesSeen.has(rebased)) {
            includesSeen.add(rebased);
            includesOrdered.push(rebased);
          }
          const absInc = path.resolve(
            path.isAbsolute(inc.path)
              ? inc.path
              : path.join(this.opts.sourceDir, inc.path),
          );
          if (!absIncludeDirsSeen.has(absInc) && this.isUnderSourceDir(absInc)) {
            absIncludeDirsSeen.add(absInc);
            absIncludeDirs.push(absInc);
          }
        }
      }
      for (const s of t.sources) {
        if (s.isGenerated) continue;
        const ext = path.extname(s.path).toLowerCase();
        if (!SOURCE_EXTS.has(ext)) continue;
        const abs = this.resolveSourcePath(s.path);
        if (!abs) continue;
        const projRel = this.computeProjectRelPath(abs);
        sources.push({
          absSource: abs,
          projectRelPath: projRel,
          group: this.groupFor(s.path, t),
        });
      }

      // Recurse into anything that contributes objects to this exe.
      for (const d of t.dependencies) {
        if (d.type === "OBJECT_LIBRARY" || d.type === "STATIC_LIBRARY") visit(d);
      }
      for (const d of t.linkLibraries) {
        if (d.type === "OBJECT_LIBRARY" || d.type === "STATIC_LIBRARY") visit(d);
      }
    };
    visit(exe);

    // Post-pass: collect asset dirs from every source file and include dir that
    // made it into the plan.  An "asset" is any subtree under
    // <sourceDir>/assets/<name>/ — if ANY file from that subtree is needed by
    // the project, the whole <name> directory must be copied.
    const assetsRoot = path.join(path.resolve(this.opts.sourceDir), "assets");
    const assetSourceDirs: string[] = [];
    const assetSourceDirsSeen = new Set<string>();

    const considerForAsset = (absPath: string): void => {
      const rel = path.relative(assetsRoot, path.resolve(absPath));
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
      const assetName = rel.split(path.sep)[0];
      if (!assetName) return;
      const assetDir = path.join(assetsRoot, assetName);
      const key = assetDir.toLowerCase();
      if (assetSourceDirsSeen.has(key)) return;
      assetSourceDirsSeen.add(key);
      assetSourceDirs.push(assetDir);
    };

    for (const s of sources) considerForAsset(s.absSource);
    for (const incDir of absIncludeDirs) considerForAsset(incDir);

    const cpu = this.detectCpu(exe);
    const chipEntry = await this.detectChipEntry(defines, cpu);
    return {
      exe,
      cpu,
      chipEntry,
      outputFile: `${IarGenerator.stripElfExt(exe.name)}.elf`,
      defines,
      includes: includesOrdered,
      absIncludeDirs,
      sources,
      assetSourceDirs,
      extraLinkFlags: this.extractExtraLinkFlags(exe),
      icfFile: this.extractIcfFile(exe),
      cmseLibOut: this.extractCmseLibOut(exe),
      cmseLibIn: this.extractCmseLibIn(exe),
    };
  }

  // ----- path / source resolution -----

  private resolveSourcePath(p: string): string | undefined {
    const abs = path.isAbsolute(p) ? p : path.resolve(this.opts.sourceDir, p);
    return abs;
  }

  private isUnderSourceDir(abs: string): boolean {
    const s = path.resolve(this.opts.sourceDir).toLowerCase();
    const a = path.resolve(abs).toLowerCase();
    return a === s || a.startsWith(s + path.sep);
  }

  /** Returns true when `absPath` is inside the `bsps/` sub-tree of the source directory. */
  private isBspPath(absPath: string): boolean {
    const bspsDir = path.join(path.resolve(this.opts.sourceDir), "bsps");
    const a = path.resolve(absPath).toLowerCase();
    const b = bspsDir.toLowerCase();
    return a === b || a.startsWith(b + path.sep);
  }

  /** Project-relative path used inside .ewp ($PROJ_DIR$/<this>). */
  private computeProjectRelPath(absSource: string): string {
    if (this.isUnderSourceDir(absSource)) {
      const rel = path.relative(path.resolve(this.opts.sourceDir), absSource);
      return path.join("src", rel).split(path.sep).join("/");
    }
    // Outside the source tree (e.g. generated, absolute include) → bucket
    // by basename under src/_external. Collisions get a numeric suffix.
    return path.join("src", "_external", path.basename(absSource))
      .split(path.sep)
      .join("/");
  }

  /** Convert an absolute include path to one usable from inside the project.
   *  Include directories that live under `bsps/` are redirected to the shared
   *  BSP directory (`$PROJ_DIR$/../bsp/src/<rel>`) so they are not duplicated
   *  inside every individual project. */
  private rebaseIncludeForProject(incPath: string, projDir: string): string {
    if (path.isAbsolute(incPath) && this.isUnderSourceDir(incPath)) {
      const rel = path.relative(path.resolve(this.opts.sourceDir), incPath);
      const relFwd = rel.split(path.sep).join("/");
      return this.isBspPath(incPath)
        ? `$PROJ_DIR$/../bsp/src/${relFwd}`
        : `$PROJ_DIR$/src/${relFwd}`;
    }
    if (!path.isAbsolute(incPath)) {
      const abs = path.resolve(this.opts.sourceDir, incPath);
      if (this.isUnderSourceDir(abs)) {
        const rel = path.relative(path.resolve(this.opts.sourceDir), abs);
        const relFwd = rel.split(path.sep).join("/");
        return this.isBspPath(abs)
          ? `$PROJ_DIR$/../bsp/src/${relFwd}`
          : `$PROJ_DIR$/src/${relFwd}`;
      }
    }
    return incPath.split(path.sep).join("/");
  }

  private groupFor(sourcePath: string, target: Target): string {
    const ext = path.extname(sourcePath).toLowerCase();
    const isHeader = [".h", ".hh", ".hpp", ".hxx", ".inc"].includes(ext);
    const prefix = isHeader ? "Header Files" : "Source Files";
    return `${prefix}/${target.name}`;
  }

  /**
   * Extract linker flags from the CMake target that are not handled natively
   * by IAR IDE project settings (CPU variant, FPU, ICF file, --silent).
   */
  private extractExtraLinkFlags(exe: Target): string[] {
    const frags = exe.link?.flags().map((f) => f.fragment.trim()).filter(Boolean) ?? [];
    const result: string[] = [];
    for (let i = 0; i < frags.length; i++) {
      const f = frags[i];
      if (f === "--silent") continue;
      if (f === "--cpu" || f === "--fpu") { i++; continue; } // skip value token
      if (f === "--config") { i++; continue; }               // --config <file>
      if (f.startsWith("--config=")) continue;               // --config=<file>
      if (f === "--import_cmse_lib_out") { i++; continue; }  // handled via IlinkTrustzoneImportLibraryOut
      if (f === "--import_cmse_lib_in") { i++; continue; }   // handled via IlinkAdditionalLibs
      result.push(f);
    }
    return result;
  }

  /** Extract and normalise the ICF file path from the --config flag. */
  private extractIcfFile(exe: Target): string | undefined {
    const frags = exe.link?.flags().map((f) => f.fragment.trim()).filter(Boolean) ?? [];
    for (let i = 0; i < frags.length; i++) {
      const f = frags[i];
      if (f.startsWith("--config=")) {
        return this.resolveLinkPath(f.slice("--config=".length));
      }
      if (f === "--config" && i + 1 < frags.length) {
        return this.resolveLinkPath(frags[i + 1]);
      }
    }
    return undefined;
  }

  /** Resolve linker path fragments in a stable way.
   *  Relative paths are first checked against the CMake source dir and then the
   *  CMake build dir, falling back to process cwd resolution only as a last
   *  resort. */
  private resolveLinkPath(rawPath: string): string {
    const unquoted = rawPath.replace(/^['"]|['"]$/g, "").trim();
    if (!unquoted) return unquoted;
    if (path.isAbsolute(unquoted)) {
      return path.resolve(unquoted).replace(/\\/g, "/");
    }

    const sourceCandidate = path.resolve(this.opts.sourceDir, unquoted);
    if (this.pathExists(sourceCandidate)) {
      return sourceCandidate.replace(/\\/g, "/");
    }

    const buildCandidate = path.resolve(this.model.paths.build, unquoted);
    if (this.pathExists(buildCandidate)) {
      return buildCandidate.replace(/\\/g, "/");
    }

    return path.resolve(unquoted).replace(/\\/g, "/");
  }

  private pathExists(p: string): boolean {
    return existsSync(p);
  }

  /** Extract and normalise the CMSE import library output path from --import_cmse_lib_out. */
  private extractCmseLibOut(exe: Target): string | undefined {
    const frags = exe.link?.flags().map((f) => f.fragment.trim()).filter(Boolean) ?? [];
    for (let i = 0; i < frags.length; i++) {
      if (frags[i] === "--import_cmse_lib_out" && i + 1 < frags.length) {
        return path.basename(frags[i + 1]);
      }
    }
    return undefined;
  }

  /** Extract and normalise the CMSE import library input path from --import_cmse_lib_in. */
  private extractCmseLibIn(exe: Target): string | undefined {
    const frags = exe.link?.flags().map((f) => f.fragment.trim()).filter(Boolean) ?? [];
    for (let i = 0; i < frags.length; i++) {
      if (frags[i] === "--import_cmse_lib_in" && i + 1 < frags.length) {
        return path.basename(frags[i + 1]);
      }
    }
    // Also check library fragments — some CMake setups add the veneer as a library.
    for (const lib of exe.link?.libraries() ?? []) {
      const frag = lib.fragment.trim();
      if (path.extname(frag).toLowerCase() === ".o" && path.basename(frag).toLowerCase().includes("veneer")) {
        return path.basename(frag);
      }
    }
    return undefined;
  }

  private detectCpu(exe: Target): string {    const flags = exe.link?.flags().map((f) => f.fragment) ?? [];
    // IAR-style: --cpu followed by the core name as the next fragment
    const cpuFlagIdx = flags.findIndex((f) => f.trim() === "--cpu");
    if (cpuFlagIdx >= 0 && cpuFlagIdx + 1 < flags.length) {
      // Strip sub-variant suffixes (e.g. "Cortex-M33.fp.no_se" → "Cortex-M33")
      return flags[cpuFlagIdx + 1].trim().replace(/\..*$/, "");
    }
    // GCC-style: -mcpu=cortex-m33
    for (const f of flags) {
      const m = /-mcpu=(cortex-m\d+)/i.exec(f);
      if (m) {
        const core = m[1].toLowerCase();
        if (core === "cortex-m33") return "Cortex-M33";
        if (core === "cortex-m55") return "Cortex-M55";
        if (core === "cortex-m4") return "Cortex-M4";
        if (core === "cortex-m7") return "Cortex-M7";
        if (core === "cortex-m0plus") return "Cortex-M0+";
        return core.replace(/cortex-/i, "Cortex-").toUpperCase();
      }
    }
    return "Cortex-M33";
  }

  // ----- device detection -----

  private async detectChipEntry(defines: Set<string>, cpu: string): Promise<string | undefined> {
    if (!this.iarDevicesDir) return undefined;
    const deviceBase = this.detectDeviceBase(defines);
    if (!deviceBase) return undefined;
    const coreShort = cpu === "Cortex-M33" ? "M33" : cpu === "Cortex-M55" ? "M55" : undefined;
    if (!coreShort) return undefined;
    const deviceName = `${deviceBase}${coreShort}`;
    const menuContent = await this.findMenuFile(this.iarDevicesDir, `${deviceName}.menu`);
    if (!menuContent) return undefined;
    const tagMatch = /<tag>([^<]+)<\/tag>/.exec(menuContent);
    const displayMatch = /<display>([^<]+)<\/display>/.exec(menuContent);
    if (!tagMatch || !displayMatch) return undefined;
    return `${tagMatch[1]}\t${displayMatch[1]}`;
  }

  /** Match alphanumeric-only defines that look like device part numbers:
   *  2–5 uppercase letters, 2–4 digits, then 3+ uppercase letters/digits, no underscores. */
  private detectDeviceBase(defines: Set<string>): string | undefined {
    const devicePnPattern = /^[A-Z]{2,5}[0-9]{2,4}[A-Z0-9]{3,}$/;
    for (const d of defines) {
      if (devicePnPattern.test(d)) return d;
    }
    return undefined;
  }

  /** Locate the IAR devices directory by finding iccarm on PATH. */
  private async findIarDevicesDir(): Promise<string | undefined> {
    const exeName = process.platform === "win32" ? "iccarm.exe" : "iccarm";
    const pathEnv = process.env.PATH ?? process.env.Path ?? "";
    for (const dir of pathEnv.split(path.delimiter)) {
      try {
        await fs.access(path.join(dir, exeName));
        return path.join(path.dirname(dir), "config", "devices");
      } catch { /* not in this directory */ }
    }
    return undefined;
  }

  /** Recursively search `dir` for a file named `filename` (depth-limited). */
  private async findMenuFile(dir: string, filename: string, depth = 0): Promise<string | undefined> {
    if (depth > 6) return undefined;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const result = await this.findMenuFile(path.join(dir, entry.name), filename, depth + 1);
        if (result !== undefined) return result;
      } else if (entry.name === filename) {
        return fs.readFile(path.join(dir, entry.name), "utf-8");
      }
    }
    return undefined;
  }

  // ----- output -----

  private static stripElfExt(name: string): string {
    return name.endsWith(".elf") ? name.slice(0, -4) : name;
  }

  private async writeProject(plan: ProjectPlan, cmseLibIn?: string): Promise<void> {
    const projName = IarGenerator.stripElfExt(plan.exe.name);
    const projDir = path.join(this.opts.destDir, projName);
    await fs.mkdir(projDir, { recursive: true });

    // Shared BSP directory at the workspace root — one copy for all projects.
    const bspDir = path.join(this.opts.destDir, "bsp");

    const copied = new Set<string>();
    const files: IarFileEntry[] = [];
    for (const s of plan.sources) {
      const isBsp = this.isBspPath(s.absSource);
      const fileBase = isBsp ? bspDir : projDir;
      const ewpRelPath = isBsp ? `../bsp/${s.projectRelPath}` : s.projectRelPath;
      const destAbs = path.join(fileBase, s.projectRelPath);
      if (copied.has(destAbs)) continue;
      copied.add(destAbs);
      try {
        await fs.mkdir(path.dirname(destAbs), { recursive: true });
        await fs.copyFile(s.absSource, destAbs);
        files.push({ projectRelPath: ewpRelPath, group: s.group });
      } catch (err) {
        // Skip files that can't be located on disk (often generated).
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    // Build a quick lookup for asset directories so we can skip them in the
    // companion scan (they are handled in full by copyAssetDir below).
    const assetDirSetLower = new Set(
      plan.assetSourceDirs.map((d) => path.resolve(d).toLowerCase()),
    );
    const isUnderAssetDir = (absDir: string): boolean => {
      const lower = path.resolve(absDir).toLowerCase();
      for (const ad of assetDirSetLower) {
        if (lower === ad || lower.startsWith(ad + path.sep)) return true;
      }
      return false;
    };

    // Copy header and companion source files that sit alongside copied sources
    // (e.g. user-customizable stubs not listed in target_sources).
    // Skipped for asset dirs — those are copied in full below.
    // BSP dirs are redirected to the shared bsp/ directory.
    const scannedDirs = new Set<string>();
    for (const s of plan.sources) {
      const srcDir = path.dirname(s.absSource);
      if (scannedDirs.has(srcDir)) continue;
      if (isUnderAssetDir(srcDir)) continue;
      scannedDirs.add(srcDir);

      let entries: Dirent[];
      try {
        entries = await fs.readdir(srcDir, { withFileTypes: true });
      } catch {
        continue;
      }

      const isBspDir = this.isBspPath(srcDir);
      const fileBase = isBspDir ? bspDir : projDir;
      const ewpDirPrefix = isBspDir ? "../bsp/" : "";
      const destRelDir = path.posix.dirname(s.projectRelPath);
      const headerGroup = s.group.replace(/^Source Files\//, "Header Files/");

      for (const entry of entries) {
        if (entry.isDirectory()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        const isHeader = HEADER_EXTS.has(ext);
        const isSource = !isHeader && SOURCE_EXTS.has(ext);
        if (!isHeader && !isSource) continue;
        const absFile = path.join(srcDir, entry.name);
        const relFile = `${destRelDir}/${entry.name}`;
        const destFile = path.join(fileBase, relFile);
        if (copied.has(destFile)) continue;
        copied.add(destFile);
        const group = isHeader ? headerGroup : s.group;
        try {
          await fs.mkdir(path.dirname(destFile), { recursive: true });
          await fs.copyFile(absFile, destFile);
          files.push({ projectRelPath: `${ewpDirPrefix}${relFile}`, group });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    }

    // Copy each complete asset directory so all asset files are present in the
    // IAR project, including files that participate via #include but are not
    // listed in CMakeLists.txt.  Destination: PROJNAME/src/assets/<name>/
    // Only cmake-listed sources (already in `files`) appear in the .ewp.
    for (const assetDir of plan.assetSourceDirs) {
      await this.copyAssetDir(assetDir, projDir, copied);
    }

    // Recursively copy all headers from every include directory under the source tree.
    // BSP include directories are redirected to the shared bsp/ directory.
    for (const absIncDir of plan.absIncludeDirs) {
      if (this.isBspPath(absIncDir)) {
        await this.copyHeadersRecursive(absIncDir, projDir, copied, files, bspDir, "../bsp/");
      } else {
        await this.copyHeadersRecursive(absIncDir, projDir, copied, files);
      }
    }

    // Copy ICF file directory (and siblings, to satisfy ICF include directives)
    // when the file lives inside the source tree, then produce a $PROJ_DIR$-
    // relative reference.  ICF files in the BSP are redirected to the shared
    // bsp/ directory and referenced via $PROJ_DIR$/../bsp/src/...
    let icfFile = plan.icfFile;
    if (icfFile && this.isUnderSourceDir(icfFile)) {
      await this.copyDirToProject(path.dirname(icfFile), projDir, copied, bspDir);
      if (this.isBspPath(icfFile)) {
        const rel = path.relative(path.resolve(this.opts.sourceDir), path.resolve(icfFile)).replace(/\\/g, "/");
        icfFile = `$PROJ_DIR$/../bsp/src/${rel}`;
      } else {
        icfFile = this.rebaseSourceDirRefs(icfFile);
      }
    }

    // Rebase any source-dir absolute paths embedded in preprocessor defines
    // (e.g. CLM_IMAGE_NAME, FW_IMAGE_NAME, NVRAM_IMAGE_NAME) so they point
    // into the copied $PROJ_DIR$/src/ tree instead of the original CMake dir.
    const rebasedDefines = [...plan.defines].sort().map((d) => this.rebaseSourceDirRefs(d));

    // Rebase source-dir paths in extra linker flags (e.g. --image_input=...).
    const rebasedLinkFlags = (plan.extraLinkFlags ?? []).map((f) => this.rebaseSourceDirRefs(f));

    const ewpInput: IarEwpInput = {
      projectName: projName,
      cpuVariant: plan.cpu,
      chipMenuEntry: plan.chipEntry,
      outputFile: plan.outputFile,
      defines: rebasedDefines,
      includePaths: plan.includes,
      files,
      useClibSupport: plan.defines.has("COMPONENT_MW_CLIB_SUPPORT"),
      generateHex: true,
      extraLinkFlags: rebasedLinkFlags,
      icfFile,
      // Use an IAR project-relative path so the secure project writes the veneer
      // to a predictable location within its own output directory.
      cmseLibOut: plan.cmseLibOut
        ? `$PROJ_DIR$/Debug/Exe/${path.basename(plan.cmseLibOut)}`
        : undefined,
      cmseLibIn,
    };
    const ewpPath = path.join(projDir, `${projName}.ewp`);
    await fs.writeFile(ewpPath, renderEwp(ewpInput), "utf8");
  }

  /**
   * Generate a no-source IAR project for a UTILITY target (e.g. SignCombine).
   * The BUILDACTION pre-build command is extracted from build.ninja.
   * Returns the workspace-relative .ewp path, or undefined on failure.
   */
  private async writeSignCombineProject(root: Target, hexPathMap: Map<string, string>): Promise<string | undefined> {
    const projName = "signed-image";
    const projDir = path.join(this.opts.destDir, projName);
    await fs.mkdir(projDir, { recursive: true });

    // Find the custom command artifact by looking for .rule sources outside CMakeFiles/
    const artifact = root.sources
      .filter(
        (s) =>
          s.isGenerated &&
          s.path.endsWith(".rule") &&
          !s.path.replace(/\\/g, "/").includes("/CMakeFiles/"),
      )
      .map((s) => path.basename(s.path, ".rule"))
      .find(Boolean);

    let command = artifact ? await this.extractNinjaCommand(artifact) : undefined;
    if (command) {
      for (const [cmakePath, iarPath] of hexPathMap) {
        command = command.split(cmakePath).join(iarPath);
      }
      command = await this.processSignCombineCommand(command, projDir);
    }

    const ewpInput: IarEwpInput = {
      projectName: projName,
      cpuVariant: "Cortex-M33",
      outputFile: `${projName}.elf`,
      defines: [],
      includePaths: [],
      files: [],
      buildActionCommand: command,
    };
    const ewpPath = path.join(projDir, `${projName}.ewp`);
    await fs.writeFile(ewpPath, renderEwp(ewpInput), "utf8");
    return `${projName}/${projName}.ewp`;
  }

  /**
   * Transform a raw ninja COMMAND string into a clean IAR pre-build action:
   *  1. Unwrap any `cmd.exe /C "cd /D <dir> && <actual>"` shell wrapper.
   *  2. Replace the full path to edgeprotecttools.exe with just the executable name.
   *  3. Copy any JSON config file referenced via `-i <path>` into projDir and
   *     rewrite its path as `$PROJ_DIR$/<filename>`.
   *  4. Replace all remaining CMake build-directory references with `$PROJ_DIR$`.
   */
  private async processSignCombineCommand(command: string, projDir: string): Promise<string> {
    // 1. Unwrap: cmd.exe /C "cd /D <dir> && <actual command>"
    const wrapMatch = /^.*cmd(?:\.exe)?\s+\/C\s+"cd\s+\/D\s+[^&]+&&\s+(.*)"$/i.exec(command.trim());
    let cmd = wrapMatch ? wrapMatch[1].trim() : command;

    // 2. Strip the full path prefix from edgeprotecttools.exe.
    cmd = cmd.replace(/(?:[^"'\s]*[/\\])+edgeprotecttools\.exe\b/gi, "edgeprotecttools.exe");

    // 3. Find, copy, and redirect the JSON config file.
    const jsonMatch = /\s+-i\s+("?)([^\s"]+\.json)\1/.exec(cmd);
    if (jsonMatch) {
      const [fullMatch, quote, jsonArg] = jsonMatch;
      const jsonSrcPath = jsonArg.replace(/\//g, path.sep);
      const jsonFileName = path.basename(jsonSrcPath);
      const jsonDestPath = path.join(projDir, jsonFileName);
      try {
        await fs.copyFile(jsonSrcPath, jsonDestPath);
      } catch { /* best-effort; skip if file not accessible */ }
      const projDirRef = `$PROJ_DIR$/${jsonFileName}`;
      cmd = cmd.slice(0, jsonMatch.index) +
        cmd.slice(jsonMatch.index).replace(fullMatch, ` -i ${quote}${projDirRef}${quote}`);
    }

    // 4. Replace all remaining CMake build-dir references with $PROJ_DIR$.
    const buildDirFwd = this.model.paths.build.replace(/\\/g, "/");
    cmd = cmd.split(buildDirFwd + "/").join("$PROJ_DIR$/");
    cmd = cmd.split(buildDirFwd).join("$PROJ_DIR$");
    // Also handle native backslash form in case it appears.
    const buildDirBack = this.model.paths.build.replace(/\//g, "\\");
    cmd = cmd.split(buildDirBack + "\\").join("$PROJ_DIR$/");
    cmd = cmd.split(buildDirBack).join("$PROJ_DIR$");

    return cmd;
  }

  /**
   * Parse build.ninja to extract the COMMAND variable from the CUSTOM_COMMAND
   * build block that produces the named artifact.
   */
  private async extractNinjaCommand(artifact: string): Promise<string | undefined> {
    const ninjaPath = path.join(this.model.paths.build, "build.ninja");
    let content: string;
    try {
      content = await fs.readFile(ninjaPath, "utf-8");
    } catch {
      return undefined;
    }

    const lines = content.split(/\r?\n/);
    let inBlock = false;
    for (const line of lines) {
      if (!inBlock) {
        // Match "build <outputs>: CUSTOM_COMMAND ..." where outputs include our artifact
        if (line.startsWith("build ") && line.includes("CUSTOM_COMMAND")) {
          const colonIdx = line.indexOf(": CUSTOM_COMMAND");
          const outputsPart = line.slice("build ".length, colonIdx);
          // Outputs may include implicit outputs separated by "|"
          const outputs = outputsPart.split(/\s*\|\s*|\s+/).filter(Boolean);
          if (outputs.some((o) => path.basename(o.replace(/\\/g, "/")) === artifact)) {
            inBlock = true;
          }
        }
      } else {
        if (line !== "" && !line.startsWith(" ") && !line.startsWith("\t")) {
          break; // end of indented block
        }
        const m = /^\s+COMMAND\s*=\s*(.+)$/.exec(line);
        if (m) return m[1].trim();
      }
    }
    return undefined;
  }

  /**
   * Replace all occurrences of the CMake source root in `text` with the
   * project-relative prefix `$PROJ_DIR$/src`, normalising any `../` segments
   * that may appear in the embedded path.  Handles both forward and backward
   * slash forms of the source root.
   */
  private rebaseSourceDirRefs(text: string): string {
    const srcAbs = path.resolve(this.opts.sourceDir).replace(/\\/g, "/");
    // Also handle the backslash form that may appear in CMake-generated strings
    // on Windows.
    const srcAbsBwd = srcAbs.replace(/\//g, "\\");

    // Inner helper: given the portion of the path *after* the source-root
    // prefix, normalise `../` segments and build the replacement string.
    const buildReplacement = (rest: string): string => {
      const combined = srcAbs + rest.replace(/\\/g, "/");
      const parts = combined.split("/");
      const normalised: string[] = [];
      for (const p of parts) {
        if (p === "..") normalised.pop();
        else if (p !== ".") normalised.push(p);
      }
      const fullNorm = normalised.join("/");
      const rel = fullNorm.slice(srcAbs.length).replace(/^\//, "");
      return `$PROJ_DIR$/src/${rel}`;
    };

    // Build a case-insensitive regex that matches the source root followed by
    // any path continuation (path separators and non-whitespace/non-delimiter).
    const escFwd = srcAbs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let result = text.replace(
      new RegExp(escFwd + "([^<>&\"\\s]*)", "gi"),
      (_match, rest: string) => buildReplacement(rest),
    );

    // Also handle the backslash variant if it differs.
    if (srcAbsBwd !== srcAbs) {
      const escBwd = srcAbsBwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(
        new RegExp(escBwd + "([^<>&\"\\s]*)", "gi"),
        (_match, rest: string) => buildReplacement(rest),
      );
    }

    return result;
  }

  /**
   * Copy an entire directory tree from the source tree into the IAR project
   * using the same `src/<relative>` layout as all other source files.
   * Files that live under the BSP tree are redirected to `bspDir` when provided.
   */
  private async copyDirToProject(
    absDirPath: string,
    projDir: string,
    copied: Set<string>,
    bspDir?: string,
  ): Promise<void> {
    if (!this.isUnderSourceDir(absDirPath)) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(absDirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absChild = path.join(absDirPath, entry.name);
      if (entry.isDirectory()) {
        await this.copyDirToProject(absChild, projDir, copied, bspDir);
      } else {
        const relPath = this.computeProjectRelPath(absChild);
        const isBsp = bspDir !== undefined && this.isBspPath(absChild);
        const targetDir = isBsp ? bspDir : projDir;
        const destAbs = path.join(targetDir, relPath);
        if (copied.has(destAbs)) continue;
        copied.add(destAbs);
        try {
          await fs.mkdir(path.dirname(destAbs), { recursive: true });
          await fs.copyFile(absChild, destAbs);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    }
  }

  /**
   * Recursively copies every file in an asset directory into the IAR project
   * (destination determined by computeProjectRelPath).
   * Does NOT add entries to the .ewp file list — only cmake-listed sources
   * (already added from plan.sources) appear in the project.
   */
  private async copyAssetDir(
    srcDir: string,
    projDir: string,
    copied: Set<string>,
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(srcDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absSrc = path.join(srcDir, entry.name);
      if (entry.isDirectory()) {
        await this.copyAssetDir(absSrc, projDir, copied);
      } else {
        const relPath = this.computeProjectRelPath(absSrc);
        const destAbs = path.join(projDir, relPath);
        if (copied.has(destAbs)) continue;
        copied.add(destAbs);
        try {
          await fs.mkdir(path.dirname(destAbs), { recursive: true });
          await fs.copyFile(absSrc, destAbs);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    }
  }

  private async copyHeadersRecursive(
    absDir: string,
    projDir: string,
    copied: Set<string>,
    files: IarFileEntry[],
    destDir?: string,
    ewpPrefix?: string,
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    const fileBase = destDir ?? projDir;
    const prefix = ewpPrefix ?? "";
    for (const entry of entries) {
      const absEntry = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await this.copyHeadersRecursive(absEntry, projDir, copied, files, destDir, ewpPrefix);
      } else if (HEADER_EXTS.has(path.extname(entry.name).toLowerCase())) {
        const relPath = this.computeProjectRelPath(absEntry);
        const destAbs = path.join(fileBase, relPath);
        if (copied.has(destAbs)) continue;
        copied.add(destAbs);
        try {
          await fs.mkdir(path.dirname(destAbs), { recursive: true });
          await fs.copyFile(absEntry, destAbs);
          files.push({ projectRelPath: `${prefix}${relPath}`, group: "Header Files" });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    }
  }
}
