import { parseArgs, CliArgs } from './cli';
import { StatusTracker } from './status';
import { runPhase1 } from './phase1';
import { runPhase2 } from './phase2';
import { runPhase3 } from './phase3';
import * as fs from 'fs';

async function runAgain(args: CliArgs): Promise<void> {
    const status = StatusTracker.load(args.status);
    const entries = status.getAll();

    if (entries.length === 0) {
        console.error(`Error: status file is empty or not found: ${args.status}`);
        process.exit(1);
    }

    // Phase 1 retry: project creation failed
    const phase1RetryPairs = entries
        .filter(e => e.create_status === 'failed')
        .map(e => ({ bsp: e.bsp, app: e.name }));

    // Phase 2 retry: mtb2cmake failed, OR ninja failed (re-run phase 2 per requirement)
    // Exclude pairs already queued for phase 1 (they cascade through naturally)
    const needsPhase1 = new Set(phase1RetryPairs.map(p => `${p.bsp}:${p.app}`));
    const phase2RetryPairs = entries
        .filter(e =>
            (e.mtb2cmake_status === 'failed' || e.ninja_status === 'failed') &&
            !needsPhase1.has(`${e.bsp}:${e.name}`)
        )
        .map(e => ({ bsp: e.bsp, app: e.name }));

    // Phase 3 direct retry: cmake failed (ninja was skipped), not already going through phase 2
    const needsPhase2 = new Set(phase2RetryPairs.map(p => `${p.bsp}:${p.app}`));
    const phase3DirectPairs = entries
        .filter(e =>
            e.cmake_status === 'failed' &&
            !needsPhase2.has(`${e.bsp}:${e.name}`) &&
            !needsPhase1.has(`${e.bsp}:${e.name}`)
        )
        .map(e => ({ bsp: e.bsp, app: e.name }));

    const totalRetry = phase1RetryPairs.length + phase2RetryPairs.length + phase3DirectPairs.length;
    if (totalRetry === 0) {
        console.log('No failed steps found in status file — nothing to retry.');
        return;
    }

    console.log(`Retrying: ${phase1RetryPairs.length} phase-1, ${phase2RetryPairs.length} phase-2, ${phase3DirectPairs.length} phase-3-only failures`);

    // Phase 1 retries
    let phase2Pairs = [...phase2RetryPairs];
    if (phase1RetryPairs.length > 0) {
        const phase1Succeeded = await runPhase1({
            pairs: phase1RetryPairs,
            mtbdir: args.mtbdir,
            projectCreator: args.projectCreator,
            logDir: args.logs,
            status,
        });
        phase2Pairs.push(...phase1Succeeded);
    }

    // Phase 2 retries (from direct failures + phase 1 successes)
    let phase3Pairs = [...phase3DirectPairs];
    if (phase2Pairs.length > 0) {
        const phase2Succeeded = await runPhase2({
            pairs: phase2Pairs,
            mtbdir: args.mtbdir,
            cmakedir: args.cmakedir,
            mtb2cmake: args.mtb2cmake,
            depends: args.depends,
            logDir: args.logs,
            status,
            targets: args.targets,
            cmakeOnly: args.cmakeOnly,
        });
        phase3Pairs.push(...phase2Succeeded);
    }

    // Phase 3 retries (from direct failures + phase 2 successes)
    if (phase3Pairs.length > 0) {
        await runPhase3({
            pairs: phase3Pairs,
            cmakedir: args.cmakedir,
            logDir: args.logs,
            status,
        });
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv);
    const skip = new Set(args.skip ?? []);

    // Clear and recreate the logs directory
    if (fs.existsSync(args.logs)) {
        fs.rmSync(args.logs, { recursive: true, force: true });
    }
    fs.mkdirSync(args.logs, { recursive: true });

    if (args.runAgain) {
        await runAgain(args);
        return;
    }

    const status = new StatusTracker(args.status);

    // Phase 1: create MTB projects
    const phase1Succeeded = await runPhase1({
        bsps: args.bsps,
        mtbdir: args.mtbdir,
        projectCreator: args.projectCreator,
        logDir: args.logs,
        status,
        limit: args.limit,
        include: args.include,
        skip,
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
        skip,
        targets: args.targets,
        cmakeOnly: args.cmakeOnly,
    });

    // Phase 3: cmake + ninja
    await runPhase3({
        pairs: phase2Succeeded,
        cmakedir: args.cmakedir,
        logDir: args.logs,
        status,
        skip,
    });
}

main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Fatal error: ${msg}`);
    process.exit(1);
});