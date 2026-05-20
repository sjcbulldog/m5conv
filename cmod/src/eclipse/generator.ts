/**
 * Eclipse CDT Managed Build project generator.
 *
 * For each EXECUTABLE target in the CMake model, produces a self-contained
 * Eclipse project in a sub-directory of `destDir`:
 *
 *   destDir/<targetName>/.project
 *   destDir/<targetName>/.cproject
 *   destDir/<targetName>/<source-tree-mirror>/...
 *
 * Source files and project-local include directories are copied from the CMake
 * source tree into the Eclipse project directory, preserving their relative
 * path structure from the CMake source root.  External include paths (SDK /
 * toolchain headers outside the source root) are kept as absolute references
 * in .cproject.  Linker scripts are copied to the project root.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CMakeModel, Target } from '../cmake/index.js';
import type { IBackend, BackendOptions } from '../backend.js';
import { renderProject } from './project.js';
import { renderCproject, type EclipseCprojectInput } from './cproject.js';

// ---------------------------------------------------------------------------
// Data-extraction helpers
// ---------------------------------------------------------------------------

/** Extract the -mcpu=<cpu> value from a target's compile flags. */
function detectMcpu(target: Target): string {
  for (const cg of target.compileGroups) {
    for (const f of cg.flags) {
      const m = f.fragment.match(/-mcpu=([\w-]+)/);
      if (m) return m[1].toLowerCase();
    }
  }
  if (target.link) {
    for (const f of target.link.fragments) {
      const m = f.fragment.match(/-mcpu=([\w-]+)/);
      if (m) return m[1].toLowerCase();
    }
  }
  return 'cortex-m33'; // safe default for this project family
}

/** Detect whether -mcmse (TrustZone Secure state) is present in compile flags. */
function detectMcmse(target: Target): boolean {
  for (const cg of target.compileGroups) {
    for (const f of cg.flags) {
      if (/(^|\s)-mcmse(\s|$)/.test(f.fragment)) return true;
    }
  }
  return false;
}

/** Collect unique include paths from all compile groups of a set of targets. */
function collectIncludes(targets: Target[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const target of targets) {
    for (const cg of target.compileGroups) {
      for (const inc of cg.includes) {
        if (!seen.has(inc.path)) {
          seen.add(inc.path);
          result.push(inc.path);
        }
      }
    }
  }
  return result;
}

/** Collect unique preprocessor defines from all compile groups of a set of targets. */
function collectDefines(targets: Target[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const target of targets) {
    for (const cg of target.compileGroups) {
      for (const def of cg.defines) {
        if (!seen.has(def.define)) {
          seen.add(def.define);
          result.push(def.define);
        }
      }
    }
  }
  return result;
}

/**
 * Collect all OBJECT_LIBRARY and STATIC_LIBRARY dependencies (transitively)
 * whose compiled object files are linked directly into the given executable target.
 */
function collectDependentLibraries(target: Target): Target[] {
  const visited = new Set<string>();
  const result: Target[] = [];

  function walk(t: Target) {
    for (const dep of t.dependencies) {
      if (visited.has(dep.id)) continue;
      visited.add(dep.id);
      if (dep.type === 'OBJECT_LIBRARY' || dep.type === 'STATIC_LIBRARY') {
        result.push(dep);
        walk(dep);
      }
    }
  }
  walk(target);
  return result;
}

/**
 * Flags already covered by Eclipse toolchain/compiler options — skip these
 * when building the linker "other flags" string to avoid duplication.
 */
const SKIP_LINK_FLAG_PATTERNS: RegExp[] = [
  /^-mthumb$/i,
  /^-mcpu=/i,
  /^-mfloat-abi=/i,
  /^-mfpu=/i,
  /^-march=/i,
  /^-ffunction-sections$/i,
  /^-fdata-sections$/i,
  /^-g\d*$/i,
  /^-Wall$/,
  /^-Wextra$/,
  /^-Wl,--gc-sections$/,
];

interface LinkerData {
  scripts: string[];
  libraryPaths: string[];
  libs: string[];
  otherObjs: string[];
  otherFlags: string;
  useNano: boolean;
  /** Basename of the --out-implib output file, e.g. "nsc_veneer.o.tmp", or undefined. */
  veneerOutput?: string;
}

/**
 * Extract all linker data from the target's link command fragments:
 * linker scripts, library paths, library names, extra object files,
 * newlib-nano flag, and miscellaneous other flags.
 */
