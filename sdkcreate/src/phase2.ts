import * as fs from 'fs';
import * as path from 'path';
import { run } from './runner';
import { StatusTracker } from './status';
import { BspAppPair } from './phase1';

export interface Phase2Options {
    pairs: BspAppPair[];
    mtbdir: string;
    cmakedir: string;
    mtb2cmake: string;
    depends: string;
    logDir: string;
    status: StatusTracker;
    skip?: Set<number>;
    targets?: string[];
}

export async function runPhase2(opts: Phase2Options): Promise<BspAppPair[]> {
    console.log('\nPhase 2: Converting to cmake (mtb2cmake)');

    const total = opts.pairs.length;
    let done = 0;
    const succeeded: BspAppPair[] = [];

    for (const { bsp, app } of opts.pairs) {
        const srcDir  = path.join(opts.mtbdir, bsp, app);
        const destDir = path.join(opts.cmakedir, bsp, app);

        if (opts.skip?.has(2) && fs.existsSync(destDir)) {
            done++;
            const pct = Math.round((done / total) * 100);
            opts.status.updateEntry(bsp, app, { mtb2cmake_status: 'skipped' });
            console.log(`    Skipping phase 2 for ${app}/${bsp} (directory exists) (${pct}% of total)`);
            succeeded.push({ bsp, app });
            continue;
        }

        const logFile = path.join(opts.logDir, `${bsp}_${app}_mtb2cmake.log`);
        process.stdout.write(`    Converting ${app} for bsp ${bsp} to cmake [${path.basename(logFile)}] ...`);

        const mtb2cmakeArgs = [
            '--source', srcDir,
            '--dest',   destDir,
            '--depends', opts.depends,
            '--force',
        ];
        if (opts.targets && opts.targets.length > 0) {
            mtb2cmakeArgs.push('--target', opts.targets.join(','));
        }
        const result = await run(opts.mtb2cmake, mtb2cmakeArgs, undefined, logFile);

        done++;
        const pct = Math.round((done / total) * 100);

        if (result.exitCode === 0) {
            opts.status.updateEntry(bsp, app, { mtb2cmake_status: 'success' });
            console.log(`complete (${pct}% of total)`);
            succeeded.push({ bsp, app });
        } else {
            opts.status.updateEntry(bsp, app, { mtb2cmake_status: 'failed' });
            console.log(`FAILED (${pct}% of total)`);
        }
    }

    console.log(`\nPhase 2 complete: ${succeeded.length}/${total} converted successfully`);
    return succeeded;
}
