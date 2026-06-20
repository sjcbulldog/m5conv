#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";

type CliOptions = {
  inputDir: string;
  outputDir: string;
  bsps: string[];
  force: boolean;
  logLevel: "quiet" | "info" | "verbose";
};

type AppMetadata = {
  name: string;
  bsps: string[];
  projects: Record<string, { assets: string[] }>;
};

type InputAppInfo = {
  appName: string;
  appPath: string;
  projectAssets: Record<string, string[]>;
  appBsps: string[];
  bspDirByName: Map<string, string>;
  bspAssets: Set<string>;
};

type RunStats = {
  appsProcessed: number;
  appsCreated: number;
  appsMerged: number;
  assetsCopied: number;
  assetsSkipped: number;
  bspsCopied: number;
  bspsSkipped: number;
};

class Logger {
  private readonly level: "quiet" | "info" | "verbose";

  constructor(level: "quiet" | "info" | "verbose") {
    this.level = level;
  }

  public info(message: string): void {
    if (this.level === "info" || this.level === "verbose") {
      console.log(message);
    }
  }

  public verbose(message: string): void {
    if (this.level === "verbose") {
      console.log(message);
    }
  }
}

function main(): void {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const logger = new Logger(opts.logLevel);
    const stats = createEmptyStats();

    logger.info(`Input: ${opts.inputDir}`);
    logger.info(`Output: ${opts.outputDir}`);
    logger.info(`Selected BSPs: ${opts.bsps.join(", ")}`);

    validateInputDirectory(opts.inputDir);
    prepareOutputDirectory(opts.outputDir, opts.force, logger);
    processApplications(opts, logger, stats);
    logger.info(formatRunSummary(stats));
    console.log(`SDK creation complete: ${opts.outputDir}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): CliOptions {
  let inputDir = "";
  let outputDir = "";
  let bspRaw = "";
  let force = false;
  let logLevel: "quiet" | "info" | "verbose" = "info";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--quiet") {
      logLevel = "quiet";
      continue;
    }
    if (arg === "--verbose") {
      logLevel = "verbose";
      continue;
    }

    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }

    if (arg === "--input") {
      inputDir = next;
      i += 1;
      continue;
    }
    if (arg === "--output") {
      outputDir = next;
      i += 1;
      continue;
    }
    if (arg === "--bsps") {
      bspRaw = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!inputDir || !outputDir || !bspRaw) {
    throw new Error(
      "Usage: sdkmake --input DIRNAME --bsps BSPLIST --output DIRNAME [--force] [--verbose|--quiet]",
    );
  }

  const bsps = Array.from(
    new Set(
      bspRaw
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0),
    ),
  );

  if (bsps.length === 0) {
    throw new Error("--bsps must contain at least one BSP");
  }

  return {
    inputDir: path.resolve(inputDir),
    outputDir: path.resolve(outputDir),
    bsps,
    force,
    logLevel,
  };
}

function validateInputDirectory(inputDir: string): void {
  if (!fs.existsSync(inputDir)) {
    throw new Error(`Input directory does not exist: ${inputDir}`);
  }
  const stat = fs.statSync(inputDir);
  if (!stat.isDirectory()) {
    throw new Error(`Input path is not a directory: ${inputDir}`);
  }
}

function prepareOutputDirectory(outputDir: string, force: boolean, logger: Logger): void {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    logger.info("Created output directory.");
    return;
  }

  const stat = fs.statSync(outputDir);
  if (!stat.isDirectory()) {
    throw new Error(`Output path is not a directory: ${outputDir}`);
  }

  const items = fs.readdirSync(outputDir);
  if (items.length === 0) {
    return;
  }

  if (!force) {
    throw new Error(`Output directory is not empty: ${outputDir}. Use --force to delete everything.`);
  }

  logger.info("Output directory is non-empty and --force is set. Deleting existing contents.");
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
}

function findMtb4AppDirectories(dir: string): string[] {
  const results: string[] = [];
  const mtbCmakePath = path.join(dir, "mtb.cmake");
  if (fs.existsSync(mtbCmakePath) && fs.statSync(mtbCmakePath).isFile()) {
    results.push(dir);
    return results;
  }

  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      const found = findMtb4AppDirectories(path.join(dir, ent.name));
      for (const f of found) {
        results.push(f);
      }
    }
  }
  return results;
}

function processApplications(opts: CliOptions, logger: Logger, stats: RunStats): void {
  const appsOutDir = path.join(opts.outputDir, "apps");
  const assetsOutDir = path.join(opts.outputDir, "assets");
  const bspsOutDir = path.join(opts.outputDir, "bsps");

  fs.mkdirSync(appsOutDir, { recursive: true });
  fs.mkdirSync(assetsOutDir, { recursive: true });
  fs.mkdirSync(bspsOutDir, { recursive: true });

  const appDirs = findMtb4AppDirectories(opts.inputDir);

  if (appDirs.length === 0) {
    throw new Error(`No mtb4 application directories (containing mtb.cmake) found under: ${opts.inputDir}`);
  }

  logger.info(`Found ${appDirs.length} application(s) to process.`);

  for (let i = 0; i < appDirs.length; i += 1) {
    const appDir = appDirs[i];
    logger.info(`[${i + 1}/${appDirs.length}] Processing ${path.basename(appDir)}...`);
    const appInfo = analyzeInputApp(appDir);
    validateAppBspsAgainstSelection(appInfo, opts.bsps);
    upsertApplication(appInfo, appsOutDir, assetsOutDir, bspsOutDir, logger, stats);
    stats.appsProcessed += 1;
  }
}

function analyzeInputApp(appDir: string): InputAppInfo {
  const appName = path.basename(appDir);
  const projectDirs = findProjectDirectories(appDir);
  if (projectDirs.length === 0) {
    throw new Error(`Application has no projects with firmware.cmake: ${appName}`);
  }

  const projectAssets: Record<string, string[]> = {};
  for (const projectDir of projectDirs) {
    const projectName = path.basename(projectDir);
    const firmwarePath = path.join(projectDir, "firmware.cmake");
    const assets = parseAssetsFromFirmware(firmwarePath);
    projectAssets[projectName] = assets;
  }

  const { bspNames, bspDirByName } = discoverAppBsps(appDir);
  if (bspNames.length === 0) {
    throw new Error(`Application has no BSPs in bsps/: ${appName}`);
  }

  const bspAssets = new Set<string>();
  for (const bspDir of bspDirByName.values()) {
    for (const asset of readBspJsonAssets(bspDir)) {
      bspAssets.add(asset);
    }
  }

  return {
    appName,
    appPath: appDir,
    projectAssets,
    appBsps: bspNames,
    bspDirByName,
    bspAssets,
  };
}

function findProjectDirectories(appDir: string): string[] {
  const entries = fs.readdirSync(appDir, { withFileTypes: true });
  const projectDirs: string[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) {
      continue;
    }
    const projectPath = path.join(appDir, ent.name);
    const firmwarePath = path.join(projectPath, "firmware.cmake");
    if (fs.existsSync(firmwarePath) && fs.statSync(firmwarePath).isFile()) {
      projectDirs.push(projectPath);
    }
  }
  return projectDirs;
}

function parseAssetsFromFirmware(firmwarePath: string): string[] {
  const content = fs.readFileSync(firmwarePath, "utf8");
  const lines = content.split(/\r?\n/);
  const assets: string[] = [];

  for (const line of lines) {
    if (!line.includes("add_subdirectory")) {
      continue;
    }
    const asset = extractAssetNameFromAddSubdirectory(line);
    if (asset) {
      assets.push(asset);
    }
  }

  return uniqueInOrder(assets);
}

function extractAssetNameFromAddSubdirectory(line: string): string | null {
  const fullCallRegex = /add_subdirectory\(\s*([^\s\)]+)\s+[^\)]*\)/;
  const callMatch = line.match(fullCallRegex);
  if (!callMatch) {
    return null;
  }

  const assetPath = callMatch[1].replaceAll("\\", "/");
  const assetMatch = assetPath.match(/\/assets\/([A-Za-z0-9._-]+)/);
  if (!assetMatch) {
    return null;
  }
  return assetMatch[1];
}

function discoverAppBsps(appDir: string): { bspNames: string[]; bspDirByName: Map<string, string> } {
  const bspsDir = path.join(appDir, "bsps");
  if (!fs.existsSync(bspsDir) || !fs.statSync(bspsDir).isDirectory()) {
    return { bspNames: [], bspDirByName: new Map<string, string>() };
  }

  const bspDirByName = new Map<string, string>();
  const bspNames: string[] = [];

  for (const ent of fs.readdirSync(bspsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) {
      continue;
    }

    const fullName = ent.name;
    const shortName = fullName.startsWith("TARGET_APP_") ? fullName.slice("TARGET_APP_".length) : fullName;
    if (!shortName) {
      continue;
    }
    bspNames.push(shortName);
    bspDirByName.set(shortName, path.join(bspsDir, fullName));
  }

  return {
    bspNames: uniqueInOrder(bspNames),
    bspDirByName,
  };
}

function readBspJsonAssets(bspDir: string): string[] {
  const bspJsonPath = path.join(bspDir, "bsp.json");
  if (!fs.existsSync(bspJsonPath)) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(bspJsonPath, "utf8"));
  } catch {
    throw new Error(`Invalid JSON in ${bspJsonPath}`);
  }
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const assets = (parsed as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) {
    return [];
  }
  return assets.filter((a): a is string => typeof a === "string");
}

function filterBspAssetsFromProjects(
  projectAssets: Record<string, string[]>,
  bspAssets: Set<string>,
): Record<string, string[]> {
  const filtered: Record<string, string[]> = {};
  for (const [projectName, assets] of Object.entries(projectAssets)) {
    filtered[projectName] = assets.filter((a) => !bspAssets.has(a));
  }
  return filtered;
}

function validateAppBspsAgainstSelection(app: InputAppInfo, selectedBsps: string[]): void {
  const selected = new Set(selectedBsps);
  for (const appBsp of app.appBsps) {
    if (!selected.has(appBsp)) {
      throw new Error(`Application ${app.appName} contains BSP ${appBsp} that is not in --bsps`);
    }
  }
}

function upsertApplication(
  app: InputAppInfo,
  appsOutDir: string,
  assetsOutDir: string,
  bspsOutDir: string,
  logger: Logger,
  stats: RunStats,
): void {
  const appOutputPath = path.join(appsOutDir, app.appName);
  const incomingMetadata: AppMetadata = {
    name: app.appName,
    bsps: [...app.appBsps].sort(),
    projects: normalizeProjectsMap(filterBspAssetsFromProjects(app.projectAssets, app.bspAssets)),
  };

  if (!fs.existsSync(appOutputPath)) {
    copyAppTemplateStripped(app.appPath, appOutputPath);
    writeDescJson(appOutputPath, incomingMetadata);
    stats.appsCreated += 1;
    logger.info(`Created app template ${app.appName}.`);
  } else {
    const descPath = path.join(appOutputPath, "desc.json");
    if (!fs.existsSync(descPath)) {
      throw new Error(`Existing app missing desc.json: ${app.appName}`);
    }

    const existing = readDescJson(descPath);
    const mergedProjects = mergeProjectsMetadata(existing, incomingMetadata, app.appName);

    const existingBsps = new Set(existing.bsps);
    const newBsps = incomingMetadata.bsps.filter((bsp) => !existingBsps.has(bsp));

    const hasNewAssets = Object.keys(mergedProjects).some(
      (projectName) => mergedProjects[projectName].assets.length > existing.projects[projectName].assets.length,
    );

    if (newBsps.length === 0 && !hasNewAssets) {
      throw new Error(`Application ${app.appName} already exists and does not add any new BSPs or assets`);
    }

    const merged: AppMetadata = {
      ...existing,
      bsps: [...new Set([...existing.bsps, ...incomingMetadata.bsps])].sort(),
      projects: mergedProjects,
    };
    writeDescJson(appOutputPath, merged);
    stats.appsMerged += 1;
    logger.info(`Merged BSPs into existing app ${app.appName}.`);
  }

  sanitizeProjectAppInfoFiles(appOutputPath);

  copyAssetsForApplication(app, assetsOutDir, logger, stats);
  copyBspsForApplication(app, bspsOutDir, logger, stats);
}
function copyAppTemplateStripped(sourceAppPath: string, destAppPath: string): void {
  fs.mkdirSync(destAppPath, { recursive: true });
  const entries = fs.readdirSync(sourceAppPath, { withFileTypes: true });

  for (const ent of entries) {
    if (ent.name === "assets" || ent.name === "bsps") {
      continue;
    }

    const src = path.join(sourceAppPath, ent.name);
    const dst = path.join(destAppPath, ent.name);

    if (ent.isDirectory()) {
      fs.cpSync(src, dst, { recursive: true });
    } else if (ent.isFile()) {
      fs.cpSync(src, dst);
    }
  }

  regenerateProjectFirmwareFiles(destAppPath);
}

function regenerateProjectFirmwareFiles(appPath: string): void {
  const firmwareContent = [
    "# This file is generated and managed by the ModusToolbox library manager.",
    "# Do not edit this file by hand.",
    "",
  ].join("\n");

  const entries = fs.readdirSync(appPath, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) {
      continue;
    }

    const firmwarePath = path.join(appPath, ent.name, "firmware.cmake");
    if (!fs.existsSync(firmwarePath)) {
      continue;
    }

    fs.rmSync(firmwarePath, { force: true });
    fs.writeFileSync(firmwarePath, firmwareContent, "utf8");
  }
}

function sanitizeProjectAppInfoFiles(appPath: string): void {
  const rootAppInfoPath = path.join(appPath, "appinfo.cmake");
  if (fs.existsSync(rootAppInfoPath)) {
    sanitizeAppInfoFile(rootAppInfoPath);
  }

  const entries = fs.readdirSync(appPath, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) {
      continue;
    }

    const projectAppInfoPath = path.join(appPath, ent.name, "appinfo.cmake");
    if (fs.existsSync(projectAppInfoPath)) {
      sanitizeAppInfoFile(projectAppInfoPath);
    }
  }
}

function sanitizeAppInfoFile(appInfoPath: string): void {
  const original = fs.readFileSync(appInfoPath, "utf8");
  const sanitized = removeDeviceAndBspPathSetLines(original);
  if (sanitized !== original) {
    fs.writeFileSync(appInfoPath, sanitized, "utf8");
  }
}

function removeDeviceAndBspPathSetLines(content: string): string {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  const filtered = lines.filter((line) => !/^\s*set\s*\(\s*(MTBDEVICE|MTBDEVICELIST|BSPPATH)\b/.test(line));
  const result = filtered.join(lineEnding);
  return hadTrailingNewline ? result + lineEnding : result;
}

function writeDescJson(appOutputPath: string, metadata: AppMetadata): void {
  const descPath = path.join(appOutputPath, "desc.json");
  const normalized: AppMetadata = {
    name: metadata.name,
    bsps: [...new Set(metadata.bsps)].sort(),
    projects: normalizeProjectsMap(
      Object.fromEntries(
        Object.entries(metadata.projects).map(([project, value]) => [project, value.assets]),
      ),
    ),
  };

  fs.writeFileSync(descPath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
}

function readDescJson(descPath: string): AppMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(descPath, "utf8"));
  } catch {
    throw new Error(`Invalid JSON in ${descPath}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`desc.json must be an object: ${descPath}`);
  }

  const obj = parsed as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : "";
  const bsps = Array.isArray(obj.bsps) ? obj.bsps.filter((b): b is string => typeof b === "string") : [];
  const projectsObj = obj.projects;

  if (!name || !projectsObj || typeof projectsObj !== "object" || !Array.isArray(bsps)) {
    throw new Error(`desc.json has missing or invalid fields: ${descPath}`);
  }

  const projects: Record<string, { assets: string[] }> = {};
  for (const [projectName, value] of Object.entries(projectsObj as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      throw new Error(`desc.json project ${projectName} is invalid: ${descPath}`);
    }
    const assetsValue = (value as { assets?: unknown }).assets;
    if (!Array.isArray(assetsValue)) {
      throw new Error(`desc.json project ${projectName} assets must be an array: ${descPath}`);
    }
    const assets = assetsValue.filter((a): a is string => typeof a === "string");
    projects[projectName] = { assets: uniqueInOrder(assets).sort() };
  }

  return {
    name,
    bsps: uniqueInOrder(bsps).sort(),
    projects,
  };
}

