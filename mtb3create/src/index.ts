#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ParsedArgs = {
  bsps: string[];
  dest: string;
  creator: string;
  force: boolean;
};

type ExecResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: number;
};

type CreatePlan = {
  bsp: string;
  appId: string;
  appPath: string;
};

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));

    await validateCreatorPath(args.creator);
    await prepareDestination(args.dest, args.force);

    const plans = await buildPlans(args.bsps, args.dest, args.creator);
    if (plans.length === 0) {
      console.log("No valid applications found for the requested BSP list.");
      return;
    }

    console.log(`Creating ${plans.length} applications...`);
    let created = 0;

    for (const plan of plans) {
      process.stdout.write(`- ${plan.appId} (BSP: ${plan.bsp}) ... `);
      const createResult = await createApplication(args.creator, plan.bsp, plan.appId, plan.appPath);
      await writeCreateLog(plan, createResult);
      if (!createResult.ok) {
        process.stdout.write("FAILED\n");
        console.error(composeCreateFailureMessage(plan, createResult));
        continue;
      }
      created += 1;
      process.stdout.write("OK\n");
    }

    console.log(`Done. Created ${created} of ${plans.length} applications.`);
    if (created !== plans.length) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const argMap = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    if (token === "--force") {
      argMap.set("force", true);
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for argument ${token}`);
    }

    if (token === "--bsp") {
      argMap.set("bsp", value);
    } else if (token === "--dest") {
      argMap.set("dest", value);
    } else if (token === "--creator") {
      argMap.set("creator", value);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
    i += 1;
  }

  const bspRaw = asStringOrThrow(argMap.get("bsp"), "--bsp is required");
  const destRaw = asStringOrThrow(argMap.get("dest"), "--dest is required");
  const creatorRaw = asStringOrThrow(argMap.get("creator"), "--creator is required");

  const bsps = bspRaw
    .split(",")
    .map((bsp) => bsp.trim())
    .filter((bsp) => bsp.length > 0);

  if (bsps.length === 0) {
    throw new Error("--bsp must include at least one BSP value");
  }

  return {
    bsps,
    dest: resolve(destRaw),
    creator: resolve(creatorRaw),
    force: Boolean(argMap.get("force")),
  };
}

function asStringOrThrow(value: string | boolean | undefined, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value;
}

function printHelp(): void {
  console.log(`Usage:
  mtb3create --bsp BSPLIST --dest PATH --creator PATH [--force]

Arguments:
  --bsp      Comma-separated BSP list, e.g. BSP_DESIGN_MODUS3,BSP_FOO
  --dest     Destination directory for created applications
  --creator  Path to ModusToolbox project creator executable
  --force    If --dest exists and is not empty, delete its contents first
`);
}

async function validateCreatorPath(creatorPath: string): Promise<void> {
  try {
    await access(creatorPath, fsConstants.F_OK);
  } catch {
    throw new Error(`--creator path does not exist: ${creatorPath}`);
  }
}

async function prepareDestination(dest: string, force: boolean): Promise<void> {
  let exists = true;
  try {
    await access(dest, fsConstants.F_OK);
  } catch {
    exists = false;
  }

  if (!exists) {
    await mkdir(dest, { recursive: true });
    return;
  }

  const destStat = await stat(dest);
  if (!destStat.isDirectory()) {
    throw new Error(`--dest must be a directory path: ${dest}`);
  }

  const entries = await readdir(dest);
  if (entries.length === 0) {
    return;
  }

  if (!force) {
    throw new Error(`--dest is not empty (${dest}). Use --force to delete its current contents.`);
  }

  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
}

async function buildPlans(bsps: string[], dest: string, creator: string): Promise<CreatePlan[]> {
  const plans: CreatePlan[] = [];
  const seen = new Set<string>();

  for (const bsp of bsps) {
    const appIds = await listApplicationsForBsp(creator, bsp);
    if (appIds.length === 0) {
      console.warn(`No applications found for BSP ${bsp}`);
      continue;
    }

    for (const appId of appIds) {
      if (seen.has(appId)) {
        console.warn(`Skipping duplicate app id across BSPs: ${appId}`);
        continue;
      }
      seen.add(appId);
      plans.push({ bsp, appId, appPath: resolve(dest, appId) });
    }
  }

  return plans;
}

async function listApplicationsForBsp(creator: string, bsp: string): Promise<string[]> {
  const candidates: string[][] = [
    ["--list-apps", bsp],
    ["list", "-b", bsp],
    ["--list", "-b", bsp],
    ["--mode", "list", "-b", bsp],
  ];

  const errors: string[] = [];

  for (const args of candidates) {
    const result = await runCreator(creator, args);
    if (!result.ok) {
      errors.push(formatFailedInvocation(args, result));
      continue;
    }

    const appIds = extractAppIds(result.stdout);
    if (appIds.length > 0) {
      return appIds;
    }

    errors.push(`Invocation succeeded but no app ids were parsed: ${args.join(" ")}`);
  }

  throw new Error(`Unable to list apps for BSP ${bsp}. Tried:\n${errors.join("\n")}`);
}

function extractAppIds(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }

  // Some creators can emit JSON arrays; parse that path first.
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const ids = parsed
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => isLikelyAppId(item));
      return Array.from(new Set(ids));
    }
  } catch {
    // Not JSON output; continue with line parser.
  }

  const ids: string[] = [];
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const listStartIndex = lines.findIndex((line) =>
    line.startsWith("List of template applications supported"),
  );
  const candidateLines = listStartIndex >= 0 ? lines.slice(listStartIndex + 1) : lines;

  for (const line of candidateLines) {
    if (/^(app\s*id|id|name)\b/i.test(line)) {
      continue;
    }
    if (/^[-=|\s]+$/.test(line)) {
      continue;
    }

    const lineAfterPrefix = line.replace(/^[-*]\s+/, "");

    const kvMatch = lineAfterPrefix.match(/^(?:app\s*id|id)\s*[:=]\s*([A-Za-z0-9._-]+)/i);
    if (kvMatch?.[1] && isLikelyAppId(kvMatch[1])) {
      ids.push(kvMatch[1]);
      continue;
    }

    const firstToken = lineAfterPrefix.split(/\s+/)[0];
    if (isLikelyAppId(firstToken)) {
      ids.push(firstToken);
    }
  }

  return Array.from(new Set(ids));
}

function isLikelyAppId(candidate: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate)) {
    return false;
  }

  const lower = candidate.toLowerCase();
  const banned = new Set(["app", "apps", "appid", "id", "name", "description", "true", "false"]);
  if (banned.has(lower)) {
    return false;
  }

  return candidate.length >= 3;
}

async function createApplication(
  creator: string,
  bsp: string,
  appId: string,
  appPath: string,
): Promise<ExecResult> {
  const targetDir = dirname(appPath);
  const candidates: string[][] = [
    ["--app-id", appId, "--board-id", bsp, "--target-dir", targetDir, "--user-app-name", appId],
    ["-a", appId, "-b", bsp, "-d", targetDir, "-n", appId],
  ];

  const errors: string[] = [];

  for (const args of candidates) {
    const result = await runCreator(creator, args);
    if (result.ok) {
      return result;
    }
    errors.push(formatFailedInvocation(args, result));
  }

  await rm(appPath, { recursive: true, force: true });

  return {
    ok: false,
    stdout: "",
    stderr: errors.join("\n"),
  };
}

function composeCreateFailureMessage(plan: CreatePlan, result: ExecResult): string {
  return [
    `Failed to create app ${plan.appId} for BSP ${plan.bsp}.`,
    "Tried multiple invocation patterns.",
    `See log: ${resolve(dirname(plan.appPath), `${plan.appId}.log`)}`,
    result.stderr,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

async function writeCreateLog(plan: CreatePlan, result: ExecResult): Promise<void> {
  const logPath = resolve(dirname(plan.appPath), `${plan.appId}.log`);
  const sections = [
    `appId: ${plan.appId}`,
    `bsp: ${plan.bsp}`,
    `status: ${result.ok ? "ok" : "failed"}`,
  ];

  if (result.stdout.trim().length > 0) {
    sections.push("", "[stdout]", result.stdout.trimEnd());
  }

  if (result.stderr.trim().length > 0) {
    sections.push("", "[stderr]", result.stderr.trimEnd());
  }

  await writeFile(logPath, `${sections.join("\n")}\n`, "utf8");
}

function formatFailedInvocation(args: string[], result: ExecResult): string {
  const code = result.code === undefined ? "unknown" : String(result.code);
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const detail = stderr || stdout || "no output";
  return `${args.join(" ")} => exit ${code}: ${detail}`;
}

async function runCreator(creator: string, args: string[]): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(creator, args, {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      ok: true,
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
    };
  } catch (error) {
    const maybe = error as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
    };

    return {
      ok: false,
      stdout: String(maybe.stdout ?? ""),
      stderr: String(maybe.stderr ?? maybe.message ?? ""),
      code: typeof maybe.code === "number" ? maybe.code : undefined,
    };
  }
}

void main();
