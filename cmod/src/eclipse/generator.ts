/**
 * Eclipse cmake4eclipse project generator.
 *
 * Generates Eclipse project files directly into the CMake source root
 * (destDir == sourceDir).  No source files are copied; cmake4eclipse
 * delegates all compilation to CMake/Ninja.
 *
 * Files produced:
 *   <destDir>/.project
 *   <destDir>/.cproject
 *   <destDir>/.settings/org.eclipse.cdt.core.prefs
 *   <destDir>/.settings/org.eclipse.core.resources.prefs
 *   <destDir>/.launches/<projectName>.<target> Debug (KitProg3_MiniProg4).launch  (one per exe)
 *   <destDir>/.launches/<projectName> Debug MultiCore (KitProg3_MiniProg4).launch (if >1 exe)
 *   <destDir>/.launches/Advanced KitProg3 Programming.launch
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CMakeModel, Target } from '../cmake/index.js';
import type { IBackend, BackendOptions } from '../backend.js';
import { renderProject } from './project.js';
import { renderCproject, generateDebugConfigId } from './cproject.js';
import {
  renderDebugLaunch,
  renderGroupDebugLaunch,
  renderProgramLaunch,
  debugLaunchFileName,
  groupDebugLaunchFileName,
  programLaunchFileName,
  type LaunchConfigInput,
  type LaunchTarget,
} from './launch.js';

// ---------------------------------------------------------------------------
// Path-discovery helpers
// ---------------------------------------------------------------------------

/** Returns true when absChild is at or under absParent. */
function isUnderDir(absChild: string, absParent: string): boolean {
  const child = path.normalize(absChild);
  const parent = path.normalize(absParent);
  return child === parent || child.startsWith(parent + path.sep);
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

/** Return the first sub-directory name in `dir` matching `pattern`, or undefined. */
async function findFirstSubdir(dir: string, pattern: RegExp): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && pattern.test(e.name)) return e.name;
    }
  } catch { /* dir doesn't exist */ }
  return undefined;
}

/** Return the first file name in `dir` matching `pattern`, or undefined. */
async function findFirstFile(dir: string, pattern: RegExp): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && pattern.test(e.name)) return e.name;
    }
  } catch { /* dir doesn't exist */ }
  return undefined;
}

