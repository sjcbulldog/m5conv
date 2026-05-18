import { parseArgs } from "./cli";
import { loadModusToolboxCatalog } from "./modustoolbox-manifests";
import { findGit } from "./git-finder";
import { fetchAssets } from "./asset-fetcher";
import { filterCatalogByBsps, loadBspIds } from "./bsp-filter";
import { createJsonDesc } from "./json-desc";

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.bspFile) {
    const catalog = await loadModusToolboxCatalog({
      superManifestSources: args.superManifestSources,
    });

    const bspIds = await loadBspIds(args.bspFile);
    console.log(
      `Filtering catalog to ${bspIds.length} BSP(s) from ${args.bspFile}`,
    );
    const filtered = filterCatalogByBsps(catalog, bspIds);
    console.log(
      `  BSPs: ${filtered.bsps.length}  |  ` +
        `Middleware: ${filtered.middleware.length}  |  ` +
        `Code examples: ${filtered.codeExamples.length}`,
    );

    const gitPath = await findGit();
    console.log(`Using git: ${gitPath}`);

    await fetchAssets({
      bsps: filtered.bsps,
      middleware: filtered.middleware,
      codeExamples: filtered.codeExamples,
      targetDir: args.outputDir,
      gitPath,
      force: args.force,
      latestOnly: true,
    });
  }

  if (args.createJsonDesc) {
    await createJsonDesc(args.outputDir);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
