/**
 * Orchestrates generation of a Keil µVision workspace from a CMake codemodel.
 *
 * For each EXECUTABLE target reachable from the root:
 *   1. Flattens the executable's own sources plus those of every
 *      OBJECT_LIBRARY / STATIC_LIBRARY transitively reachable via deps.
 *   2. Copies referenced source files into `dest/<exe-name>/src/`, preserving
 *      the path relative to the CMake source directory.
 *   3. Writes one .uvprojx per executable and a single .uvmpw workspace.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CMakeModel, Target } from "../cmake/index.js";
import {
  renderUvprojx,
  fileTypeFromExtension,
  UVisionFileType,
  type UVisionFileEntry,
  type UVisionProjectInput,
} from "./uvprojx.js";
import { renderUvmpw } from "./uvmpw.js";

export interface UVisionGeneratorOptions {
  sourceDir: string;
  destDir: string;
  workspaceName?: string;
}

// Source extensions we care about
const SOURCE_EXTS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".c++",
  ".s", ".S", ".asm",
  ".h", ".hpp", ".hh", ".hxx", ".inc",
]);

const HEADER_EXTS = new Set([".h", ".hh", ".hpp", ".hxx", ".inc"]);

interface ProjectPlan {
  exe: Target;
  cpu: string;
  outputName: string;
  defines: Set<string>;
  includes: string[];
  absIncludeDirs: string[];
  sources: Array<{
    absSource: string;
    /** Path relative to the project directory (used as FilePath in .uvprojx). */
    projectRelPath: string;
    group: string;
  }>;
  scatterFile?: string;
  miscLinker: string;
}

export class UVisionGenerator {
  constructor(
    private readonly model: CMakeModel,
    private readonly opts: UVisionGeneratorOptions,
  ) {}

  async generate(): Promise<{ workspaceFile: string; projects: string[] }> {
    const cfg = this.model.defaultConfiguration;
    if (!cfg) throw new Error("CMake model has no configurations");

    const root = this.findRoot(cfg.targets);
    if (!root) throw new Error("Could not determine a root target");

    const executables = this.collectExecutables(root);
    if (executables.length === 0) {
      throw new Error(`No EXECUTABLE targets reachable from ${root.name}`);
    }

    await fs.mkdir(this.opts.destDir, { recursive: true });

    const projectRefs: Array<{ uvprojxRelPath: string; name: string }> = [];

    for (const exe of executables) {
      const plan = await this.buildPlan(exe);
      await this.writeProject(plan);
      const pname = stripElfExt(exe.name);
      projectRefs.push({ uvprojxRelPath: `${pname}/${pname}.uvprojx`, name: pname });
    }

    const wsName =
      this.opts.workspaceName ??
      stripElfExt(root.name).replace(/[^\w.-]+/g, "_");
    const wsFile = path.join(this.opts.destDir, `${wsName}.uvmpw`);
    await fs.writeFile(
      wsFile,
      renderUvmpw({ projects: projectRefs.map((r) => ({ path: r.uvprojxRelPath })) }),
      "utf8",
    );

    return {
      workspaceFile: wsFile,
      projects: projectRefs.map((r) => r.uvprojxRelPath),
    };
  }

  // ---------------------------------------------------------------------------
  // Target graph traversal
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Plan construction
  // ---------------------------------------------------------------------------

