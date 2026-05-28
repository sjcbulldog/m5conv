export interface CliArgs {
    bsps: string[];
    mtbdir: string;
    cmakedir: string;
    status: string;
    logs: string;
    projectCreator: string;
    mtb2cmake: string;
    depends: string;
    limit?: number;
    include?: string[];
}

function printUsage(): void {
    console.log(`Usage: sdkcreate [options]

Required options:
  --bsps=BSP1,BSP2,...        Comma-separated list of BSP IDs
  --mtbdir=DIR                Directory where MTB projects are created
  --cmakedir=DIR              Directory where cmake projects are placed
  --status=FILE               JSON results file path
  --logs=DIR                  Directory where per-step log files are written
  --project-creator=PATH      Path to project-creator-cli.exe
  --mtb2cmake=PATH            Path to mtb2cmake.exe
  --depends=PATH              Path to depends.json (passed to mtb2cmake)

Optional options:
  --limit=INTEGER             Limit the number of code examples per BSP (for testing)
  --include=NAME              Always include this code example when using --limit;
                              may be specified multiple times

  --help                      Show this help message
`);
}

export function parseArgs(argv: string[]): CliArgs {
    const args = argv.slice(2);
    const result: Partial<CliArgs> = {};

    for (const arg of args) {
        if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        } else if (arg.startsWith('--bsps=')) {
            result.bsps = arg.slice('--bsps='.length).split(',').map(s => s.trim()).filter(s => s.length > 0);
        } else if (arg.startsWith('--mtbdir=')) {
            result.mtbdir = arg.slice('--mtbdir='.length);
        } else if (arg.startsWith('--cmakedir=')) {
            result.cmakedir = arg.slice('--cmakedir='.length);
        } else if (arg.startsWith('--status=')) {
            result.status = arg.slice('--status='.length);
        } else if (arg.startsWith('--logs=')) {
            result.logs = arg.slice('--logs='.length);
        } else if (arg.startsWith('--project-creator=')) {
            result.projectCreator = arg.slice('--project-creator='.length);
        } else if (arg.startsWith('--mtb2cmake=')) {
            result.mtb2cmake = arg.slice('--mtb2cmake='.length);
        } else if (arg.startsWith('--depends=')) {
            result.depends = arg.slice('--depends='.length);
        } else if (arg.startsWith('--limit=')) {
            const val = parseInt(arg.slice('--limit='.length), 10);
            if (isNaN(val) || val < 1) {
                console.error(`Error: --limit must be a positive integer`);
                printUsage();
                process.exit(1);
            }
            result.limit = val;
        } else if (arg.startsWith('--include=')) {
            const name = arg.slice('--include='.length);
            if (!result.include) {
                result.include = [];
            }
            result.include.push(name);
        } else {
            console.error(`Unknown argument: ${arg}`);
            printUsage();
            process.exit(1);
        }
    }

    const required: (keyof CliArgs)[] = ['bsps', 'mtbdir', 'cmakedir', 'status', 'logs', 'projectCreator', 'mtb2cmake', 'depends'];
    const argNames: Partial<Record<keyof CliArgs, string>> = {
        bsps: '--bsps',
        mtbdir: '--mtbdir',
        cmakedir: '--cmakedir',
        status: '--status',
        logs: '--logs',
        projectCreator: '--project-creator',
        mtb2cmake: '--mtb2cmake',
        depends: '--depends',
    };
    for (const key of required) {
        if (!result[key]) {
            console.error(`Error: ${argNames[key]} is required`);
            printUsage();
            process.exit(1);
        }
    }

    return result as CliArgs;
}
