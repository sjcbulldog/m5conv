import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const DEFAULT_CREATOR_CLI =
    'C:\\users\\butch\\ModusToolbox\\tools_3.7\\project-creator\\project-creator-cli.exe';

interface Args {
    bsps: string;
    mtbprojs: string;
    cmakeprojs: string;
    builddirs: string;
    logs: string;
    mapping: string;
    creator: string;
    force: boolean;
    summary?: string;
}

type BspEntry = string | { name: string; apps: string[] };

interface MappingEntry {
    shortName: string;
    appId: string;
    bspId: string;
    mtbProjDir: string;
    cmakeProjDir: string;
    buildDir: string;
    logs: {
        mtbcreate: string;
        mtbbuild: string;
        cmakeconv: string;
        cmakeconfigure: string;
        cmakebuild: string;
    };
}

interface Summary {
    mtbCreated: number;
    mtbBuilt: number;
    cmakeConverted: number;
    cmakeConfigured: number;
    cmakeBuilt: number;
}

function printUsage(): void {
    console.log('Usage: mtbsuite [options]');
    console.log('');
    console.log('Options:');
    console.log('  --help                Display this help message');
    console.log('  --bsps <path>         Path to JSON file listing BSP IDs (required)');
    console.log('  --mtbprojs <path>     Directory where MTB projects are created (required)');
    console.log('  --cmakeprojs <path>   Directory where CMake projects are placed (required)');
    console.log('  --builddirs <path>    Directory where CMake builds occur (required)');
    console.log('  --logs <path>         Directory where per-step log files are written (required)');
    console.log('  --mapping <path>      Path to JSON mapping file (required)');
    console.log('  --force               Remove output directories if they exist instead of erroring');
    console.log('  --summary <path>      Write summary to this file in addition to stdout');
    console.log(`  --creator <path>      Path to project-creator-cli`);
    console.log(`                        (default: ${DEFAULT_CREATOR_CLI})`);
}

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    let bsps: string | undefined;
    let mtbprojs: string | undefined;
    let cmakeprojs: string | undefined;
    let builddirs: string | undefined;
    let logs: string | undefined;
    let mapping: string | undefined;
    let creator = DEFAULT_CREATOR_CLI;
    let force = false;
    let summary: string | undefined;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help') {
            printUsage();
            process.exit(0);
        } else if (arg === '--bsps') {
            bsps = argv[++i];
        } else if (arg === '--mtbprojs') {
            mtbprojs = argv[++i];
        } else if (arg === '--cmakeprojs') {
            cmakeprojs = argv[++i];
        } else if (arg === '--builddirs') {
            builddirs = argv[++i];
        } else if (arg === '--logs') {
            logs = argv[++i];
        } else if (arg === '--mapping') {
            mapping = argv[++i];
        } else if (arg === '--creator') {
            creator = argv[++i];
        } else if (arg === '--force') {
            force = true;
        } else if (arg === '--summary') {
            summary = argv[++i];
        } else {
            console.error(`Unknown argument: ${arg}`);
            printUsage();
            process.exit(1);
        }
    }

    if (!bsps)       { console.error('Error: --bsps is required');       printUsage(); process.exit(1); }
    if (!mtbprojs)   { console.error('Error: --mtbprojs is required');   printUsage(); process.exit(1); }
    if (!cmakeprojs) { console.error('Error: --cmakeprojs is required'); printUsage(); process.exit(1); }
    if (!builddirs)  { console.error('Error: --builddirs is required');  printUsage(); process.exit(1); }
    if (!logs)       { console.error('Error: --logs is required');       printUsage(); process.exit(1); }
    if (!mapping)    { console.error('Error: --mapping is required');    printUsage(); process.exit(1); }

    return {
        bsps: bsps!,
        mtbprojs: mtbprojs!,
        cmakeprojs: cmakeprojs!,
        builddirs: builddirs!,
        logs: logs!,
        mapping: mapping!,
        creator,
        force,
        summary,
    };
}

function isDirEmpty(dirPath: string): boolean {
    try {
        return fs.readdirSync(dirPath).length === 0;
    } catch {
        return true;
    }
}