/** Recursively find the first file whose name satisfies `test`. Returns the full absolute path. */
async function findFileRecursive(
  dir: string,
  test: (name: string) => boolean,
): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && test(e.name)) return path.join(dir, e.name);
      if (e.isDirectory()) {
        const sub = await findFileRecursive(path.join(dir, e.name), test);
        if (sub) return sub;
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

/**
 * Parse the first `key := value` or `key = value` line from a Make-style .mk file.
 */
async function readMkValue(mkPath: string, key: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(mkPath, 'utf8');
    const re = new RegExp(`^${key}\\s*[:+]?=\\s*(.+)$`, 'm');
    const m = content.match(re);
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// OpenOCD target-config discovery
// ---------------------------------------------------------------------------

/** Known mapping: DEVICE_COMPONENTS chip-family token → OpenOCD `source [find ...]` path. */
const CHIP_TO_OPENOCD_TARGET: Record<string, string> = {
  PSE84: 'target/infineon/pse84xgxs2.cfg',
};

/**
 * Determine the OpenOCD target config string (used in `source [find <cfg>]`)
 * by reading the BSP's bsp.mk DEVICE_COMPONENTS field.
 */
async function detectOpenocdTargetCfg(bspAbsPath: string): Promise<string> {
  const bspMk = path.join(bspAbsPath, 'bsp.mk');
  const components = await readMkValue(bspMk, 'DEVICE_COMPONENTS');
  if (components) {
    for (const [chip, cfg] of Object.entries(CHIP_TO_OPENOCD_TARGET)) {
      if (components.includes(chip)) return cfg;
    }
  }
  // Fallback: match the BSP directory name
  const dirName = path.basename(bspAbsPath).toUpperCase();
  for (const [chip, cfg] of Object.entries(CHIP_TO_OPENOCD_TARGET)) {
    if (dirName.includes(chip)) return cfg;
  }
  console.warn('[eclipse] Could not detect OpenOCD target cfg from BSP; defaulting to pse84xgxs2');
  return 'target/infineon/pse84xgxs2.cfg';
}

// ---------------------------------------------------------------------------
// CMake target helpers
// ---------------------------------------------------------------------------

/** Detect whether -mcmse (TrustZone Secure state) is present in a target's compile flags. */
function detectMcmse(target: Target): boolean {
  for (const cg of target.compileGroups) {
    for (const f of cg.flags) {
      if (/(^|\s)-mcmse(\s|$)/.test(f.fragment)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Eclipse settings file content
// ---------------------------------------------------------------------------

const CDT_CORE_PREFS = `eclipse.preferences.version=1
doxygen/doxygen_comment_auto_adding_enabled=false
doxygen/doxygen_new_line_after_brief=true
doxygen/doxygen_use_brief_tag=false
doxygen/doxygen_use_javadoc_auto_brief=false
doxygen/doxygen_use_pre_tag=false
doxygen/doxygen_use_structural_commands=false
`;

const RESOURCES_PREFS = `eclipse.preferences.version=1
encoding/<project>=UTF-8
`;

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
    if (executables.length === 0) throw new Error('No EXECUTABLE targets found in CMake model');

    const projectDir = this.opts.destDir;
    const projectName = path.basename(projectDir);

    // --- Discover BSP directory ---
    const bspsDir = path.join(projectDir, 'bsps');
    const bspDirName = await findFirstSubdir(bspsDir, /^TARGET_APP_/);
    const bspRelPath = bspDirName ? `bsps/${bspDirName}` : undefined;
    const bspAbsPath = bspDirName ? path.join(bspsDir, bspDirName) : undefined;

    if (!bspAbsPath) console.warn('[eclipse] Could not find bsps/TARGET_APP_* directory');

    // --- FLM file inside BSP GeneratedSource ---
    let flmRelPath: string | undefined;
    if (bspAbsPath && bspRelPath) {
      const genSrc = path.join(bspAbsPath, 'config', 'GeneratedSource');
      const flmFile = await findFirstFile(genSrc, /\.FLM$/i);
      if (flmFile) flmRelPath = `${bspRelPath}/config/GeneratedSource/${flmFile}`;
    }

    // --- SVD file under assets/ ---
    let svdRelPath: string | undefined;
    const assetsDir = path.join(projectDir, 'assets');
    const svdAbsPath = await findFileRecursive(assetsDir, (n) => n.endsWith('.svd'));
    if (svdAbsPath && isUnderDir(svdAbsPath, projectDir)) {
      svdRelPath = path.relative(projectDir, svdAbsPath).replace(/\\/g, '/');
    }

    // --- Debug certificate ---
    let debugCertRelPath: string | undefined;
    if (await fileExists(path.join(projectDir, 'packets', 'debug_token.bin'))) {
      debugCertRelPath = 'packets/debug_token.bin';
    }

    // --- OpenOCD target config ---
    const openocdTargetCfg = bspAbsPath
      ? await detectOpenocdTargetCfg(bspAbsPath)
      : 'target/infineon/pse84xgxs2.cfg';

    // --- Target list ---
    const targets: LaunchTarget[] = executables.map((t) => ({
      targetName: t.name,
      baseName: t.name.replace(/\.elf$/i, ''),
      hasMcmse: detectMcmse(t),
    }));

    const multiCore = targets.some((t) => t.baseName.toLowerCase().includes('cm55'));

    // Generate a single debug config ID shared between .cproject and the launch configs
    // so PROJECT_BUILD_CONFIG_ID_ATTR correctly references the build configuration.
    const debugConfigId = generateDebugConfigId();

    const launchInput: LaunchConfigInput = {
      projectName,
      projectDir,
      targets,
      bspRelPath: bspRelPath ?? 'bsps/TARGET_APP_BSP',
      openocdTargetCfg,
      flmRelPath,
      svdRelPath,
      debugCertRelPath,
      multiCore,
      debugConfigId,
    };

    // --- Write files ---
    const writtenFiles: string[] = [];

    const write = async (relPath: string, content: string): Promise<void> => {
      const abs = path.join(projectDir, relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      writtenFiles.push(abs);
    };

    await write('.project', renderProject(projectName));
    await write('.cproject', renderCproject({ projectName, toolchainFile: 'toolchains/gcc.cmake', debugConfigId }));
    await write('.settings/org.eclipse.cdt.core.prefs', CDT_CORE_PREFS);
    await write('.settings/org.eclipse.core.resources.prefs', RESOURCES_PREFS);

    for (const target of targets) {
      await write(
        `.launches/${debugLaunchFileName(projectName, target.baseName)}`,
        renderDebugLaunch(launchInput, target),
      );
    }

    if (targets.length > 1) {
      await write(
        `.launches/${groupDebugLaunchFileName(projectName)}`,
        renderGroupDebugLaunch(launchInput),
      );
    }

    await write(`.launches/${programLaunchFileName}`, renderProgramLaunch(launchInput));

    console.log(`[eclipse] Project: ${projectName}`);
    console.log(`[eclipse]   ${targets.length} target(s): ${targets.map((t) => t.baseName).join(', ')}`);
    console.log(`[eclipse]   BSP: ${bspRelPath ?? '(not found)'}`);
    console.log(`[eclipse]   OpenOCD target: ${openocdTargetCfg}`);
    console.log(`[eclipse]   SVD: ${svdRelPath ?? '(not found)'}`);
    console.log(`[eclipse]   FLM: ${flmRelPath ?? '(not found)'}`);
    console.log(`[eclipse]   Debug cert: ${debugCertRelPath ?? '(not found)'}`);
    console.log(`[eclipse]   Written ${writtenFiles.length} file(s)`);

    return writtenFiles;
  }
}
