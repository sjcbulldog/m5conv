import { readFile } from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";

import type {
  AppManifest,
  BoardManifest,
  Bsp,
  Chip,
  CodeExample,
  LoadModusToolboxCatalogOptions,
  ManifestVersion,
  MiddlewareManifest,
  MiddlewarePackage,
  ModusToolboxCatalog,
  NestedManifestSource,
  SuperManifest,
} from "./types";
import {
  asArray,
  getString,
  isRecord,
  parseRequirements,
  splitCapabilities,
  splitCommaSeparated,
  uniqueStrings,
} from "./xml";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: true,
  cdataPropName: "cdata",
  textNodeName: "text",
  parseTagValue: false,
  parseAttributeValue: false,
});

export const DEFAULT_SUPER_MANIFEST_SOURCE =
  "https://raw.githubusercontent.com/Infineon/mtb-super-manifest/v2.X/mtb-super-manifest-fv2.xml";

export async function loadModusToolboxCatalog(
  options: LoadModusToolboxCatalogOptions = {},
): Promise<ModusToolboxCatalog> {
  const superManifestSources = normalizeSuperManifestSources(
    options.superManifestSources,
    options.defaultSuperManifestSource ?? DEFAULT_SUPER_MANIFEST_SOURCE,
  );
  const readText = options.readText ?? readSourceText;

  const loadedSuperManifests = await Promise.all(
    superManifestSources.map(async (source) =>
      parseSuperManifest(source, await readText(source)),
    ),
  );

  const boardManifestSources = uniqueStrings(
    loadedSuperManifests.flatMap((manifest) =>
      manifest.boardManifestSources.map((nestedSource) => nestedSource.source),
    ),
  );
  const middlewareManifestSources = uniqueStrings(
    loadedSuperManifests.flatMap((manifest) =>
      manifest.middlewareManifestSources.map(
        (nestedSource) => nestedSource.source,
      ),
    ),
  );
  const appManifestSources = uniqueStrings(
    loadedSuperManifests.flatMap((manifest) =>
      manifest.appManifestSources.map((nestedSource) => nestedSource.source),
    ),
  );

  const [boardManifests, middlewareManifests, appManifests] = await Promise.all(
    [
      Promise.all(
        boardManifestSources.map(async (source) =>
          parseBoardManifest(source, await readText(source)),
        ),
      ),
      Promise.all(
        middlewareManifestSources.map(async (source) =>
          parseMiddlewareManifest(source, await readText(source)),
        ),
      ),
      Promise.all(
        appManifestSources.map(async (source) =>
          parseAppManifest(source, await readText(source)),
        ),
      ),
    ],
  );

  return {
    superManifests: loadedSuperManifests,
    boardManifests,
    middlewareManifests,
    appManifests,
    bsps: deduplicateEntries(boardManifests.flatMap((manifest) => manifest.bsps)),
    middleware: deduplicateEntries(
      middlewareManifests.flatMap((manifest) => manifest.middleware),
    ),
    codeExamples: deduplicateEntries(
      appManifests.flatMap((manifest) => manifest.codeExamples),
    ),
  };
}

async function parseSuperManifest(
  source: string,
  xml: string,
): Promise<SuperManifest> {
  const parsed = parseXml(xml);
  const root = getRequiredRecord(parsed["super-manifest"], source);

  return {
    source,
    boardManifestSources: parseNestedManifestSources(
      root["board-manifest-list"],
      "board-manifest",
      source,
    ),
    middlewareManifestSources: parseNestedManifestSources(
      root["middleware-manifest-list"],
      "middleware-manifest",
      source,
    ),
    appManifestSources: parseNestedManifestSources(
      root["app-manifest-list"],
      "app-manifest",
      source,
    ),
  };
}

async function parseBoardManifest(
  source: string,
  xml: string,
): Promise<BoardManifest> {
  const parsed = parseXml(xml);
  const root = getRequiredRecord(parsed.boards, source);
  const boards = asArray(root.board).map((board) => parseBoard(board, source));

  return {
    source,
    bsps: boards,
  };
}

async function parseMiddlewareManifest(
  source: string,
  xml: string,
): Promise<MiddlewareManifest> {
  const parsed = parseXml(xml);
  const root = getRequiredRecord(parsed.middleware, source);
  const middleware = asArray(root.middleware).map((entry) =>
    parseMiddleware(entry, source),
  );

  return {
    source,
    middleware,
  };
}

async function parseAppManifest(
  source: string,
  xml: string,
): Promise<AppManifest> {
  const parsed = parseXml(xml);
  const root = getRequiredRecord(parsed.apps, source);
  const codeExamples = asArray(root.app).map((entry) => parseCodeExample(entry, source));

  return {
    source,
    codeExamples,
  };
}

function parseBoard(rawBoard: unknown, manifestSource: string): Bsp {
  const board = getRequiredRecord(rawBoard, manifestSource);
  const chips = parseChips(board.chips);

  return {
    kind: "bsp",
    id: getRequiredString(board.id, "board.id", manifestSource),
    name: getRequiredString(board.name, "board.name", manifestSource),
    category: getString(board.category),
    repositoryUrl: getString(board.board_uri),
    summary: getString(board.summary),
    description: getString(board.description),
    documentationUrl: getString(board.documentation_url),
    providedCapabilities: splitCapabilities(getString(board.prov_capabilities)),
    chips,
    versions: parseVersions(board.versions),
    manifestSources: [manifestSource],
  };
}

