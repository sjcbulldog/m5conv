export interface CliArgs {
  superManifestSources: string[];
  outputDir: string;
  bspFile: string | undefined;
  createJsonDesc: boolean;
  force: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const result: Partial<CliArgs> & Omit<CliArgs, "outputDir"> = {
    superManifestSources: [],
    outputDir: undefined as unknown as string,
    bspFile: undefined,
    createJsonDesc: false,
    force: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--output" || arg === "-o") {
      i++;
      if (i >= args.length) {
        throw new Error(`${arg} requires a directory argument.`);
      }
      result.outputDir = args[i];
    } else if (arg === "--bsp-file") {
      i++;
      if (i >= args.length) {
        throw new Error(`${arg} requires a file path argument.`);
      }
      result.bspFile = args[i];
    } else if (arg === "--create-json-desc") {
      result.createJsonDesc = true;
    } else if (arg === "--force" || arg === "-f") {
      result.force = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      result.superManifestSources.push(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}\nRun with --help for usage.`);
    }
    i++;
  }

  if (!result.outputDir) {
    throw new Error(
      "--output <dir> is required.\nRun with --help for usage.",
    );
  }

  return result as CliArgs;
}

export function printUsage(): void {
  console.log(`\
Usage: node dist/index.js --output <dir> [options] [superManifest...]

Required:
  --output, -o <dir>      Target directory for fetched assets.

Options:
  --bsp-file <file>       JSON file containing a list of BSP IDs to target.
                          Only assets compatible with those BSPs are fetched.
                          Implies latest pinned release per asset.
  --create-json-desc      After fetching, scan each example in <dir>/examples/
                          and write a deps.json listing required middleware
                          for each project version.
  --force, -f             Delete and recreate the target directory if it exists
                          (only relevant when --bsp-file is used).
  --help, -h              Show this help message

Arguments:
  superManifest           Super manifest URL or file path (repeatable).
                          Defaults to the ModusToolbox v2 super manifest.

Examples:
  # Fetch assets filtered to BSPs in bsplist.json
  node dist/index.js --output ./mtb-assets --bsp-file bsplist.json

  # Fetch and also generate per-example dependency JSON files
  node dist/index.js --output ./mtb-assets --bsp-file bsplist.json --create-json-desc

  # Only generate dependency JSON for an already-fetched output directory
  node dist/index.js --output ./mtb-assets --create-json-desc

  # Force-overwrite the output directory
  node dist/index.js --output ./mtb-assets --bsp-file bsplist.json --force
`);
}
