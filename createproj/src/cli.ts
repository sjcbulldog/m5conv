#!/usr/bin/env node
import { parseCliArgs } from "./argParser";
import { createApplicationFromSdk } from "./createApplication";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  await createApplicationFromSdk(args);

  console.log("Application created successfully.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`createproj failed: ${message}`);
  process.exitCode = 1;
});
