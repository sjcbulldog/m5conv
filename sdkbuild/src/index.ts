#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AppJson {
  name: string;
  firmware: Record<string, string[]>;
  bsps: string[];
}

interface Stats {
  appsProcessed: string[];
  firmwareCopied: string[];
  firmwareSkipped: string[];
  bspsCopied: string[];
  bspsSkipped: string[];
}

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

/**
 * Reads the names of immediate child directories inside a directory.
 * Returns an empty array if the directory does not exist.
 */
function listSubdirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * Recursively copies `src` into `dest`.
 * If `excludeNames` is provided, top-level children with those names are skipped.
 * If `dest` already exists it is skipped entirely (deduplication).
 * Returns true if the copy was performed, false if skipped.
 */
function copyDir(src: string, dest: string, excludeNames: string[] = []): boolean {
  if (fs.existsSync(dest)) return false;
  copyDirRecursive(src, dest, excludeNames, true);
  return true;
}

function copyDirRecursive(src: string, dest: string, excludeNames: string[], topLevel: boolean): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (topLevel && excludeNames.includes(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, [], false);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// CMake / firmware.cmake parsing
// ---------------------------------------------------------------------------

/**
 * Parses a firmware.cmake file and returns the list of asset names it references
 * via add_subdirectory(../assets/<name> ...) lines.
 */
function parseFirmwareCmake(firmwareCmakePath: string): string[] {
  if (!fs.existsSync(firmwareCmakePath)) return [];
  const content = fs.readFileSync(firmwareCmakePath, 'utf8');
  const assets: string[] = [];
  // Matches: add_subdirectory(../assets/<name>  (with optional whitespace)
  const re = /^\s*add_subdirectory\s*\(\s*\.\.[\/\\]assets[\/\\]([^\s\/\\\)]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    assets.push(match[1]);
  }
  return assets;
}

/**
 * Walks the immediate subdirectories of `appPath` that match `proj_*` and
 * parses their firmware.cmake to build a per-project firmware map.
 */
function parseFirmwarePerProject(appPath: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!fs.existsSync(appPath)) return result;
  for (const entry of fs.readdirSync(appPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('proj_')) continue;
    const fw = parseFirmwareCmake(path.join(appPath, entry.name, 'firmware.cmake'));
    if (fw.length > 0) {
      result[entry.name] = fw;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// CMake patching helpers
// ---------------------------------------------------------------------------

/**
 * Walks a directory recursively and returns all files matching `filename`.
 */
function findFiles(dir: string, filename: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  function walk(current: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === filename) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

/**
 * Removes lines that contain `include(` and reference `firmware.cmake`
 * from a CMakeLists.txt file.
 */
function removeFirmwareCmakeIncludes(cmakeFile: string): void {
  const original = fs.readFileSync(cmakeFile, 'utf8');
  const filtered = original
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('include(') && trimmed.includes('firmware.cmake'));
    })
    .join('\n');
  if (filtered !== original) {
    fs.writeFileSync(cmakeFile, filtered, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Core SDK builder
// ---------------------------------------------------------------------------

function buildSdk(inputJsonPath: string, outputDir: string, force: boolean): void {
  // ── Resolve paths ───────────────────────────────────────────────────────
  const inputAbsolute = path.resolve(inputJsonPath);
  const outputAbsolute = path.resolve(outputDir);

  if (!fs.existsSync(inputAbsolute)) {
    console.error(`Error: input file not found: ${inputAbsolute}`);
    process.exit(1);
  }

  // ── Output directory guard ───────────────────────────────────────────────
  if (fs.existsSync(outputAbsolute)) {
    const children = fs.readdirSync(outputAbsolute);
    if (children.length > 0) {
      if (force) {
        console.log(`Removing existing output directory: ${outputAbsolute}`);
        fs.rmSync(outputAbsolute, { recursive: true, force: true });
      } else {
        console.error(
          `Error: output directory is not empty: ${outputAbsolute}\n` +
          `Use --force to overwrite it.`
        );
        process.exit(1);
      }
    }
  }

  // ── Read and validate input JSON ────────────────────────────────────────
  let appPaths: string[];
  try {
    const raw = fs.readFileSync(inputAbsolute, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      throw new Error('Input JSON must be an array of strings (application paths).');
    }
    // Resolve each path relative to the directory containing the JSON file
    const baseDir = path.dirname(inputAbsolute);
    appPaths = (parsed as string[]).map((p) => path.resolve(baseDir, p));
  } catch (err) {
    console.error(`Error reading input JSON: ${(err as Error).message}`);
    process.exit(1);
  }

  // ── Create SDK directory structure ──────────────────────────────────────
  const appsDir = path.join(outputAbsolute, 'apps');
  const bspsDir = path.join(outputAbsolute, 'bsps');
  const firmwareDir = path.join(outputAbsolute, 'firmware');

  for (const d of [appsDir, bspsDir, firmwareDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const stats: Stats = {
    appsProcessed: [],
    firmwareCopied: [],
    firmwareSkipped: [],
    bspsCopied: [],
    bspsSkipped: [],
  };

  // ── Process each application ─────────────────────────────────────────────
  for (const appPath of appPaths) {
    if (!fs.existsSync(appPath)) {
      console.warn(`Warning: application path not found, skipping: ${appPath}`);
      continue;
    }

    const appName = path.basename(appPath);
    console.log(`\nProcessing application: ${appName}`);

    // 1. Collect asset names from <app>/assets/
    const assetNames = listSubdirs(path.join(appPath, 'assets'));

    // 2. Collect BSP names from <app>/bsps/
    const bspNames = listSubdirs(path.join(appPath, 'bsps'));

    // 3. Parse per-project firmware lists from source firmware.cmake files
    //    (must happen before the files are deleted from the copied app)
    const firmwareByProject = parseFirmwarePerProject(appPath);

    // 4. Copy assets → sdk/firmware/ (deduplicated)
    for (const asset of assetNames) {
      const src = path.join(appPath, 'assets', asset);
      const dest = path.join(firmwareDir, asset);
      const copied = copyDir(src, dest);
      if (copied) {
        console.log(`  [firmware] copied  : ${asset}`);
        stats.firmwareCopied.push(asset);
      } else {
        console.log(`  [firmware] skipped : ${asset} (already exists)`);
        stats.firmwareSkipped.push(asset);
      }
    }

    // 5. Copy BSPs → sdk/bsps/ (deduplicated)
    for (const bsp of bspNames) {
      const src = path.join(appPath, 'bsps', bsp);
      const dest = path.join(bspsDir, bsp);
      const copied = copyDir(src, dest);
      if (copied) {
        console.log(`  [bsp]      copied  : ${bsp}`);
        stats.bspsCopied.push(bsp);
      } else {
        console.log(`  [bsp]      skipped : ${bsp} (already exists)`);
        stats.bspsSkipped.push(bsp);
      }
    }

    // 6. Copy app → sdk/apps/<appName>/ (excluding assets/ and bsps/)
    const destAppDir = path.join(appsDir, appName);
    console.log(`  [app]      copying : ${appName} → apps/${appName}`);
    copyDirRecursive(appPath, destAppDir, ['assets', 'bsps'], true);

    // 7. Delete firmware.cmake files from copied proj_* directories
    const firmwareCmakeFiles = findFiles(destAppDir, 'firmware.cmake');
    for (const f of firmwareCmakeFiles) {
      fs.unlinkSync(f);
      const rel = path.relative(destAppDir, f);
      console.log(`  [cmake]    deleted : ${rel}`);
    }

    // 8. Remove include(firmware.cmake) lines from proj_*/CMakeLists.txt
    const cmakeLists = findFiles(destAppDir, 'CMakeLists.txt');
    for (const f of cmakeLists) {
      removeFirmwareCmakeIncludes(f);
    }
    if (cmakeLists.length > 0) {
      console.log(`  [cmake]    patched : ${cmakeLists.length} CMakeLists.txt file(s) (removed firmware.cmake includes)`);
    }

    // 9. Write app.json
    const appJson: AppJson = {
      name: appName,
      firmware: firmwareByProject,
      bsps: bspNames,
    };
    const appJsonPath = path.join(destAppDir, 'app.json');
    fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2), 'utf8');
    console.log(`  [app.json] created : ${appName}/app.json`);

    stats.appsProcessed.push(appName);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('SDK build complete');
  console.log(`  Output      : ${outputAbsolute}`);
  console.log(`  Apps        : ${stats.appsProcessed.length} processed (${stats.appsProcessed.join(', ') || 'none'})`);
  console.log(`  Firmware    : ${stats.firmwareCopied.length} copied, ${stats.firmwareSkipped.length} skipped (duplicates)`);
  console.log(`  BSPs        : ${stats.bspsCopied.length} copied, ${stats.bspsSkipped.length} skipped (duplicates)`);
  console.log('='.repeat(60));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('sdk-builder')
  .description('Assembles an SDK from a set of cmake-based MTB5 applications')
  .version('1.0.0')
  .requiredOption('-i, --input <path>', 'path to input JSON file listing application directories')
  .requiredOption('-o, --output <path>', 'path to the SDK output directory')
  .option('-f, --force', 'delete and recreate the output directory if it already exists', false)
  .action((options: { input: string; output: string; force: boolean }) => {
    buildSdk(options.input, options.output, options.force);
  });

program.parse(process.argv);
