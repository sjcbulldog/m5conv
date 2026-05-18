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

/** Collect unique include paths from all compile groups of a target. */
function collectIncludes(target: Target): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const cg of target.compileGroups) {
    for (const inc of cg.includes) {
      if (!seen.has(inc.path)) {
        seen.add(inc.path);
        result.push(inc.path);
      }
    }
  }
  return result;
}

/** Collect unique preprocessor defines from all compile groups of a target. */
function collectDefines(target: Target): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const cg of target.compileGroups) {
    for (const def of cg.defines) {
      if (!seen.has(def.define)) {
        seen.add(def.define);
        result.push(def.define);
      }
    }
  }
  return result;
}

/**
 * Extract linker script paths from the link command fragments.
 * Matches `-T<path>` and `-T <path>` patterns (the fragment may be a single
 * string or split across consecutive flag fragments).
 */
function collectLinkerScripts(target: Target): string[] {
  if (!target.link) return [];
  const scripts: string[] = [];
  const frags = target.link.fragments.map((f) => f.fragment);
  for (const frag of frags) {
    // A single fragment may contain one or more -T flags
    for (const m of frag.matchAll(/-T\s*"?([^\s"]+)"?/g)) {
      scripts.push(m[1]);
    }
  }
  // Also handle the pattern where -T and the path are separate fragments
  for (let i = 0; i < frags.length - 1; i++) {
    if (frags[i].trim() === '-T') {
      scripts.push(frags[i + 1].trim().replace(/^"(.*)"$/, '$1'));
    }
  }
  return [...new Set(scripts)];
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

/** Recursively copy all files from srcDir into destDir. */
async function copyDirRecursive(srcDir: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
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
      const includes = collectIncludes(target);
      const defines = collectDefines(target);
      const mcpu = detectMcpu(target);
      const linkerScripts = collectLinkerScripts(target);

      // --- Copy source files (preserving relative structure from sourceRoot) ---
      let sourceFilesCopied = 0;
      const copiedSrcFiles = new Set<string>();
      for (const cg of target.compileGroups) {
        for (const src of cg.sources) {
          const absSrc = path.isAbsolute(src.path)
            ? src.path
            : path.resolve(sourceRoot, src.path);
          if (copiedSrcFiles.has(absSrc)) continue;
          copiedSrcFiles.add(absSrc);
          if (isUnderDir(absSrc, sourceRoot)) {
            const rel = path.relative(sourceRoot, absSrc);
            await copyFileSafe(absSrc, path.join(projectDir, rel));
            sourceFilesCopied++;
          } else {
            console.warn(`  [eclipse] ${projectName}: source outside source root, skipping copy: ${absSrc}`);
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
            resolvedIncludes.push(destInc);
          } catch {
            console.warn(`  [eclipse] ${projectName}: include dir not found, skipping copy: ${inc}`);
            // Keep the original path so the compiler option is still present
            resolvedIncludes.push(inc);
          }
        } else if (copiedIncDirs.has(inc)) {
          // Already copied — push the destination path
          const rel = path.relative(sourceRoot, inc);
          resolvedIncludes.push(path.join(projectDir, rel));
        } else {
          resolvedIncludes.push(inc); // external / SDK path — keep absolute
        }
      }

      // --- Copy linker scripts to project root ---
      const resolvedLinkerScripts: string[] = [];
      for (const ls of linkerScripts) {
        const absLs = path.isAbsolute(ls) ? ls : path.resolve(target.buildPath, ls);
        const dest = path.join(projectDir, path.basename(absLs));
        try {
          await fs.copyFile(absLs, dest);
          resolvedLinkerScripts.push(dest);
        } catch {
          console.warn(`  [eclipse] ${projectName}: could not copy linker script: ${absLs}`);
          resolvedLinkerScripts.push(ls);
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
        includes: resolvedIncludes,
        defines,
        linkerScripts: resolvedLinkerScripts,
      };
      const cprojectXml = renderCproject(cprojectInput);
      const cprojectFile = path.join(projectDir, '.cproject');
      await fs.writeFile(cprojectFile, cprojectXml, 'utf8');
      writtenFiles.push(cprojectFile);

      console.log(`  [eclipse] ${projectName}: mcpu=${mcpu}, ${sourceFilesCopied} source file(s), ` +
        `${resolvedIncludes.length} includes, ${defines.length} defines, ` +
        `${resolvedLinkerScripts.length} linker script(s)`);
    }

    return writtenFiles;
  }
}
