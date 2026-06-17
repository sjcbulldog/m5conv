import * as fs from "node:fs";
import * as path from "node:path";

type ComponentScope = "local" | "global";

interface ComponentEntry {
  name: string;
  type: ComponentScope;
  description: string;
}

interface AssetManifest {
  components: ComponentEntry[];
}

const COMPONENT_PREFIX = "COMPONENT_";
const DEFAULT_ASSETS_DIR = "assets";
const MANIFEST_FILE = "asset.json";
const DESCRIPTION_TEMPLATE = "TBD";

interface CliOptions {
  sdkDir?: string;
  assetsDirArg?: string;
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--sdk") {
      const sdkDir = argv[i + 1];
      if (!sdkDir || sdkDir.startsWith("--")) {
        throw new Error("Missing value for --sdk");
      }

      options.sdkDir = sdkDir;
      i += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (options.assetsDirArg) {
      throw new Error("Only one positional assets directory is allowed");
    }

    options.assetsDirArg = arg;
  }

  return options;
}

function getAssetsDirectory(): string {
  const options = parseCliOptions(process.argv.slice(2));

  if (options.sdkDir) {
    return path.resolve(process.cwd(), options.sdkDir, DEFAULT_ASSETS_DIR);
  }

  const selected = options.assetsDirArg && options.assetsDirArg.trim().length > 0
    ? options.assetsDirArg
    : DEFAULT_ASSETS_DIR;
  return path.resolve(process.cwd(), selected);
}

function listSubdirectories(parentDir: string): string[] {
  return fs
    .readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function getAssetDirectories(assetsDir: string): string[] {
  return listSubdirectories(assetsDir)
    .map((name) => path.join(assetsDir, name))
    .filter(isDirectory)
    .sort((a, b) => a.localeCompare(b));
}

function collectComponentNames(dir: string, found: Set<string>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(COMPONENT_PREFIX)) {
      found.add(entry.name);
    }
    collectComponentNames(path.join(dir, entry.name), found);
  }
}

function getComponentNamesForAsset(assetDir: string): string[] {
  const found = new Set<string>();
  collectComponentNames(assetDir, found);
  return [...found].sort((a, b) => a.localeCompare(b));
}

function buildComponentAssetIndex(assetComponentsMap: Map<string, string[]>): Map<string, Set<string>> {
  const componentToAssets = new Map<string, Set<string>>();

  for (const [assetName, components] of assetComponentsMap) {
    for (const componentName of components) {
      if (!componentToAssets.has(componentName)) {
        componentToAssets.set(componentName, new Set<string>());
      }
      componentToAssets.get(componentName)?.add(assetName);
    }
  }

  return componentToAssets;
}

function ensureStableJson(data: AssetManifest): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function createManifestForAsset(componentNames: string[], componentAssetIndex: Map<string, Set<string>>): AssetManifest {
  const components: ComponentEntry[] = componentNames.map((componentName) => {
    const referencingAssets = componentAssetIndex.get(componentName);
    const type: ComponentScope = referencingAssets && referencingAssets.size > 1 ? "global" : "local";

    return {
      name: componentName,
      type,
      description: DESCRIPTION_TEMPLATE,
    };
  });

  return { components };
}

function writeManifest(assetDir: string, manifest: AssetManifest): void {
  const filePath = path.join(assetDir, MANIFEST_FILE);
  fs.writeFileSync(filePath, ensureStableJson(manifest), "utf8");
}

function run(): void {
  let assetsDir: string;
  try {
    assetsDir = getAssetsDirectory();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid CLI arguments";
    console.error(message);
    process.exitCode = 1;
    return;
  }

  if (!isDirectory(assetsDir)) {
    console.error(`Assets directory not found: ${assetsDir}`);
    process.exitCode = 1;
    return;
  }

  const assetDirs = getAssetDirectories(assetsDir);
  const assetComponentsMap = new Map<string, string[]>();

  for (const assetDir of assetDirs) {
    const assetName = path.basename(assetDir);
    const components = getComponentNamesForAsset(assetDir);
    assetComponentsMap.set(assetName, components);
  }

  const componentAssetIndex = buildComponentAssetIndex(assetComponentsMap);

  for (const assetDir of assetDirs) {
    const assetName = path.basename(assetDir);
    const componentNames = assetComponentsMap.get(assetName) ?? [];
    const manifest = createManifestForAsset(componentNames, componentAssetIndex);
    writeManifest(assetDir, manifest);
    console.log(`Wrote ${path.join(assetDir, MANIFEST_FILE)} (${componentNames.length} components)`);
  }

  console.log(`Processed ${assetDirs.length} asset(s).`);
}

run();