function parseMiddleware(
  rawMiddleware: unknown,
  manifestSource: string,
): MiddlewarePackage {
  const middleware = getRequiredRecord(rawMiddleware, manifestSource);

  return {
    kind: "middleware",
    id: getRequiredString(middleware.id, "middleware.id", manifestSource),
    name: getRequiredString(middleware.name, "middleware.name", manifestSource),
    category: getString(middleware.category),
    repositoryUrl: getString(middleware.uri),
    description: getString(middleware.desc),
    requiredCapabilities: parseRequirements(
      getString(middleware.req_capabilities_v2) ??
        getString(middleware.req_capabilities),
    ),
    versions: parseVersions(middleware.versions),
    manifestSources: [manifestSource],
  };
}

function parseCodeExample(
  rawApp: unknown,
  manifestSource: string,
): CodeExample {
  const app = getRequiredRecord(rawApp, manifestSource);

  return {
    kind: "code-example",
    id: getRequiredString(app.id, "app.id", manifestSource),
    name: getRequiredString(app.name, "app.name", manifestSource),
    repositoryUrl: getString(app.uri),
    description: getString(app.description),
    requiredCapabilities: parseRequirements(
      getString(app.req_capabilities_v2) ?? getString(app.req_capabilities),
    ),
    versions: parseVersions(app.versions),
    manifestSources: [manifestSource],
  };
}

function parseNestedManifestSources(
  rawList: unknown,
  itemName: string,
  baseSource: string,
): NestedManifestSource[] {
  if (!isRecord(rawList)) {
    return [];
  }

  return asArray(rawList[itemName]).map((item) => {
    const record = getRequiredRecord(item, baseSource);
    const uri = getRequiredString(record.uri, `${itemName}.uri`, baseSource);

    return {
      source: resolveManifestSource(baseSource, uri),
    };
  });
}

function parseChips(rawChips: unknown): Chip[] {
  if (!isRecord(rawChips)) {
    return [];
  }

  return Object.entries(rawChips).flatMap(([kind, value]) =>
    asArray(value)
      .map((chipValue) => {
        const model = getString(chipValue);
        if (!model) {
          return undefined;
        }

        return {
          kind,
          model,
        };
      })
      .filter((chip): chip is Chip => chip !== undefined),
  );
}

function parseVersions(rawVersions: unknown): ManifestVersion[] {
  if (!isRecord(rawVersions)) {
    return [];
  }

  return asArray(rawVersions.version).map((entry) => {
    const version = getRequiredRecord(entry, "manifest version");

    return {
      label: getRequiredString(version.num, "version.num", "manifest version"),
      commit: getRequiredString(
        version.commit,
        "version.commit",
        "manifest version",
      ),
      description: getString(version.desc),
      flowVersions: splitCommaSeparated(getString(version.flow_version)),
      providedCapabilities: splitCapabilities(
        getString(version.prov_capabilities_per_version),
      ),
      requiredCapabilities: parseRequirements(
        getString(version.req_capabilities_per_version_v2) ??
          getString(version.req_capabilities_per_version),
      ),
      toolsMaxVersion: getString(version.tools_max_version),
    };
  });
}

function deduplicateEntries<
  T extends {
    id: string;
    repositoryUrl?: string;
    manifestSources: string[];
  },
>(entries: T[]): T[] {
  const entriesByKey = new Map<string, T>();

  for (const entry of entries) {
    const key = `${entry.id}::${entry.repositoryUrl ?? ""}`;
    const existing = entriesByKey.get(key);

    if (!existing) {
      entriesByKey.set(key, entry);
      continue;
    }

    existing.manifestSources = uniqueStrings([
      ...existing.manifestSources,
      ...entry.manifestSources,
    ]);
  }

  return [...entriesByKey.values()];
}

function parseXml(xml: string): Record<string, unknown> {
  const parsed = xmlParser.parse(xml);

  if (!isRecord(parsed)) {
    throw new Error("Expected XML to parse into an object.");
  }

  return parsed;
}

async function readSourceText(source: string): Promise<string> {
  if (isUrl(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Request for ${source} failed with status ${response.status}.`);
    }

    return response.text();
  }

  return readFile(source, "utf8");
}

function normalizeSuperManifestSources(
  superManifestSources: readonly string[] | undefined,
  defaultSuperManifestSource: string,
): string[] {
  const normalized = uniqueStrings(
    (superManifestSources ?? [])
      .map((source) => source.trim())
      .filter((source) => source.length > 0),
  );

  return normalized.length > 0 ? normalized : [defaultSuperManifestSource];
}

function resolveManifestSource(baseSource: string, nestedSource: string): string {
  if (isUrl(nestedSource)) {
    return nestedSource;
  }

  if (isUrl(baseSource)) {
    return new URL(nestedSource, baseSource).toString();
  }

  return path.resolve(path.dirname(baseSource), nestedSource);
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function getRequiredRecord(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected an object while parsing ${source}.`);
  }

  return value;
}

function getRequiredString(
  value: unknown,
  field: string,
  source: string,
): string {
  const normalized = getString(value);
  if (!normalized) {
    throw new Error(`Missing ${field} in ${source}.`);
  }

  return normalized;
}