function collectLinkerData(target: Target): LinkerData {
  if (!target.link) {
    return { scripts: [], libraryPaths: [], libs: [], otherObjs: [], otherFlags: '', useNano: false };
  }

  const scripts: string[] = [];
  const libraryPaths: string[] = [];
  const libs: string[] = [];
  const otherObjs: string[] = [];
  const otherFlagParts: string[] = [];
  let useNano = false;
  let veneerOutput: string | undefined;

  const frags = target.link.fragments;

  for (let i = 0; i < frags.length; i++) {
    const f = frags[i].fragment.trim();
    const role = frags[i].role;

    if (role === 'libraryPath') {
      const p = f.startsWith('-L') ? f.slice(2) : f;
      libraryPaths.push(p.replace(/\\/g, '/'));

    } else if (role === 'libraries') {
      if (f.startsWith('-l')) {
        libs.push(f.slice(2));
      } else if (f.startsWith('-Wl,')) {
        // -Wl,--end-group pairs with --start-group; keep both for correct linking
        otherFlagParts.push(f);
      } else if (f.length > 0) {
        // Direct object file reference — resolve relative to target build dir
        const resolved = path.isAbsolute(f)
          ? f
          : path.resolve(target.buildPath, f);
        otherObjs.push(resolved.replace(/\\/g, '/'));
      }

    } else {
      // role === 'flags' (or undefined)
      // Extract -T linker scripts
      const scriptMatches = [...f.matchAll(/-T\s*"?([^\s"]+)"?/g)];
      if (scriptMatches.length > 0) {
        for (const m of scriptMatches) scripts.push(m[1]);
        continue;
      }
      if (f === '-T' && i + 1 < frags.length) {
        scripts.push(frags[i + 1].fragment.trim().replace(/^"(.*)"$/, '$1'));
        i++;
        continue;
      }

      // --specs=nano.specs → dedicated Eclipse option
      if (f === '--specs=nano.specs') {
        useNano = true;
        continue;
      }

      // -Wl,--out-implib=<path> — normalise to bare final filename.
      // cmake writes to a .tmp then copy_if_different to avoid spurious rebuilds
      // in its own build graph; Eclipse manages incremental builds differently,
      // so write directly to the final file (strip any .tmp extension).
      const outImplibMatch = f.match(/^-Wl,--out-implib=(.+)$/);
      if (outImplibMatch) {
        const basename = path.basename(outImplibMatch[1]).replace(/\.tmp$/, '');
        veneerOutput = basename;
        otherFlagParts.push(`-Wl,--out-implib=${basename}`);
        continue;
      }

      // -Wl,-Map=<path> — normalise absolute cmake path to a bare filename
      const mapMatch = f.match(/^-Wl,-Map=(.+)$/);
      if (mapMatch) {
        const basename = path.basename(mapMatch[1]);
        otherFlagParts.push(`-Wl,-Map=${basename}`);
        continue;
      }

      // Skip flags already set by Eclipse toolchain/compiler options
      if (SKIP_LINK_FLAG_PATTERNS.some((p) => p.test(f))) continue;

      if (f.length > 0) otherFlagParts.push(f);
    }
  }

  return {
    scripts: [...new Set(scripts)],
    libraryPaths: [...new Set(libraryPaths)],
    libs: [...new Set(libs)],
    otherObjs: [...new Set(otherObjs)],
    otherFlags: otherFlagParts.join(' '),
    useNano,
    veneerOutput,
  };
}

// ---------------------------------------------------------------------------
// File-copy helpers
// ---------------------------------------------------------------------------

/** Returns true when absChild is at or under absParent (both normalised). */
function isUnderDir(absChild: string, absParent: string): boolean {
  const child = path.normalize(absChild);
  const parent = path.normalize(absParent);
  return child === parent || child.startsWith(parent + path.sep);
}

/** Copy src to dest, creating intermediate directories as needed. */
async function copyFileSafe(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

/** Returns true if the file should be excluded from Eclipse project output. */
function isCmakeBuildFile(name: string): boolean {
  return name === 'CMakeLists.txt' || name.endsWith('.cmake');
}

const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.c++',
  '.s', '.S', '.asm',
]);