function mergeProjectsMetadata(
  existing: AppMetadata,
  incoming: AppMetadata,
  appName: string,
): Record<string, { assets: string[] }> {
  const existingProjects = Object.keys(existing.projects).sort();
  const incomingProjects = Object.keys(incoming.projects).sort();

  if (existingProjects.length !== incomingProjects.length || existingProjects.some((p, i) => p !== incomingProjects[i])) {
    throw new Error(`Project structure mismatch for app ${appName}: project sets differ`);
  }

  const merged: Record<string, { assets: string[] }> = {};
  for (const projectName of existingProjects) {
    const combined = uniqueInOrder([...existing.projects[projectName].assets, ...incoming.projects[projectName].assets]).sort();
    merged[projectName] = { assets: combined };
  }
  return merged;
}

function copyAssetsForApplication(app: InputAppInfo, assetsOutDir: string, logger: Logger, stats: RunStats): void {
  const allAssetNames = uniqueInOrder([
    ...Object.values(app.projectAssets).flat().filter((v) => v.length > 0),
    ...app.bspAssets,
  ]);
  const appAssetsDir = path.join(app.appPath, "assets");

  for (const assetName of allAssetNames) {
    const src = path.join(appAssetsDir, assetName);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      throw new Error(`Missing asset directory in ${app.appName}: assets/${assetName}`);
    }

    const dst = path.join(assetsOutDir, assetName);
    if (fs.existsSync(dst)) {
      stats.assetsSkipped += 1;
      logger.verbose(`Asset already present, skipping copy: ${assetName}`);
      continue;
    }
    fs.cpSync(src, dst, { recursive: true });
    stats.assetsCopied += 1;
    logger.verbose(`Copied asset: ${assetName}`);
  }
}

