import path from "node:path";
import { CliArgs } from "./types";

export function parseCliArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--sdk") {
      args.sdkDir = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--bsp") {
      args.bsp = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--dest") {
      args.destDir = argv[i + 1];
      i += 1;
      continue;
    }
  }

  if (!args.sdkDir || !args.bsp || !args.destDir) {
    throw new Error(
      "Missing required arguments. Usage: --sdk SDKDIR --bsp BSP_NAME --dest DEST_DIR"
    );
  }

  return {
    sdkDir: path.resolve(args.sdkDir),
    bsp: args.bsp,
    destDir: path.resolve(args.destDir),
  };
}