function prepareOutputDir(label: string, dirPath: string, force: boolean): void {
    if (!fs.existsSync(dirPath)) return;
    if (isDirEmpty(dirPath)) return;
    if (force) {
        console.log(`Removing ${label} directory "${dirPath}"...`);
        fs.rmSync(dirPath, { recursive: true, force: true });
    } else {
        console.error(`Error: ${label} directory "${dirPath}" already exists and is not empty. Use --force to remove it.`);
        process.exit(1);
    }
}

function runStep(label: string, cmd: string, cmdArgs: string[], cwd?: string, logFile?: string): boolean {
    process.stdout.write(`    ${label} ... `);
    const start = Date.now();
    const result = spawnSync(cmd, cmdArgs, {
        cwd,
        encoding: 'utf8',
        shell: true,
        windowsHide: true,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (logFile) {
        const parts: string[] = [];
        if (result.stdout) parts.push(result.stdout);
        if (result.stderr) parts.push(result.stderr);
        fs.writeFileSync(logFile, parts.join('\n'), 'utf8');
    }
    const success = result.status === 0 && !result.error;
    console.log(`${success ? 'success' : 'failure'} (${elapsed}s)`);
    return success;
}

function listApps(creatorCli: string, bspId: string): string[] {
    const result = spawnSync(creatorCli, ['--list-apps', bspId], {
        encoding: 'utf8',
        shell: true,
        windowsHide: true,
    });
    if (result.status !== 0 || result.error) {
        console.error(`  Failed to list apps for BSP ${bspId}${result.stderr ? ': ' + result.stderr.trim() : ''}`);
        return [];
    }
    // Each app ID is on its own line; filter out blank lines and any header/footer text
    return result.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(line));
}

function ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/** Generate a unique 8-character alphanumeric short name not already in usedNames. */
function generateShortName(usedNames: Set<string>): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let name: string;
    do {
        name = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (usedNames.has(name));
    return name;
}

function saveMapping(mappingFile: string, entries: MappingEntry[]): void {
    fs.writeFileSync(mappingFile, JSON.stringify(entries, null, 2) + '\n', 'utf8');
}

function processApp(
    bspId: string,
    appId: string,
    args: Args,
    convIndexJs: string,
    totals: Summary,
    mappingEntries: MappingEntry[],
    usedNames: Set<string>,
): void {
    const shortName = generateShortName(usedNames);
    usedNames.add(shortName);

    console.log(`${appId} [${bspId}] (${shortName})...`);

    const mtbProjDir   = path.resolve(args.mtbprojs,  shortName);
    const cmakeProjDir = path.resolve(args.cmakeprojs, shortName);
    const buildDir     = path.resolve(args.builddirs,  shortName);
    const logPaths = {
        mtbcreate:      path.resolve(args.logs, `${shortName}-mtbcreate.log`),
        mtbbuild:       path.resolve(args.logs, `${shortName}-mtbbuild.log`),
        cmakeconv:      path.resolve(args.logs, `${shortName}-cmakeconv.log`),
        cmakeconfigure: path.resolve(args.logs, `${shortName}-cmakeconfigure.log`),
        cmakebuild:     path.resolve(args.logs, `${shortName}-cmakebuild.log`),
    };

    const entry: MappingEntry = {
        shortName,
        appId,
        bspId,
        mtbProjDir,
        cmakeProjDir,
        buildDir,
        logs: logPaths,
    };

    // Step 1: Create MTB application
    ensureDir(args.mtbprojs);
    if (!runStep('creating MTB application', args.creator, [
        '-b', bspId,
        '-a', appId,
        '-d', args.mtbprojs,
        '-n', shortName,
        '--use-modus-shell',
    ], undefined, logPaths.mtbcreate)) {
        mappingEntries.push(entry);
        saveMapping(args.mapping, mappingEntries);
        return;
    }
    totals.mtbCreated++;

    // Step 2: Build MTB application
    if (!runStep('building MTB application', 'make', ['build'], mtbProjDir, logPaths.mtbbuild)) {
        mappingEntries.push(entry);
        saveMapping(args.mapping, mappingEntries);
        return;
    }
    totals.mtbBuilt++;

    // Step 3: Convert to CMake
    ensureDir(args.cmakeprojs);
    if (!runStep('converting to CMake', 'node', [
        convIndexJs,
        '--source', mtbProjDir,
        '--dest',   cmakeProjDir,
        '--force',
    ], undefined, logPaths.cmakeconv)) {
        mappingEntries.push(entry);
        saveMapping(args.mapping, mappingEntries);
        return;
    }
    totals.cmakeConverted++;

    // Step 4: Configure CMake with Ninja generator
    ensureDir(buildDir);
    let toolchain = path.join(cmakeProjDir, 'toolchains', 'gcc.cmake') ;
    if (!runStep('configuring CMake', 'cmake', [
        '-G', 'Ninja',
        '--toolchain', toolchain,
        '-S', cmakeProjDir,
        '-B', buildDir,
    ], undefined, logPaths.cmakeconfigure)) {
        mappingEntries.push(entry);
        saveMapping(args.mapping, mappingEntries);
        return;
    }
    totals.cmakeConfigured++;

    // Step 5: Build with Ninja
    if (!runStep('building CMake application', 'ninja', ['-C', buildDir], undefined, logPaths.cmakebuild)) {
        mappingEntries.push(entry);
        saveMapping(args.mapping, mappingEntries);
        return;
    }
    totals.cmakeBuilt++;

    mappingEntries.push(entry);
    saveMapping(args.mapping, mappingEntries);
}

function printSummary(totals: Summary, summaryFile?: string): void {
    const lines = [
        '',
        'Summary',
        '-------',
        `MTB projects created successfully:          ${totals.mtbCreated}`,
        `MTB projects built successfully:            ${totals.mtbBuilt}`,
        `MTB projects converted to CMake:            ${totals.cmakeConverted}`,
        `CMake projects configured successfully:     ${totals.cmakeConfigured}`,
        `CMake projects built successfully:          ${totals.cmakeBuilt}`,
    ];
    const output = lines.join('\n');
    console.log(output);
    if (summaryFile) {
        fs.writeFileSync(summaryFile, output + '\n', 'utf8');
    }
}

function main(): void {
    const args = parseArgs();
    const convIndexJs = path.resolve(__dirname, '..', '..', 'conv', 'dist', 'index.js');

    // Validate output directories
    prepareOutputDir('--mtbprojs',   args.mtbprojs,   args.force);
    prepareOutputDir('--cmakeprojs', args.cmakeprojs, args.force);
    prepareOutputDir('--builddirs',  args.builddirs,  args.force);
    prepareOutputDir('--logs',       args.logs,       args.force);

    // Validate mapping file - must not exist unless --force
    if (fs.existsSync(args.mapping)) {
        if (args.force) {
            console.log(`Removing mapping file "${args.mapping}"...`);
            fs.unlinkSync(args.mapping);
        } else {
            console.error(`Error: mapping file "${args.mapping}" already exists. Use --force to overwrite it.`);
            process.exit(1);
        }
    }

    // Ensure logs dir exists up front so every step can write to it
    ensureDir(args.logs);

    let bspEntries: BspEntry[];
    try {
        const content = fs.readFileSync(args.bsps, 'utf8');
        bspEntries = JSON.parse(content) as BspEntry[];
    } catch (e) {
        console.error(`Failed to read BSP list from "${args.bsps}": ${e}`);
        process.exit(1);
    }

    const totals: Summary = {
        mtbCreated: 0,
        mtbBuilt: 0,
        cmakeConverted: 0,
        cmakeConfigured: 0,
        cmakeBuilt: 0,
    };

    const mappingEntries: MappingEntry[] = [];
    const usedNames = new Set<string>();

    for (const entry of bspEntries) {
        let bspId: string;
        let appIds: string[];

        if (typeof entry === 'string') {
            bspId = entry;
            appIds = listApps(args.creator, bspId);
            if (appIds.length === 0) {
                console.log(`No apps found for BSP: ${bspId}`);
                continue;
            }
        } else {
            bspId = entry.name;
            appIds = entry.apps;
        }

        for (const appId of appIds) {
            processApp(bspId, appId, args, convIndexJs, totals, mappingEntries, usedNames);
        }
    }

    printSummary(totals, args.summary);
}

main();