  private async buildPlan(exe: Target): Promise<ProjectPlan> {
    const defines = new Set<string>();
    const includesOrdered: string[] = [];
    const includesSeen = new Set<string>();
    const absIncludeDirs: string[] = [];
    const absIncludeDirsSeen = new Set<string>();
    const sources: ProjectPlan["sources"] = [];

    const projDir = path.join(this.opts.destDir, stripElfExt(exe.name));
    const visited = new Set<string>();

    const visit = (t: Target): void => {
      if (visited.has(t.id)) return;
      visited.add(t.id);

      for (const cg of t.compileGroups) {
        for (const d of cg.defines) defines.add(d.define);
        for (const inc of cg.includes) {
          const rebased = this.rebaseInclude(inc.path, projDir);
          if (!includesSeen.has(rebased)) {
            includesSeen.add(rebased);
            includesOrdered.push(rebased);
          }
          const absInc = path.isAbsolute(inc.path)
            ? inc.path
            : path.resolve(this.opts.sourceDir, inc.path);
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

      for (const d of t.dependencies) {
        if (d.type === "OBJECT_LIBRARY" || d.type === "STATIC_LIBRARY") visit(d);
      }
      for (const d of t.linkLibraries) {
        if (d.type === "OBJECT_LIBRARY" || d.type === "STATIC_LIBRARY") visit(d);
      }
    };
    visit(exe);

    const cpu = this.detectCpu(exe);
    const { scatterFile, miscLinker } = this.extractLinkerInfo(exe, projDir);

    return {
      exe,
      cpu,
      outputName: stripElfExt(exe.name),
      defines,
      includes: includesOrdered,
      absIncludeDirs,
      sources,
      scatterFile,
      miscLinker,
    };
  }

  // ---------------------------------------------------------------------------
  // Path helpers
  // ---------------------------------------------------------------------------

  private resolveSourcePath(p: string): string | undefined {
    return path.isAbsolute(p) ? p : path.resolve(this.opts.sourceDir, p);
  }

  private isUnderSourceDir(abs: string): boolean {
    const s = path.resolve(this.opts.sourceDir).toLowerCase();
    const a = path.resolve(abs).toLowerCase();
    return a === s || a.startsWith(s + path.sep);
  }

  /** Project-relative path used as FilePath in .uvprojx ("./src/..."). */
  private computeProjectRelPath(absSource: string): string {
    if (this.isUnderSourceDir(absSource)) {
      const rel = path.relative(path.resolve(this.opts.sourceDir), absSource);
      return "./" + path.join("src", rel).split(path.sep).join("/");
    }
    return "./" + path.join("src", "_external", path.basename(absSource)).split(path.sep).join("/");
  }

  /** Rebase an include path so it is relative to the project directory. */
  private rebaseInclude(incPath: string, projDir: string): string {
    if (path.isAbsolute(incPath) && this.isUnderSourceDir(incPath)) {
      const rel = path.relative(path.resolve(this.opts.sourceDir), incPath);
      return "./src/" + rel.split(path.sep).join("/");
    }
    if (!path.isAbsolute(incPath)) {
      const abs = path.resolve(this.opts.sourceDir, incPath);
      if (this.isUnderSourceDir(abs)) {
        const rel = path.relative(path.resolve(this.opts.sourceDir), abs);
        return "./src/" + rel.split(path.sep).join("/");
      }
    }
    // Absolute path outside source tree — keep as-is (forward slashes)
    return incPath.split(path.sep).join("/");
  }

  private groupFor(sourcePath: string, target: Target): string {
    const ext = path.extname(sourcePath).toLowerCase();
    const isHeader = HEADER_EXTS.has(ext);
    return `${isHeader ? "Header Files" : "Source Files"}/${target.name}`;
  }

  // ---------------------------------------------------------------------------
  // CPU detection
  // ---------------------------------------------------------------------------

  private detectCpu(exe: Target): string {
    // GCC-style: -mcpu=cortex-m33
    const allFlags = [
      ...(exe.link?.flags().map((f) => f.fragment) ?? []),
      ...exe.compileGroups.flatMap((cg) => cg.flags.map((f) => f.fragment)),
    ];
    for (const f of allFlags) {
      const m = /-mcpu=(cortex-m[\w+]+)/i.exec(f);
      if (m) {
        const core = m[1].toLowerCase();
        if (core === "cortex-m0")    return "Cortex-M0";
        if (core === "cortex-m0plus" || core === "cortex-m0+") return "Cortex-M0+";
        if (core === "cortex-m1")    return "Cortex-M1";
        if (core === "cortex-m3")    return "Cortex-M3";
        if (core === "cortex-m4")    return this.detectM4Variant(allFlags);
        if (core === "cortex-m7")    return this.detectM7Variant(allFlags);
        if (core === "cortex-m23")   return "Cortex-M23";
        if (core === "cortex-m33")   return "Cortex-M33";
        if (core === "cortex-m35p")  return "Cortex-M35P";
        if (core === "cortex-m55")   return "Cortex-M55";
        if (core === "cortex-m85")   return "Cortex-M85";
        // Fallback: capitalise
        return "Cortex-" + m[1].slice("cortex-".length).toUpperCase();
      }
      // IAR-style: --cpu Cortex-M33
      const iar = /--cpu[=\s]+(Cortex-\w+)/i.exec(f);
      if (iar) return iar[1].replace(/\..*$/, "");
    }
    return "Cortex-M33";
  }

  private detectM4Variant(flags: string[]): string {
    const hasFpu = flags.some((f) => /-mfpu=/i.test(f) || /-mfloat-abi=hard/i.test(f));
    return hasFpu ? "Cortex-M4F" : "Cortex-M4";
  }

  private detectM7Variant(flags: string[]): string {
    const hasFpu = flags.some((f) => /-mfpu=/i.test(f) || /-mfloat-abi=hard/i.test(f));
    return hasFpu ? "Cortex-M7F" : "Cortex-M7";
  }

  // ---------------------------------------------------------------------------
  // Linker info extraction
  // ---------------------------------------------------------------------------

  /**
   * Extract scatter file and misc linker options from GCC-style link flags.
   *
   * - If a `.sct` scatter file is found, it is used directly.
   * - If a GCC `.ld` linker script is found and a sibling `.sct` file exists,
   *   the `.sct` is used.
   * - Otherwise the linker script path is forwarded to miscLinker.
   */
  private extractLinkerInfo(
    exe: Target,
    projDir: string,
  ): { scatterFile?: string; miscLinker: string } {
    const frags = exe.link?.fragments.map((f) => f.fragment.trim()).filter(Boolean) ?? [];
    const misc: string[] = [];
    let linkerScript: string | undefined;

    for (let i = 0; i < frags.length; i++) {
      const f = frags[i];
      // -T <file> or -T<file>
      if (f === "-T" && i + 1 < frags.length) {
        linkerScript = frags[++i];
        continue;
      }
      if (f.startsWith("-T") && f.length > 2) {
        linkerScript = f.slice(2);
        continue;
      }
      // -Wl,-T,<file> or -Wl,-T<file>
      const wlMatch = /^-Wl,-T,?(.+)$/.exec(f);
      if (wlMatch) {
        linkerScript = wlMatch[1];
        continue;
      }
      // Skip flags already handled natively by Keil
      if (/^-mcpu=/i.test(f)) continue;
      if (/^-mfpu=/i.test(f)) continue;
      if (/^-mfloat-abi=/i.test(f)) continue;
      if (f === "-mthumb") continue;
      if (f === "--specs=nosys.specs" || f === "--specs=nano.specs") continue;
      misc.push(f);
    }

    if (linkerScript) {
      const absLinker = path.isAbsolute(linkerScript)
        ? linkerScript
        : path.resolve(this.opts.sourceDir, linkerScript);

      // Prefer .sct in the same directory as the linker script
      const ext = path.extname(absLinker).toLowerCase();
      if (ext === ".sct" || ext === ".scf") {
        return {
          scatterFile: this.makeProjectRelative(absLinker, projDir),
          miscLinker: misc.join(" "),
        };
      }
      // Look for a sibling .sct file
      const sctPath = absLinker.replace(/\.[^.]+$/, ".sct");
      // We don't do async here — we check at write time; stash the abs path
      // so writeProject can resolve it.
      // Pass both as a special marker for writeProject to resolve.
      return {
        scatterFile: this.makeProjectRelative(absLinker, projDir) + ":::pending_sct_check",
        miscLinker: misc.join(" "),
      };
    }

    return { miscLinker: misc.join(" ") };
  }

  private makeProjectRelative(absPath: string, projDir: string): string {
    if (this.isUnderSourceDir(absPath)) {
      const rel = path.relative(path.resolve(this.opts.sourceDir), absPath);
      return "./src/" + rel.split(path.sep).join("/");
    }
    // Try relative to project dir
    try {
      const rel = path.relative(projDir, absPath);
      return "./" + rel.split(path.sep).join("/");
    } catch {
      return absPath.split(path.sep).join("/");
    }
  }

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------

  private async writeProject(plan: ProjectPlan): Promise<void> {
    const projName = plan.outputName;
    const projDir = path.join(this.opts.destDir, projName);
    await fs.mkdir(projDir, { recursive: true });

    // Resolve pending scatter file (.sct sibling check)
    let scatterFile = plan.scatterFile;
    if (scatterFile?.endsWith(":::pending_sct_check")) {
      const projRelLd = scatterFile.slice(0, -":::pending_sct_check".length);
      // Convert back to absolute to look for .sct sibling
      const absLd = path.resolve(projDir, projRelLd.replace(/^\.\//, "").split("/").join(path.sep));
      const absSct = absLd.replace(/\.[^.]+$/, ".sct");
      try {
        await fs.access(absSct);
        scatterFile = this.makeProjectRelative(absSct, projDir);
      } catch {
        // .sct not found — drop scatter file, keep ld path in misc (already handled)
        scatterFile = undefined;
      }
    }

    const copied = new Set<string>();
    const files: UVisionFileEntry[] = [];

    for (const s of plan.sources) {
      const destAbs = path.join(projDir, s.projectRelPath.replace(/^\.\//, "").split("/").join(path.sep));
      if (copied.has(destAbs)) continue;
      copied.add(destAbs);
      try {
        await fs.mkdir(path.dirname(destAbs), { recursive: true });
        await fs.copyFile(s.absSource, destAbs);
        files.push({
          fileName: path.basename(s.absSource),
          fileType: fileTypeFromExtension(s.absSource),
          filePath: s.projectRelPath,
          group: s.group,
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    // Copy header files that sit alongside copied source files
    const scannedDirs = new Set<string>();
    for (const s of plan.sources) {
      const srcDir = path.dirname(s.absSource);
      if (scannedDirs.has(srcDir)) continue;
      scannedDirs.add(srcDir);

      let entries: string[];
      try {
        entries = await fs.readdir(srcDir);
      } catch {
        continue;
      }

      const destRelDir = path.posix.dirname(s.projectRelPath);
      const headerGroup = s.group.replace(/^Source Files\//, "Header Files/");

      for (const entry of entries) {
        if (!HEADER_EXTS.has(path.extname(entry).toLowerCase())) continue;
        const absHeader = path.join(srcDir, entry);
        const relHeader = `${destRelDir}/${entry}`;
        const destHeader = path.join(projDir, relHeader.replace(/^\.\//, "").split("/").join(path.sep));
        if (copied.has(destHeader)) continue;
        copied.add(destHeader);
        try {
          await fs.mkdir(path.dirname(destHeader), { recursive: true });
          await fs.copyFile(absHeader, destHeader);
          files.push({
            fileName: entry,
            fileType: UVisionFileType.Document,
            filePath: relHeader,
            group: headerGroup,
          });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    }

    // Recursively copy headers from include directories inside the source tree
    for (const absIncDir of plan.absIncludeDirs) {
      await this.copyHeadersRecursive(absIncDir, projDir, copied, files);
    }

    // Copy scatter file into project directory if it exists under sourceDir
    if (scatterFile && !scatterFile.startsWith(":::")) {
      const absScatter = path.resolve(projDir, scatterFile.replace(/^\.\//, "").split("/").join(path.sep));
      const scatterName = path.basename(absScatter);
      const destScatter = path.join(projDir, scatterName);
      if (!copied.has(destScatter)) {
        try {
          await fs.copyFile(absScatter, destScatter);
          copied.add(destScatter);
          files.push({
            fileName: scatterName,
            fileType: UVisionFileType.Linker,
            filePath: `./${scatterName}`,
            group: "Linker Files",
          });
          // Update scatter file to local copy
          scatterFile = `./${scatterName}`;
        } catch {
          // Best-effort: use original path
        }
      }
    }

    const input: UVisionProjectInput = {
      projectName: projName,
      cpuVariant: plan.cpu,
      defines: [...plan.defines].sort(),
      includePaths: plan.includes,
      files,
      scatterFile: scatterFile?.startsWith(":::") ? undefined : scatterFile,
      miscLinker: plan.miscLinker || undefined,
    };

    const uvprojxPath = path.join(projDir, `${projName}.uvprojx`);
    await fs.writeFile(uvprojxPath, renderUvprojx(input), "utf8");
  }

  /** Recursively copy all .h/.hpp files from absDir under the project src dir. */
  private async copyHeadersRecursive(
    absDir: string,
    projDir: string,
    copied: Set<string>,
    files: UVisionFileEntry[],
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    const relFromSrc = path.relative(path.resolve(this.opts.sourceDir), absDir);
    const projRelDir = "./" + path.join("src", relFromSrc).split(path.sep).join("/");

    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await this.copyHeadersRecursive(abs, projDir, copied, files);
      } else if (HEADER_EXTS.has(path.extname(entry.name).toLowerCase())) {
        const destRel = `${projRelDir}/${entry.name}`;
        const destAbs = path.join(projDir, destRel.replace(/^\.\//, "").split("/").join(path.sep));
        if (copied.has(destAbs)) continue;
        copied.add(destAbs);
        try {
          await fs.mkdir(path.dirname(destAbs), { recursive: true });
          await fs.copyFile(abs, destAbs);
          files.push({
            fileName: entry.name,
            fileType: UVisionFileType.Document,
            filePath: destRel,
            group: "Header Files",
          });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    }
  }
}

function stripElfExt(name: string): string {
  return name.endsWith(".elf") ? name.slice(0, -4) : name;
}
