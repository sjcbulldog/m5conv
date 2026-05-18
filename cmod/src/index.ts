#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { CMakeFileApiReader } from "./cmake/index.js";
import { IarGenerator } from "./iar/index.js";

interface CliArgs {
  sourceDir: string;
  buildDir: string;
  destDir: string;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let force = false;
  for (const a of argv) {
    if (a === "--force" || a === "-f") force = true;
    else if (a === "-h" || a === "--help") {
      usage();
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`);
      usage();
      process.exit(1);
    } else {
      positional.push(a);
    }
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
  };
}

function usage(): void {
  console.error(
    "Usage: cmod [--force] <cmake-source-dir> <cmake-build-dir> <iar-project-dir>",
  );
  console.error("");
  console.error("  <cmake-source-dir>    root of the CMake project's source tree");
  console.error("  <cmake-build-dir>     CMake build directory to create (must not exist or be empty)");
  console.error("  <iar-project-dir>     directory to populate with the IAR workspace (must not exist or be empty)");
  console.error("  --force, -f           delete <cmake-build-dir> and <iar-project-dir> first if they exist");
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

  console.log(`Source dir:  ${sourceDir}`);
  console.log(`Build dir:   ${buildDir}`);
  console.log(`IAR dir:     ${destDir}`);

  if (!(await exists(sourceDir))) {
    throw new Error(`CMake source directory does not exist: ${sourceDir}`);
  }

  const toolchainFile = path.join(sourceDir, "toolchains", "iar.cmake");
  console.log(`Toolchain file: ${toolchainFile}`);
  if (!(await exists(toolchainFile))) {
    throw new Error(`Toolchain file does not exist: ${toolchainFile}`);
  }

  await prepareEmptyDir(buildDir, args.force, "Build directory");
  await prepareEmptyDir(destDir, args.force, "IAR project directory");

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

  console.log(`Generating IAR workspace in ${destDir} ...`);
  const generator = new IarGenerator(model, {
    sourceDir,
    destDir,
  });
  console.log("  Running IarGenerator.generate() ...");
  const result = await generator.generate();

  console.log(`Done. Wrote workspace: ${path.resolve(result.workspaceFile)}`);
  console.log(`  Projects (${result.projects.length}):`);
  for (const p of result.projects) console.log(`    - ${p}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
