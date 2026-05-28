#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { CMakeFileApiReader } from "./cmake/index.js";
import { IarGenerator } from "./iar/index.js";
import { EclipseGenerator } from "./eclipse/index.js";
import { UVisionGenerator } from "./uvision/index.js";

interface CliArgs {
  inputDir?: string;   // optional — not required when only --eclipse is specified
  force: boolean;
  iar?: string;
  eclipse?: string;
  uvision?: string;
  greenhills?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let inputDir: string | undefined;
  let force = false;
  let iar: string | undefined;
  let eclipse: string | undefined;
  let uvision: string | undefined;
  let greenhills: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--force" || a === "-f") {
      force = true;
    } else if (a === "-h" || a === "--help") {
      usage();
      process.exit(0);
    } else if (a === "--input") {
      inputDir = argv[++i];
      if (!inputDir) { console.error("--input requires a value"); usage(); process.exit(1); }
    } else if (a === "--iar") {
      iar = argv[++i];
      if (!iar) { console.error("--iar requires an output directory"); usage(); process.exit(1); }
    } else if (a === "--eclipse") {
      eclipse = argv[++i];
      if (!eclipse) { console.error("--eclipse requires an output directory"); usage(); process.exit(1); }
    } else if (a === "--uvision") {
      uvision = argv[++i];
      if (!uvision) { console.error("--uvision requires an output directory"); usage(); process.exit(1); }
    } else if (a === "--greenhills") {
      greenhills = argv[++i];
      if (!greenhills) { console.error("--greenhills requires an output directory"); usage(); process.exit(1); }
    } else if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`);
      usage();
      process.exit(1);
    } else {
      console.error(`Unexpected positional argument: ${a}`);
      usage();
      process.exit(1);
    }
  }

  if (!iar && !eclipse && !uvision && !greenhills) {
    console.error("At least one output target (--iar, --eclipse, --uvision, --greenhills) is required");
    usage();
    process.exit(1);
  }

  // --input is required for all backends except --eclipse-only (in-place mode)
  const needsNonEclipseBackend = iar || uvision || greenhills;
  if (!inputDir && needsNonEclipseBackend) {
    console.error("--input is required when using --iar, --uvision, or --greenhills");
    usage();
    process.exit(1);
  }

  return { inputDir, force, iar, eclipse, uvision, greenhills };
}

function usage(): void {
  console.error("Usage: cmod [--input <cmake-source-dir>] [--iar <output-dir>] [--eclipse <eclipse-dir>]");
  console.error("             [--uvision <output-dir>] [--greenhills <output-dir>] [--force]");
  console.error("");
  console.error("  --input <cmake-source-dir>    root of the CMake project source tree");
  console.error("  --iar <output-dir>            generate an IAR workspace in <output-dir>");
  console.error("  --eclipse <eclipse-dir>       cmake4eclipse mode:");
  console.error("                                  without --input: modify cmake project in-place");
  console.error("                                  with --input:    copy <cmake-source-dir> to");
  console.error("                                                   <eclipse-dir>, then add Eclipse files");
  console.error("  --uvision <output-dir>        generate a Keil µVision workspace in <output-dir>");
  console.error("  --greenhills <output-dir>     generate a Green Hills project (not yet implemented)");
  console.error("  --force, -f                   overwrite output directory if it exists");
}

async function isEmpty(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length === 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function prepareEmptyDir(dir: string, force: boolean, label: string): Promise<void> {
  if (await exists(dir)) {
    if (force) {
      console.log(`Deleting existing ${label}: ${dir}`);
      await fs.rm(dir, { recursive: true, force: true });
    } else if (!(await isEmpty(dir))) {
      throw new Error(
        `${label} exists and is not empty: ${dir} (use --force to overwrite)`,
      );
    } else {
      console.log(`${label} already exists and is empty: ${dir}`);
    }
  }
  console.log(`Creating ${label}: ${dir}`);
  await fs.mkdir(dir, { recursive: true });
}

/** Recursively copy all files from srcDir into destDir. */
async function copyDirRecursive(srcDir: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(src, dest);
    } else {
      await fs.copyFile(src, dest);
    }
  }
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${cmd} ${args.join(" ")} exited with ${
              signal ? `signal ${signal}` : `code ${code}`
            }`,
          ),
        );
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const sourceDir = args.inputDir ? path.resolve(args.inputDir) : undefined;

  // Resolve toolchain files; uvision prefers keil.cmake but falls back to gcc.cmake.
  const uvisionToolchain = sourceDir
    ? (await exists(path.join(sourceDir, "toolchains", "keil.cmake")))
      ? path.join(sourceDir, "toolchains", "keil.cmake")
      : path.join(sourceDir, "toolchains", "gcc.cmake")
    : "";
  const toolchainFiles: Record<string, string> = {
    iar: sourceDir ? path.join(sourceDir, "toolchains", "iar.cmake") : "",
    eclipse: sourceDir ? path.join(sourceDir, "toolchains", "gcc.cmake") : "",
    uvision: uvisionToolchain,
    greenhills: sourceDir ? path.join(sourceDir, "toolchains", "gcc.cmake") : "",
  };

  if (sourceDir) {
    console.log(`Source dir:  ${sourceDir}`);
    if (!(await exists(sourceDir))) {
      throw new Error(`CMake source directory does not exist: ${sourceDir}`);
    }
  }

  // Collect the backends to run
  type BackendEntry = {
    name: string;
    /** Directory where IDE files are written (always the eclipse dir or output dir). */
    destDir: string;
    toolchainFile: string;
    /** The CMake source root to configure — equals destDir for eclipse, sourceDir otherwise. */
    cmakeSourceDir: string;
  };
  const backends: BackendEntry[] = [];

  for (const name of ["iar", "eclipse", "uvision", "greenhills"] as const) {
    const rawDest = args[name];
    if (!rawDest) continue;

    if (name === "greenhills") {
      console.warn(`Warning: --${name} is not yet implemented and will be skipped.`);
      continue;
    }

    const destDir = path.resolve(rawDest);

    if (name === "eclipse") {
      const eclipseInPlace = !sourceDir;

      if (eclipseInPlace) {
        // In-place mode: eclipse dir IS the cmake source root — no copy, no prepareEmptyDir.
        console.log(`[eclipse] In-place mode: ${destDir}`);
        if (!(await exists(destDir))) {
          throw new Error(`Eclipse directory does not exist: ${destDir}`);
        }
        const toolchainFile = path.join(destDir, "toolchains", "gcc.cmake");
        console.log(`  [eclipse] toolchain: ${toolchainFile}`);
        if (!(await exists(toolchainFile))) {
          throw new Error(`Toolchain file does not exist: ${toolchainFile}`);
        }
        backends.push({ name, destDir, toolchainFile, cmakeSourceDir: destDir });
      } else {
        // Copy mode: copy source tree to destDir, then treat destDir as the cmake source.
        console.log(`  [eclipse] output dir: ${destDir}`);
        const toolchainFile = toolchainFiles[name];
        console.log(`  [eclipse] toolchain:  ${toolchainFile}`);
        if (!(await exists(toolchainFile))) {
          throw new Error(`Toolchain file does not exist: ${toolchainFile}`);
        }
        await prepareEmptyDir(destDir, args.force, "[eclipse] Output directory");
        console.log(`[eclipse] Copying source tree: ${sourceDir} → ${destDir}`);
        await copyDirRecursive(sourceDir!, destDir);
        backends.push({ name, destDir, toolchainFile: path.join(destDir, "toolchains", "gcc.cmake"), cmakeSourceDir: destDir });
      }
      continue;
    }

    // Non-eclipse backends — sourceDir is always required (validated in parseArgs)
    const destDirResolved = destDir;
    const toolchainFile = toolchainFiles[name];

    console.log(`  [${name}] output dir:    ${destDirResolved}`);
    console.log(`  [${name}] toolchain:     ${toolchainFile}`);

    if (!(await exists(toolchainFile))) {
      throw new Error(`Toolchain file does not exist: ${toolchainFile}`);
    }

    await prepareEmptyDir(destDirResolved, args.force, `[${name}] Output directory`);
    backends.push({ name, destDir: destDirResolved, toolchainFile, cmakeSourceDir: sourceDir! });
  }

  if (backends.length === 0) {
    throw new Error("No implemented backends to run.");
  }

  // Single cmake configure per backend into a shared temp build dir
  const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), "cmod-build-"));
  console.log(`Build dir:   ${buildDir} (temporary)`);

  const cleanup = async () => {
    try {
      await fs.rm(buildDir, { recursive: true, force: true });
      console.log(`Removed temporary build dir: ${buildDir}`);
    } catch {
      // best-effort cleanup
    }
  };

  for (const sig of ["SIGINT", "SIGTERM"] as NodeJS.Signals[]) {
    process.once(sig, async () => {
      await cleanup();
      process.exit(1);
    });
  }

  try {
    for (const backend of backends) {
      const backendBuildDir = path.join(buildDir, backend.name);

      const queryDir = path.join(backendBuildDir, ".cmake", "api", "v1", "query");
      console.log(`\n[${backend.name}] Configuring CMake from ${backend.cmakeSourceDir} ...`);
      await fs.mkdir(queryDir, { recursive: true });
      await fs.writeFile(path.join(queryDir, "codemodel-v2"), "");

      await runCommand(
        "cmake",
        [
          "-G",
          "Ninja",
          `-DCMAKE_TOOLCHAIN_FILE=${backend.toolchainFile}`,
          "-S",
          backend.cmakeSourceDir,
          "-B",
          backendBuildDir,
        ],
        process.cwd(),
      );

      const replyDir = path.join(backendBuildDir, ".cmake", "api", "v1", "reply");
      if (!(await exists(replyDir))) {
        throw new Error(`CMake did not produce a reply directory: ${replyDir}`);
      }

      console.log(`[${backend.name}] Reading CMake model ...`);
      const model = await CMakeFileApiReader.read(replyDir);
      const cfg = model.defaultConfiguration;
      if (!cfg) throw new Error(`No configurations in CMake model for ${backend.name}`);
      console.log(
        `[${backend.name}]   ${cfg.targets.length} targets in configuration '${cfg.name || "default"}'`,
      );
      for (const t of cfg.targets) {
        console.log(`[${backend.name}]     target: ${t.name} (${t.type})`);
      }

      if (backend.name === "iar") {
        console.log(`[iar] Generating IAR workspace in ${backend.destDir} ...`);
        const generator = new IarGenerator(model, { sourceDir: sourceDir!, destDir: backend.destDir });
        const result = await generator.generate();
        console.log(`[iar] Done. Wrote workspace: ${path.resolve(result.workspaceFile)}`);
        console.log(`[iar]   Projects (${result.projects.length}):`);
        for (const p of result.projects) console.log(`[iar]     - ${p}`);
      } else if (backend.name === "eclipse") {
        console.log(`[eclipse] Generating Eclipse files in ${backend.destDir} ...`);
        const generator = new EclipseGenerator(model, { sourceDir: backend.cmakeSourceDir, destDir: backend.destDir });
        const files = await generator.generate();
        console.log(`[eclipse] Done. Wrote ${files.length} Eclipse project file(s):`);
        for (const f of files) console.log(`[eclipse]   - ${f}`);
      } else if (backend.name === "uvision") {
        console.log(`[uvision] Generating Keil µVision workspace in ${backend.destDir} ...`);
        const generator = new UVisionGenerator(model, { sourceDir: sourceDir!, destDir: backend.destDir });
        const result = await generator.generate();
        console.log(`[uvision] Done. Wrote workspace: ${path.resolve(result.workspaceFile)}`);
        console.log(`[uvision]   Projects (${result.projects.length}):`);
        for (const p of result.projects) console.log(`[uvision]     - ${p}`);
      }
    }
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
