import { MTB5Converter } from "./mtb5conv";
import * as fs from 'fs';
import * as path from 'path';

function printUsage(): void {
    console.log("Usage: mtb5conv [options]");
    console.log("");
    console.log("Options:");
    console.log("  --help                 Display this help message");
    console.log("  --source <path>        Source directory");
    console.log("  --dest <path>          Destination directory");
    console.log("  --logfile <path>       Log file path");
    console.log("  --force                Remove destination directory if it exists");
    console.log("  --bsp <name>           BSP name (required if multiple BSPs exist)");
    console.log("  --sign-combine <path>  Path to EPT sign-combine JSON config");
    console.log("  --set <key> <value>    Override a sign-combine symbol value (repeatable)");
    console.log("  --target <list>        Comma-separated toolchain targets to process (iar,gcc,llvm,arm; default: all)");
    console.log("  --depends <path>       Path to depends.json file (required)");
    console.log("  --cmake-only           Regenerate cmake files only; skip all file copies (dest must already exist, cannot use with --force)");
  console.log("  --generated-dir <file> Write a single-line file containing the full path (forward slashes) of the generated cmake directory");
}

function main(): void {
    const args = process.argv.slice(2);

    let showHelp = false;
    let source: string | undefined;
    let dest: string | undefined;
    let logfile: string | undefined;
    let depends: string | undefined;
    let force = false;
    let cmakeOnly = false;
    let bsp: string | undefined;
    let signCombine: string | undefined;
    const setOverrides = new Map<string, string>();
    const validTargets = new Set(['iar', 'gcc', 'llvm', 'arm']);
    let targets: Set<string> | undefined;
    let generatedDirFile: string | undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--help") {
            showHelp = true;
        } else if (arg === "--source") {
            i++;
            if (i >= args.length) {
                console.error("Error: --source requires a path argument");
                printUsage();
                process.exit(1);
            }
            source = args[i];
        } else if (arg === "--dest") {
            i++;
            if (i >= args.length) {
                console.error("Error: --dest requires a path argument");
                printUsage();
                process.exit(1);
            }
            dest = args[i];
        } else if (arg === "--depends") {
            i++;
            if (i >= args.length) {
                console.error("Error: --depends requires a path argument");
                printUsage();
                process.exit(1);
            }
            depends = args[i];
        } else if (arg === "--logfile") {
            i++;
            if (i >= args.length) {
                console.error("Error: --logfile requires a path argument");
                printUsage();
                process.exit(1);
            }
            logfile = args[i];
        } else if (arg === "--force") {
            force = true;
        } else if (arg === "--cmake-only") {
            cmakeOnly = true;
        } else if (arg === "--bsp") {
            i++;
            if (i >= args.length) {
                console.error("Error: --bsp requires a name argument");
                printUsage();
                process.exit(1);
            }
            bsp = args[i];
        } else if (arg === "--sign-combine") {
            i++;
            if (i >= args.length) {
                console.error("Error: --sign-combine requires a path argument");
                printUsage();
                process.exit(1);
            }
            signCombine = args[i];
        } else if (arg === "--set") {
            if (i + 2 >= args.length) {
                console.error("Error: --set requires a key and value argument");
                printUsage();
                process.exit(1);
            }
            i++;
            const key = args[i];
            i++;
            const val = args[i];
            setOverrides.set(key, val);
        } else if (arg === "--target") {
            i++;
            if (i >= args.length) {
                console.error("Error: --target requires a comma-separated list argument");
                printUsage();
                process.exit(1);
            }
            const words = args[i].split(',').map(w => w.trim().toLowerCase()).filter(w => w.length > 0);
            const invalid = words.filter(w => !validTargets.has(w));
            if (invalid.length > 0) {
                console.error(`Error: invalid target(s): ${invalid.join(', ')}. Valid targets are: iar, gcc, llvm, arm`);
                printUsage();
                process.exit(1);
            }
            if (words.length === 0) {
                console.error("Error: --target list must not be empty");
                printUsage();
                process.exit(1);
            }
            targets = new Set(words);
        } else if (arg === "--generated-dir") {
            i++;
            if (i >= args.length) {
                console.error("Error: --generated-dir requires a file path argument");
                printUsage();
                process.exit(1);
            }
            generatedDirFile = args[i];
        } else {
            console.error(`Unknown argument: ${arg}`);
            printUsage();
            process.exit(1);
        }
    }

    if (showHelp) {
        printUsage();
        process.exit(0);
    }

    if (!source) {
        console.error("Error: --source is required");
        printUsage();
        process.exit(1);
    }

    if (!dest) {
        console.error("Error: --dest is required");
        printUsage();
        process.exit(1);
    }

    if (!depends) {
        console.error("Error: --depends is required");
        printUsage();
        process.exit(1);
    }

    if (cmakeOnly && force) {
        console.error("Error: --cmake-only and --force cannot be used together");
        printUsage();
        process.exit(1);
    }

    const converter = new MTB5Converter(source, dest, logfile);
    converter.forceDeleteDest = force;
    converter.cmakeOnly = cmakeOnly;
    converter.bspName = bsp;
    converter.dependsPath = depends;
    converter.signCombinePath = signCombine;
    converter.setOverrides = setOverrides;
    converter.targets = targets;
    converter.convert()
        .then(() => {
            console.log("Conversion complete");
            if (generatedDirFile) {
                try {
                    // Get the generated directory from the converter and format it as a full path
                    // with forward slashes and Windows drive-letter form if applicable.
                    let genDir = converter.getGeneratedDir();

                    // Resolve to absolute path where possible
                    try {
                        genDir = path.resolve(genDir);
                    } catch (e) {
                        // ignore and use as-is
                    }

                    // Convert Cygwin /cygdrive style to C:/ drive letter if present
                    const cygmatch = genDir.match(/^\/cygdrive\/(\w)\/(.*)$/);
                    if (cygmatch) {
                        genDir = `${cygmatch[1].toUpperCase()}:/${cygmatch[2]}`;
                    }

                    // Replace backslashes with forward slashes for consistent output
                    genDir = genDir.replace(/\\/g, '/');

                    fs.writeFileSync(generatedDirFile, genDir + '\n', { encoding: 'utf-8' });
                    console.log(`Wrote generated dir to ${generatedDirFile}`);
                } catch (err: any) {
                    console.error(`Failed to write generated-dir file '${generatedDirFile}': ${err.message}`);
                    process.exit(1);
                }
            }
        })
        .catch((err) => {
            console.error(`Conversion failed: ${err}`);
            process.exit(1);
        });
}

main();