/** Returns true if the file is a compilable source file. */
function isSourceFile(name: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * Recursively copy all files from srcDir into destDir.
 * Skips CMake build files and compilable source files — only headers and
 * data files are copied.  Source files that need compiling are already
 * enumerated in the compile groups and copied by the source-file loop.
 */
async function copyDirRecursive(srcDir: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (isCmakeBuildFile(entry.name)) continue;
    if (isSourceFile(entry.name)) continue;
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(s, d);
    } else {
      await fs.copyFile(s, d);
    }
  }
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export class EclipseGenerator implements IBackend {
  constructor(
    private readonly model: CMakeModel,
    private readonly opts: BackendOptions,
  ) {}

  async generate(): Promise<string[]> {
    const cfg = this.model.defaultConfiguration;
    if (!cfg) throw new Error('CMake model has no configurations');

    const executables = cfg.targets.filter((t) => t.isExecutable);
    if (executables.length === 0) {
      throw new Error('No EXECUTABLE targets found in CMake model');
    }

    await fs.mkdir(this.opts.destDir, { recursive: true });

    const writtenFiles: string[] = [];

    for (const target of executables) {
      const projectName = target.name.replace(/\.elf$/i, '');
      const projectDir = path.join(this.opts.destDir, projectName);
      await fs.mkdir(projectDir, { recursive: true });

      const sourceRoot = this.model.paths.source;
      const depLibs = collectDependentLibraries(target);
      const allTargets = [target, ...depLibs];
      const includes = collectIncludes(allTargets);
      const defines = collectDefines(allTargets);
      const mcpu = detectMcpu(target);
      const mcmse = detectMcmse(target);
      const linkerData = collectLinkerData(target);

      // --- Copy source files (preserving relative structure from sourceRoot) ---
      // Includes sources from dependent OBJECT_LIBRARY and STATIC_LIBRARY targets.
      const SKIP_NAMES = new Set([
        '.project', '.cproject', '.mtbqueryapi', '.settings',
      ]);
      const shouldSkip = (absPath: string): boolean => {
        const base = path.basename(absPath);
        return SKIP_NAMES.has(base) || isCmakeBuildFile(base);
      };

      let sourceFilesCopied = 0;
      const copiedSrcFiles = new Set<string>();
      for (const t of allTargets) {
        for (const cg of t.compileGroups) {
          for (const src of cg.sources) {
            const absSrc = path.isAbsolute(src.path)
              ? src.path
              : path.resolve(sourceRoot, src.path);
            if (copiedSrcFiles.has(absSrc)) continue;
            copiedSrcFiles.add(absSrc);
            if (shouldSkip(absSrc)) continue;
            if (isUnderDir(absSrc, sourceRoot)) {
              const rel = path.relative(sourceRoot, absSrc);
              await copyFileSafe(absSrc, path.join(projectDir, rel));
              sourceFilesCopied++;
            } else {
              console.warn(`  [eclipse] ${projectName}: source outside source root, skipping copy: ${absSrc}`);
            }
          }
        }
      }

      // --- Copy project-local include dirs; keep external paths absolute ---
      const copiedIncDirs = new Set<string>();
      const resolvedIncludes: string[] = [];
      for (const inc of includes) {
        if (isUnderDir(inc, sourceRoot) && !copiedIncDirs.has(inc)) {
          copiedIncDirs.add(inc);
          const rel = path.relative(sourceRoot, inc);
          const destInc = path.join(projectDir, rel);
          try {
            await copyDirRecursive(inc, destInc);
            // Use ${ProjDirPath} so the path works on any machine Eclipse imports to
            resolvedIncludes.push('${ProjDirPath}/' + rel.replace(/\\/g, '/'));
          } catch {
            console.warn(`  [eclipse] ${projectName}: include dir not found, skipping copy: ${inc}`);
            resolvedIncludes.push(inc.replace(/\\/g, '/'));
          }
        } else if (copiedIncDirs.has(inc)) {
          // Already copied — push the destination path using Eclipse variable
          const rel = path.relative(sourceRoot, inc);
          resolvedIncludes.push('${ProjDirPath}/' + rel.replace(/\\/g, '/'));
        } else {
          resolvedIncludes.push(inc.replace(/\\/g, '/')); // external / SDK path — keep absolute
        }
      }

      // --- Copy linker scripts to project root ---
      const resolvedLinkerScripts: string[] = [];
      for (const ls of linkerData.scripts) {
        const absLs = path.isAbsolute(ls) ? ls : path.resolve(target.buildPath, ls);
        const dest = path.join(projectDir, path.basename(absLs));
        try {
          await fs.copyFile(absLs, dest);
          // Use ${ProjDirPath} so the path works on any machine Eclipse imports to
          resolvedLinkerScripts.push('${ProjDirPath}/' + path.basename(absLs));
        } catch {
          console.warn(`  [eclipse] ${projectName}: could not copy linker script: ${absLs}`);
          resolvedLinkerScripts.push(ls.replace(/\\/g, '/'));
        }
      }

      // .project — no linked resources needed; sources are now local
      const projectXml = renderProject(projectName, []);
      const projectFile = path.join(projectDir, '.project');
      await fs.writeFile(projectFile, projectXml, 'utf8');
      writtenFiles.push(projectFile);

      // .cproject
      const cprojectInput: EclipseCprojectInput = {
        projectName,
        mcpu,
        mcmse,
        includes: resolvedIncludes,
        defines,
        linkerScripts: resolvedLinkerScripts,
        libraryPaths: linkerData.libraryPaths,
        libs: linkerData.libs,
        otherObjs: linkerData.otherObjs,
        linkerOtherFlags: linkerData.otherFlags,
        useNano: linkerData.useNano,
      };
      const cprojectXml = renderCproject(cprojectInput);
      const cprojectFile = path.join(projectDir, '.cproject');
      await fs.writeFile(cprojectFile, cprojectXml, 'utf8');
      writtenFiles.push(cprojectFile);

      console.log(`  [eclipse] ${projectName}: mcpu=${mcpu}, mcmse=${mcmse}, useNano=${linkerData.useNano}, ` +
        `${sourceFilesCopied} source file(s) (${depLibs.length} dep libs), ${resolvedIncludes.length} includes, ` +
        `${defines.length} defines, ${resolvedLinkerScripts.length} linker script(s), ` +
        `${linkerData.libraryPaths.length} lib path(s)`);
    }

    return writtenFiles;
  }
}
