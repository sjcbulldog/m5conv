import * as fs from 'fs';
import * as path from 'path';
import { run } from './runner';
import { StatusTracker } from './status';
import { BspAppPair } from './phase1';

export interface Phase3Options {
    pairs: BspAppPair[];
    cmakedir: string;
    logDir: string;
    status: StatusTracker;
}

export async function runPhase3(opts: Phase3Options): Promise<void> {
    console.log('\nPhase 3: cmake/ninja builds');

    const total = opts.pairs.length;
    let done = 0;

    for (const { bsp, app } of opts.pairs) {
        const projDir  = path.join(opts.cmakedir, bsp, app);
        const buildDir = path.join(projDir, 'build');
        fs.mkdirSync(buildDir, { recursive: true });

        // log file paths
        const cmakeLog = path.join(opts.logDir, `${bsp}_${app}_cmake.log`);
        const ninjaLog = path.join(opts.logDir, `${bsp}_${app}_ninja.log`);
        process.stdout.write(`    Building ${app} for bsp ${bsp} [${path.basename(cmakeLog)}, ${path.basename(ninjaLog)}] ...`);

        // cmake
        const cmakeResult = await run('cmake', [
            '-G', 'Ninja',
            '--toolchain=../toolchains/gcc.cmake',
            '..',
        ], buildDir, cmakeLog);

        if (cmakeResult.exitCode !== 0) {
            opts.status.updateEntry(bsp, app, { cmake_status: 'failed', ninja_status: 'skipped' });
            done++;
            const pct = Math.round((done / total) * 100);
            console.log(`cmake FAILED (${pct}% of total)`);
            continue;
        }
        opts.status.updateEntry(bsp, app, { cmake_status: 'success' });

        // ninja
        const ninjaResult = await run('ninja', [], buildDir, ninjaLog);

        done++;
        const pct = Math.round((done / total) * 100);

        if (ninjaResult.exitCode === 0) {
            opts.status.updateEntry(bsp, app, { ninja_status: 'success' });
            console.log(`complete (${pct}% of total)`);
        } else {
            opts.status.updateEntry(bsp, app, { ninja_status: 'failed' });
            console.log(`ninja FAILED (${pct}% of total)`);
        }
    }

    const successes = opts.pairs.filter(p => {
        const e = opts.status.getEntry(p.bsp, p.app);
        return e?.ninja_status === 'success';
    }).length;
    console.log(`\nPhase 3 complete: ${successes}/${total} ninja builds successful`);
}
