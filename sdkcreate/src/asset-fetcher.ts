import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import type {
  Bsp,
  CodeExample,
  ManifestVersion,
  MiddlewarePackage,
} from "./modustoolbox-manifests";

type AssetEntry = Bsp | MiddlewarePackage | CodeExample;

export interface FetchAssetsOptions {
  bsps: Bsp[];
  middleware: MiddlewarePackage[];
  codeExamples: CodeExample[];
  targetDir: string;
  gitPath: string;
  force: boolean;
  /** When true, only the first pinned release version (non-"latest") of each asset is fetched. */
  latestOnly: boolean;
}

/**
 * Returns the first pinned release version (skipping rolling "latest-vX.X"
 * pointers). Falls back to the first entry if all versions are latest pointers.
 */
function latestPinnedVersion(
  versions: ManifestVersion[],
): ManifestVersion | undefined {
  return (
    versions.find(
      (v) =>
        !v.label.toLowerCase().startsWith("latest") &&
        !v.commit.toLowerCase().startsWith("latest-"),
    ) ?? versions[0]
  );
}

/** Validate the target directory and remove it when --force is set. */
export async function validateAndPrepareTargetDir(
  targetDir: string,
  force: boolean,
): Promise<void> {
  const resolvedTarget = path.resolve(targetDir);
  const parentDir = path.dirname(resolvedTarget);

  // The parent directory must already exist.
  let parentStat;
  try {
    parentStat = await stat(parentDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Parent directory does not exist: ${parentDir}`);
    }
    throw err;
  }
  if (!parentStat.isDirectory()) {
    throw new Error(`Parent path is not a directory: ${parentDir}`);
  }

  // Inspect the target itself.
  let targetStat;
  try {
    targetStat = await stat(resolvedTarget);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return; // Does not exist — we will create it.
    }
    throw err;
  }

  if (!targetStat.isDirectory()) {
    throw new Error(
      `Target path exists but is not a directory: ${resolvedTarget}`,
    );
  }

  if (force) {
    console.log(`Removing existing target directory: ${resolvedTarget}`);
    await rm(resolvedTarget, { recursive: true, force: true });
    return;
  }

  const contents = await readdir(resolvedTarget);
  if (contents.length > 0) {
    throw new Error(
      `Target directory is not empty: ${resolvedTarget}\n` +
        "Use --force to delete it before fetching.",
    );
  }
}

/** Replace characters that are invalid in Windows directory names. */
function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

function runGit(gitPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(gitPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stderrChunks: Buffer[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString().trim();
      reject(
        new Error(
          `git ${args[0]} exited with code ${code ?? "unknown"}` +
            (stderr ? `:\n${stderr}` : ""),
        ),
      );
    });

    proc.on("error", reject);
  });
}

/** Recursively sum the size in bytes of all files under a directory. */
async function dirSizeBytes(dirPath: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dirPath, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await dirSizeBytes(full);
      } else {
        const s = await stat(full);
        total += s.size;
      }
    }),
  );
  return total;
}

/** Format a byte count as a human-readable string (B / KB / MB / GB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function fetchVersion(
  gitPath: string,
  repoUrl: string,
  version: ManifestVersion,
  versionDir: string,
): Promise<void> {
  await runGit(gitPath, [
    "clone",
    "--branch",
    version.commit,
    "--depth",
    "1",
    "--quiet",
    repoUrl,
    versionDir,
  ]);

  // Strip git metadata — callers only need the source tree.
  await rm(path.join(versionDir, ".git"), { recursive: true, force: true });
}

async function fetchAsset(
  gitPath: string,
  asset: AssetEntry,
  targetDir: string,
  latestOnly: boolean,
): Promise<void> {
  if (!asset.repositoryUrl) {
    return;
  }

  const kindTag =
    asset.kind === "bsp"
      ? "BSP"
      : asset.kind === "middleware"
        ? "Middleware"
        : "Example";

  const assetDir = path.join(targetDir, sanitizeName(asset.id));
  await mkdir(assetDir, { recursive: true });

  const versionsToFetch = latestOnly
    ? [latestPinnedVersion(asset.versions)].filter(
        (v): v is ManifestVersion => v !== undefined,
      )
    : asset.versions;

  for (const version of versionsToFetch) {
    const versionDir = path.join(assetDir, sanitizeName(version.commit));

    process.stdout.write(
      `[${kindTag}] ${asset.name}  @  ${version.commit}  ...  `,
    );

    try {
      await fetchVersion(gitPath, asset.repositoryUrl, version, versionDir);
      const bytes = await dirSizeBytes(versionDir);
      process.stdout.write(`OK  (${version.label}, ${formatBytes(bytes)})\n`);
    } catch (err) {
      const firstLine =
        err instanceof Error ? err.message.split("\n")[0] : String(err);
      process.stdout.write(`FAILED: ${firstLine}\n`);
    }
  }
}

/** Clone every BSP, middleware package, and code example from the given lists. */
export async function fetchAssets(options: FetchAssetsOptions): Promise<void> {
  const { bsps, middleware, codeExamples, targetDir, gitPath, force, latestOnly } = options;

  await validateAndPrepareTargetDir(targetDir, force);

  const bspDir      = path.join(targetDir, "bsps");
  const mwDir       = path.join(targetDir, "middleware");
  const examplesDir = path.join(targetDir, "examples");

  await mkdir(bspDir,      { recursive: true });
  await mkdir(mwDir,       { recursive: true });
  await mkdir(examplesDir, { recursive: true });

  const categories: Array<{ label: string; assets: AssetEntry[]; dir: string }> = [
    { label: "BSPs",        assets: bsps.filter((a) => !!a.repositoryUrl),         dir: bspDir },
    { label: "Examples",    assets: codeExamples.filter((a) => !!a.repositoryUrl), dir: examplesDir },
    { label: "Middleware",  assets: middleware.filter((a) => !!a.repositoryUrl),    dir: mwDir },
  ];

  const totalCount = categories.reduce((n, c) => n + c.assets.length, 0);

  console.log(
    `\nFetching ${totalCount} assets into ${path.resolve(targetDir)}` +
      (latestOnly ? " (latest pinned release only)" : "") +
      "\n",
  );

  for (const { label, assets, dir } of categories) {
    if (assets.length === 0) continue;
    console.log(`--- ${label} (${assets.length}) ---`);
    for (const asset of assets) {
      await fetchAsset(gitPath, asset, dir, latestOnly);
    }
  }

  console.log("\nDone.");
}
