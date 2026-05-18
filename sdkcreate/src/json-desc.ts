import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Parse the asset name out of a .mtb dependency file.
 *
 * Supported formats:
 *   https://github.com/Infineon/mtb-pdl-cat1#release-v3.11.0#$$ASSET_REPO$$/...
 *   mtb://retarget-io#latest-v1.X#$$ASSET_REPO$$/...
 *
 * In both cases the name is the last non-empty path segment of the part
 * before the first '#'.
 */
function parseMtbName(content: string): string | undefined {
  const urlPart = content.trim().split("#")[0].trim();
  const segments = urlPart.split("/").filter((s) => s.length > 0);
  return segments[segments.length - 1] || undefined;
}

/**
 * Read all .mtb files from a deps/ directory and return the middleware names.
 * Returns undefined if the directory does not exist.
 */
async function readDepsDir(
  depsDir: string,
  isMiddleware: (name: string) => boolean,
): Promise<string[] | undefined> {
  let entries: string[];
  try {
    entries = await readdir(depsDir);
  } catch {
    return undefined;
  }

  const mtbFiles = entries.filter((f) => f.endsWith(".mtb"));
  const mwDeps: string[] = [];
  for (const mtbFile of mtbFiles) {
    const content = await readFile(path.join(depsDir, mtbFile), "utf8");
    const name = parseMtbName(content);
    if (name && isMiddleware(name)) {
      mwDeps.push(name);
    }
  }
  return mwDeps.sort();
}

/**
 * Walk OUTPUT/examples/ and for each example write a deps.json at the
 * application level (above the version/project directories).
 *
 * Each version directory is scanned for projects that contain a deps/ folder:
 *   - Single-project layout: version/deps/*.mtb  → key "root"
 *   - Multi-project layout:  version/<proj>/deps/*.mtb → key = project dir name
 *
 * The resulting JSON maps project name → sorted list of required middleware.
 *
 * What counts as "middleware" is determined by cross-referencing the names
 * found in OUTPUT/middleware/. If that directory is absent, every dep that
 * does not start with "TARGET_" (the BSP naming convention) is included.
 */
export async function createJsonDesc(outputDir: string): Promise<void> {
  const examplesDir = path.join(outputDir, "examples");
  const middlewareDir = path.join(outputDir, "middleware");

  // Build a set of known middleware names from the middleware output directory.
  let knownMiddleware: Set<string> | null = null;
  try {
    const entries = await readdir(middlewareDir, { withFileTypes: true });
    knownMiddleware = new Set(
      entries.filter((e) => e.isDirectory()).map((e) => e.name),
    );
  } catch {
    // Middleware directory absent — fall back to excluding BSPs by prefix.
  }

  const isMiddleware = (name: string): boolean =>
    knownMiddleware !== null
      ? knownMiddleware.has(name)
      : !name.startsWith("TARGET_");

  // Enumerate example application directories.
  let exampleEntries;
  try {
    exampleEntries = await readdir(examplesDir, { withFileTypes: true });
  } catch {
    throw new Error(
      `Examples directory not found: ${examplesDir}\n` +
        "Fetch assets first with --bsp-file before running --create-json-desc.",
    );
  }

  const examples = exampleEntries.filter((e) => e.isDirectory());
  console.log(
    `\nCreating dependency JSON for ${examples.length} example(s)...\n`,
  );

  for (const example of examples) {
    const appDir = path.join(examplesDir, example.name);
    const depsJsonPath = path.join(appDir, "deps.json");

    const versionEntries = await readdir(appDir, { withFileTypes: true });
    const versionDirs = versionEntries.filter((e) => e.isDirectory());

    // Keyed by project name (sub-project dir name, or "root" for single-project).
    const depsPerProject: Record<string, string[]> = {};

    for (const versionDir of versionDirs) {
      const versionPath = path.join(appDir, versionDir.name);

      // Single-project: deps/ directly inside the version directory.
      const rootDeps = await readDepsDir(
        path.join(versionPath, "deps"),
        isMiddleware,
      );
      if (rootDeps !== undefined) {
        depsPerProject["root"] = rootDeps;
      }

      // Multi-project: each immediate subdirectory that contains a deps/ folder.
      const subEntries = await readdir(versionPath, { withFileTypes: true });
      for (const sub of subEntries.filter((e) => e.isDirectory())) {
        const subDeps = await readDepsDir(
          path.join(versionPath, sub.name, "deps"),
          isMiddleware,
        );
        if (subDeps !== undefined) {
          depsPerProject[sub.name] = subDeps;
        }
      }
    }

    await writeFile(
      depsJsonPath,
      JSON.stringify(depsPerProject, null, 2) + "\n",
      "utf8",
    );

    const projectCount = Object.keys(depsPerProject).length;
    const totalDeps = Object.values(depsPerProject).reduce(
      (n, d) => n + d.length,
      0,
    );
    console.log(
      `  ${example.name}: ${projectCount} project(s), ${totalDeps} middleware dep(s)`,
    );
  }

  console.log("\nDone.");
}
