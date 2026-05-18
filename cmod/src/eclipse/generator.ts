/**
 * Eclipse CDT Managed Build project generator.
 *
 * For each EXECUTABLE target in the CMake model, produces a pair of Eclipse
 * project files (.project and .cproject) in a sub-directory of `destDir`:
 *
 *   destDir/<targetName>/.project
 *   destDir/<targetName>/.cproject
 *
 * Source files are referenced via Eclipse "linked virtual folders", so nothing
 * is copied — the generated project points directly at the cmake source tree.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CMakeModel, Target } from '../cmake/index.js';
import type { IBackend, BackendOptions } from '../backend.js';
import { renderProject, type LinkedResource } from './project.js';
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

/**
 * Collect the set of unique directory paths that contain compiled source files
 * for this target.  Returns them as LinkedResource entries with deduplicated
 * Eclipse workspace names.
 */
function collectSourceLinks(target: Target, sourceRoot: string): LinkedResource[] {
  // Gather unique directories from sources that belong to a compile group.
  // CMake File API may return relative source paths (relative to the source
  // root), so resolve them to absolute paths before computing directories.
  const dirSet = new Set<string>();
  for (const cg of target.compileGroups) {
    for (const src of cg.sources) {
      const absPath = path.isAbsolute(src.path)
        ? src.path
        : path.resolve(sourceRoot, src.path);
      dirSet.add(path.dirname(absPath));
    }
  }

  const links: LinkedResource[] = [];
  const usedNames = new Set<string>();

  for (const dir of dirSet) {
    // Normalise to forward slashes for the Eclipse location field
    const absPath = dir.replace(/\\/g, '/');

    // Build a candidate name from the last path segment(s)
    const parts = absPath.split('/').filter((p) => p.length > 0);
    let name = sanitizeName(parts[parts.length - 1] ?? 'src');

    // Deduplicate: try prepending the parent segment, then add a counter
    if (usedNames.has(name) && parts.length >= 2) {
      name = sanitizeName(`${parts[parts.length - 2]}_${parts[parts.length - 1]}`);
    }
    if (usedNames.has(name)) {
      let idx = 2;
      const base = name;
      while (usedNames.has(name)) name = `${base}_${idx++}`;
    }

    usedNames.add(name);
    links.push({ name, absPath });
  }

  return links;
}

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, '_');
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

      const links = collectSourceLinks(target, this.model.paths.source);
      const includes = collectIncludes(target);
      const defines = collectDefines(target);
      const mcpu = detectMcpu(target);
      const linkerScripts = collectLinkerScripts(target);

      // .project
      const projectXml = renderProject(projectName, links);
      const projectFile = path.join(projectDir, '.project');
      await fs.writeFile(projectFile, projectXml, 'utf8');
      writtenFiles.push(projectFile);

      // .cproject
      const cprojectInput: EclipseCprojectInput = {
        projectName,
        mcpu,
        includes,
        defines,
        linkerScripts,
      };
      const cprojectXml = renderCproject(cprojectInput);
      const cprojectFile = path.join(projectDir, '.cproject');
      await fs.writeFile(cprojectFile, cprojectXml, 'utf8');
      writtenFiles.push(cprojectFile);

      console.log(`  [eclipse] ${projectName}: mcpu=${mcpu}, ${includes.length} includes, ` +
        `${defines.length} defines, ${linkerScripts.length} linker script(s), ` +
        `${links.length} source link(s)`);
    }

    return writtenFiles;
  }
}