function copyBspsForApplication(app: InputAppInfo, bspsOutDir: string, logger: Logger, stats: RunStats): void {
  for (const bspName of app.appBsps) {
    const src = app.bspDirByName.get(bspName);
    if (!src) {
      throw new Error(`Missing BSP source directory mapping in ${app.appName}: ${bspName}`);
    }

    const srcDirName = path.basename(src);
    const dstDirName = stripTargetAppPrefix(srcDirName);
    const dst = path.join(bspsOutDir, dstDirName);
    if (fs.existsSync(dst)) {
      stats.bspsSkipped += 1;
      logger.verbose(`BSP already present, skipping copy: ${dstDirName}`);
      continue;
    }
    fs.cpSync(src, dst, { recursive: true });
    stats.bspsCopied += 1;
    logger.verbose(`Copied BSP: ${dstDirName}`);
  }
}

function stripTargetAppPrefix(name: string): string {
  return name.replace(/^TARGET_APP_?/, "");
}

function createEmptyStats(): RunStats {
  return {
    appsProcessed: 0,
    appsCreated: 0,
    appsMerged: 0,
    assetsCopied: 0,
    assetsSkipped: 0,
    bspsCopied: 0,
    bspsSkipped: 0,
  };
}

function formatRunSummary(stats: RunStats): string {
  return [
    "Run summary:",
    `  apps processed: ${stats.appsProcessed}`,
    `  apps created:   ${stats.appsCreated}`,
    `  apps merged:    ${stats.appsMerged}`,
    `  assets copied:  ${stats.assetsCopied}`,
    `  assets skipped: ${stats.assetsSkipped}`,
    `  bsps copied:    ${stats.bspsCopied}`,
    `  bsps skipped:   ${stats.bspsSkipped}`,
  ].join("\n");
}

function normalizeProjectsMap(input: Record<string, string[]>): Record<string, { assets: string[] }> {
  const projects: Record<string, { assets: string[] }> = {};
  for (const projectName of Object.keys(input).sort()) {
    projects[projectName] = { assets: uniqueInOrder(input[projectName]).sort() };
  }
  return projects;
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

main();
