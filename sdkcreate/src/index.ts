import { parseArgs } from './cli';
import { StatusTracker } from './status';
import { runPhase1 } from './phase1';
import { runPhase2 } from './phase2';
import { runPhase3 } from './phase3';
import * as fs from 'fs';

async function main(): Promise<void> {
    const args = parseArgs(process.argv);
    const status = new StatusTracker(args.status);

    // Clear and recreate the logs directory
    if (fs.existsSync(args.logs)) {
        fs.rmSync(args.logs, { recursive: true, force: true });
    }
    fs.mkdirSync(args.logs, { recursive: true });

    // Phase 1: create MTB projects
    const phase1Succeeded = await runPhase1({
        bsps: args.bsps,
        mtbdir: args.mtbdir,
        projectCreator: args.projectCreator,
        logDir: args.logs,
        status,
        limit: args.limit,
        include: args.include,
    });

    // Phase 2: convert to cmake
    const phase2Succeeded = await runPhase2({
        pairs: phase1Succeeded,
        mtbdir: args.mtbdir,
        cmakedir: args.cmakedir,
        mtb2cmake: args.mtb2cmake,
        depends: args.depends,
        logDir: args.logs,
        status,
    });

    // Phase 3: cmake + ninja
    await runPhase3({
        pairs: phase2Succeeded,
        cmakedir: args.cmakedir,
        logDir: args.logs,
        status,
    });
}

main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Fatal error: ${msg}`);
    process.exit(1);
});