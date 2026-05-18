#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { CMakeFileApiReader } from "./cmake/index.js";
import { IarGenerator } from "./iar/index.js";
import { EclipseGenerator } from "./eclipse/index.js";

type Target = 'iar' | 'eclipse';

const VALID_TARGETS: Target[] = ['iar', 'eclipse'];

interface CliArgs {
  sourceDir: string;
  buildDir: string;
  destDir: string;
  force: boolean;
  target: Target;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let force = false;
  let target: Target | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force" || a === "-f") {
      force = true;
    } else if (a === "-h" || a === "--help") {
      usage();
      process.exit(0);
    } else if (a === "--target") {
      const val = argv[++i];
      if (!val) {
        console.error("--target requires a value");
        usage();
        process.exit(1);
      }
      if (!(VALID_TARGETS as string[]).includes(val)) {
        console.error(`Unknown target: ${val}. Valid targets: ${VALID_TARGETS.join(', ')}`);
        usage();
        process.exit(1);
      }
      target = val as Target;
    } else if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`);
      usage();
      process.exit(1);
    } else {
      positional.push(a);
    }
  }

  if (!target) {
    console.error("--target is required");
    usage();
    process.exit(1);
  }

  if (positional.length !== 3) {
    usage();
    process.exit(1);
  }

  return {
    sourceDir: positional[0],
    buildDir: positional[1],
    destDir: positional[2],
    force,
    target,
  };
}

function usage(): void {
  console.error(
    "Usage: cmod --target <TARGET> [--force] <cmake-source-dir> <cmake-build-dir> <output-dir>",
  );
  console.error("");
  console.error(`  --target <TARGET>     IDE target to generate for: ${VALID_TARGETS.join(', ')}`);
  console.error("  <cmake-source-dir>    root of the CMake project's source tree");
  console.error("  <cmake-build-dir>     CMake build directory to create (must not exist or be empty)");
  console.error("  <output-dir>          directory to populate with IDE project files (must not exist or be empty)");
  console.error("  --force, -f           delete <cmake-build-dir> and <output-dir> first if they exist");
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

  const sourceDir = path.resolve(args.sourceDir);
  const buildDir = path.resolve(args.buildDir);
  const destDir = path.resolve(args.destDir);

  const toolchainFiles: Record<Target, string> = {
    iar: path.join(sourceDir, "toolchains", "iar.cmake"),
    eclipse: path.join(sourceDir, "toolchains", "gcc.cmake"),
  };
  const toolchainFile = toolchainFiles[args.target];

  console.log(`Source dir:  ${sourceDir}`);
  console.log(`Build dir:   ${buildDir}`);
  console.log(`Output dir:  ${destDir}`);
  console.log(`Target:      ${args.target}`);

  if (!(await exists(sourceDir))) {
    throw new Error(`CMake source directory does not exist: ${sourceDir}`);
  }

  console.log(`Toolchain file: ${toolchainFile}`);
  if (!(await exists(toolchainFile))) {
    throw new Error(`Toolchain file does not exist: ${toolchainFile}`);
  }

  await prepareEmptyDir(buildDir, args.force, "Build directory");
  await prepareEmptyDir(destDir, args.force, "Output directory");

  const queryDir = path.join(buildDir, ".cmake", "api", "v1", "query");
  console.log(`Creating CMake File API query dir: ${queryDir}`);
  await fs.mkdir(queryDir, { recursive: true });
  await fs.writeFile(path.join(queryDir, "codemodel-v2"), "");

  console.log(`Running cmake in ${buildDir} ...`);
  await runCommand(
    "cmake",
    [
      "-G",
      "Ninja",
      `-DCMAKE_TOOLCHAIN_FILE=${toolchainFile}`,
      "-S",
      sourceDir,
      "-B",
      buildDir,
    ],
    process.cwd(),
  );

  const replyDir = path.join(buildDir, ".cmake", "api", "v1", "reply");
  if (!(await exists(replyDir))) {
    throw new Error(`CMake did not produce a reply directory: ${replyDir}`);
  }

  console.log(`Reading CMake model from ${replyDir} ...`);
  const model = await CMakeFileApiReader.read(replyDir);
  const cfg = model.defaultConfiguration;
  if (!cfg) throw new Error("No configurations in CMake model");
  console.log(
    `  ${cfg.targets.length} targets in configuration '${cfg.name || "default"}'`,
  );
  for (const t of cfg.targets) {
    console.log(`    target: ${t.name} (${t.type})`);
  }

  if (args.target === 'iar') {
    console.log(`Generating IAR workspace in ${destDir} ...`);
    const generator = new IarGenerator(model, { sourceDir, destDir });
    const result = await generator.generate();
    console.log(`Done. Wrote workspace: ${path.resolve(result.workspaceFile)}`);
    console.log(`  Projects (${result.projects.length}):`);
    for (const p of result.projects) console.log(`    - ${p}`);
  } else if (args.target === 'eclipse') {
    console.log(`Generating Eclipse projects in ${destDir} ...`);
    const generator = new EclipseGenerator(model, { sourceDir, destDir });
    const files = await generator.generate();
    console.log(`Done. Wrote ${files.length} Eclipse project file(s):`);
    for (const f of files) console.log(`    - ${f}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
