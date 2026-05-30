import * as fs from 'fs';
import * as path from 'path';
import { run } from './runner';
import { StatusTracker } from './status';

export interface Phase1Options {
    bsps: string[];
    mtbdir: string;
    projectCreator: string;
    logDir: string;
    status: StatusTracker;
    limit?: number;
    include?: string[];
    skip?: Set<number>;
}

export interface BspAppPair {
    bsp: string;
    app: string;
}

/** Parse app IDs from project-creator-cli --list-apps output.
 *  App IDs appear as lines that start with a lowercase letter and contain no spaces.
 */
function parseAppList(output: string): string[] {
    return output
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && /^[a-z]/.test(l) && !l.includes(' '));
}

/** Apply --limit and --include filtering to an app list for a single BSP.
 *  - Pinned apps (those matching any --include name) are always included.
 *  - If pinned count >= limit, return only the pinned apps.
 *  - Otherwise, fill remaining slots from the unpinned apps up to the limit.
 *  - If no limit is set, return all apps unchanged.
 */
function applyLimit(apps: string[], limit: number | undefined, include: string[] | undefined): string[] {
    if (limit === undefined) {
        return apps;
    }
    const pinnedSet = new Set(include ?? []);
    const pinned = apps.filter(a => pinnedSet.has(a));
    if (pinned.length >= limit) {
        return pinned;
    }
    const unpinned = apps.filter(a => !pinnedSet.has(a));
    const remaining = limit - pinned.length;
    return [...pinned, ...unpinned.slice(0, remaining)];
}

export async function runPhase1(opts: Phase1Options): Promise<BspAppPair[]> {
    console.log('\nPhase 1: Creating MTB code examples');

    // Enumerate all BSP/app pairs first
    const pairs: BspAppPair[] = [];
    for (const bsp of opts.bsps) {
        console.log(`  Listing apps for BSP: ${bsp}`);
        const result = await run(opts.projectCreator, ['--list-apps', bsp]);
        const apps = parseAppList(result.stdout);
        if (apps.length === 0) {
            console.log(`  WARNING: No apps found for BSP ${bsp} (exit code ${result.exitCode})`);
        } else {
            console.log(`  Found ${apps.length} app(s) for ${bsp}`);
        }
        const selectedApps = applyLimit(apps, opts.limit, opts.include);
        if (opts.limit !== undefined && selectedApps.length < apps.length) {
            console.log(`  Limiting to ${selectedApps.length} app(s) for ${bsp} (limit=${opts.limit})`);
        }
        for (const app of selectedApps) {
            pairs.push({ bsp, app });
            opts.status.updateEntry(bsp, app, { create_status: 'pending' });
        }
    }

    const total = pairs.length;
    let done = 0;
    const succeeded: BspAppPair[] = [];

    for (const { bsp, app } of pairs) {
        const destDir = path.join(opts.mtbdir, bsp);
        const appDir = path.join(destDir, app);

        if (opts.skip?.has(1) && fs.existsSync(appDir)) {
            done++;
            const pct = Math.round((done / total) * 100);
            opts.status.updateEntry(bsp, app, { create_status: 'skipped' });
            console.log(`    Skipping phase 1 for ${app}/${bsp} (directory exists) (${pct}% of total)`);
            succeeded.push({ bsp, app });
            continue;
        }

        fs.mkdirSync(destDir, { recursive: true });

        const logFile = path.join(opts.logDir, `${bsp}_${app}_create.log`);
        process.stdout.write(`    Creating mtb project ${app} for bsp ${bsp} [${path.basename(logFile)}] ...`);

        const result = await run(
            opts.projectCreator,
            ['--board-id', bsp, '--app-id', app, '--target-dir', destDir],
            undefined,
            logFile,
        );

        done++;
        const pct = Math.round((done / total) * 100);

        if (result.exitCode === 0) {
            opts.status.updateEntry(bsp, app, { create_status: 'success' });
            console.log(`complete (${pct}% of total)`);
            succeeded.push({ bsp, app });
        } else {
            opts.status.updateEntry(bsp, app, { create_status: 'failed' });
            console.log(`FAILED (${pct}% of total)`);
        }
    }

    console.log(`\nPhase 1 complete: ${succeeded.length}/${total} created successfully`);
    return succeeded;
}
