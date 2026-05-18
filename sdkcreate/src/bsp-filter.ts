import { readFile } from "node:fs/promises";

import type {
  Bsp,
  CodeExample,
  ManifestVersion,
  MiddlewarePackage,
  ModusToolboxCatalog,
} from "./modustoolbox-manifests";

export interface FilteredAssets {
  bsps: Bsp[];
  middleware: MiddlewarePackage[];
  codeExamples: CodeExample[];
}

/** Parse a JSON file that must be a top-level string array of BSP IDs. */
export async function loadBspIds(filePath: string): Promise<string[]> {
  const text = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse BSP file as JSON: ${filePath}\n${String(err)}`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  ) {
    throw new Error(
      `BSP file must be a JSON array of strings: ${filePath}`,
    );
  }
  return parsed as string[];
}

/**
 * Returns true if this version entry is a rolling "latest" pointer rather
 * than a pinned release (e.g. label "Latest 2.X release", commit "latest-v2.X").
 */
function isLatestPointer(version: ManifestVersion): boolean {
  return (
    version.label.toLowerCase().startsWith("latest") ||
    version.commit.toLowerCase().startsWith("latest-")
  );
}

/**
 * Returns the most recent pinned release version, i.e. the first version
 * whose label and commit are NOT a rolling "latest" pointer.
 * Falls back to versions[0] if every entry is a latest pointer.
 */
function getLatestVersion(
  versions: ManifestVersion[],
): ManifestVersion | undefined {
  return versions.find((v) => !isLatestPointer(v)) ?? versions[0];
}

/**
 * Effective provided capabilities for a BSP = top-level prov_capabilities
 * union the latest version's prov_capabilities_per_version.
 */
function effectiveProvidedCaps(bsp: Bsp): Set<string> {
  const caps = new Set(bsp.providedCapabilities);
  const latest = getLatestVersion(bsp.versions);
  for (const cap of latest?.providedCapabilities ?? []) {
    caps.add(cap);
  }
  return caps;
}

/**
 * Effective required capability groups for a middleware/example = top-level
 * groups concatenated with the latest version's per-version groups.
 * All groups must be satisfied (AND'd), within each group any member suffices (OR'd).
 */
function effectiveRequiredGroups(
  topLevel: readonly string[][],
  versions: ManifestVersion[],
): string[][] {
  const latest = getLatestVersion(versions);
  return [...topLevel, ...(latest?.requiredCapabilities ?? [])];
}

/**
 * An asset is compatible when every required capability group is satisfied.
 * A group is satisfied when at least one of its members is in the available set.
 * Assets with no requirement groups are always included (universal assets).
 */
function isCompatible(
  groups: string[][],
  available: Set<string>,
): boolean {
  for (const group of groups) {
    // At least one member of this OR-group must be available.
    if (!group.some((cap) => available.has(cap))) {
      return false;
    }
  }
  return true;
}

/**
 * Filter a catalog down to the BSPs listed in bspIds (case-insensitive), then
 * return only the middleware and code examples whose latest-version required
 * capabilities are fully satisfied by those BSPs' latest-version provided
 * capabilities.
 */
export function filterCatalogByBsps(
  catalog: ModusToolboxCatalog,
  bspIds: string[],
): FilteredAssets {
  const wantedIds = new Set(bspIds.map((id) => id.trim().toLowerCase()));

  const selectedBsps = catalog.bsps.filter((bsp) =>
    wantedIds.has(bsp.id.toLowerCase()),
  );

  // Warn about any BSP IDs that were not found in the catalog.
  const foundIds = new Set(selectedBsps.map((b) => b.id.toLowerCase()));
  for (const id of bspIds) {
    if (!foundIds.has(id.trim().toLowerCase())) {
      console.warn(`Warning: BSP ID "${id}" not found in catalog.`);
    }
  }

  // Union of capabilities from the latest version of every selected BSP.
  const available = new Set<string>();
  for (const bsp of selectedBsps) {
    for (const cap of effectiveProvidedCaps(bsp)) {
      available.add(cap);
    }
  }

  const middleware = catalog.middleware.filter((mw) =>
    isCompatible(
      effectiveRequiredGroups(mw.requiredCapabilities, mw.versions),
      available,
    ),
  );

  const codeExamples = catalog.codeExamples.filter((ex) =>
    isCompatible(
      effectiveRequiredGroups(ex.requiredCapabilities, ex.versions),
      available,
    ),
  );

  return { bsps: selectedBsps, middleware, codeExamples };
}
