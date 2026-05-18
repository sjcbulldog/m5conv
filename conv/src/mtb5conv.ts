import { ModusToolboxEnvironment, MTBLoadFlags } from "./mtbenv";
import { collectSources, collectHeaders, generateObjectLibraryCMakeLists, generateHeaderOnlyCMakeLists, generateProjectCMakeLists, generateTopLevelCMakeLists, generateGccToolchainCMake, generateIarToolchainCMake, generateLlvmToolchainCMake, generateArmToolchainCMake, generateBspCMakeInclude, AssetSubdirectory, loadDependsDB, resolveIncludeDirs, resolveAssetExports, resolveAssetInternals, hasActiveSources, readProjectDefinesByConfig, readProjectDefinesForConfig, readProjectFlagsByConfig, readProjectFlagsForConfig, mergeProjectFlagsByConfig, ProjectFlagsByConfig, ProjectFlagsByToolchain, DependsEntry, ConditionalIncludeDir, processSignCombineJson, SignCombineInfo } from './cmakeutil';
import { MTBUtils } from './mtbenv/misc/mtbutils';
import * as winston from 'winston';
import * as fs from 'fs';
import * as path from 'path';

export class MTB5Converter {
    private src_ : string ;
    private dest_ : string ;
    private env_: ModusToolboxEnvironment ;
    private logger_ : winston.Logger ;
    public forceDeleteDest : boolean = false ;
    public bspName : string | undefined ;
    public signCombinePath : string | undefined ;
    public setOverrides : Map<string, string> = new Map() ;
    public targets : Set<string> | undefined ;

    constructor(src : string, dest: string, logfile?: string) {
        this.src_ = src ;
        this.dest_ = dest ;

        this.logger_ = winston.createLogger({
            level: 'debug',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
            ),
            transports: [
                new winston.transports.Console()
            ]
        }) ;

        if (logfile) {
            this.logger_.add(new winston.transports.File({ filename: logfile })) ;
        }

        let env = ModusToolboxEnvironment.initInstance(this.logger_) ;
        if (!env) {
            throw new Error('Failed to create ModusToolboxEnvironment') ;
        }
        this.env_ = env ;
    }

    public async convert() : Promise<void> {
        if (fs.existsSync(this.dest_)) {
            if (this.forceDeleteDest) {
                this.logger_.info(`Removing existing destination directory: ${this.dest_}`) ;
                try {
                    fs.rmSync(this.dest_, { recursive: true, force: true }) ;
                } catch (err: any) {
                    throw new Error(`Failed to remove destination directory '${this.dest_}': ${err.message}`) ;
                }
            } else {
                throw new Error(`Destination directory already exists: ${this.dest_} (use --force to remove)`) ;
            }
        }

        await this.env_.load(MTBLoadFlags.appInfo, this.src_) ;
        await this.convertAppInfo() ;
    }

    private async convertAppInfo() : Promise<void> {
        this.logger_.info('Converting app info...') ;
        this.copyBSPs() ;
        this.copyAssets() ;
        await this.copyProjects() ;
        this.generateTopLevel() ;
    }

    private copyBSPs() : void {
        const srcBspsDir = path.join(this.src_, 'BSPs') ;
        if (!fs.existsSync(srcBspsDir)) {
            this.logger_.warn(`No BSPs directory found in source: ${srcBspsDir}`) ;
            return ;
        }

        const destBspsDir = path.join(this.dest_, 'bsps') ;
        fs.mkdirSync(destBspsDir, { recursive: true }) ;

        const entries = fs.readdirSync(srcBspsDir, { withFileTypes: true }) ;
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith('TARGET_')) {
                const srcTarget = path.join(srcBspsDir, entry.name) ;
                const destTarget = path.join(destBspsDir, entry.name) ;
                this.logger_.info(`Copying BSP directory: ${entry.name}`) ;
                try {
                    fs.cpSync(srcTarget, destTarget, { recursive: true }) ;
                } catch (err) {
                    this.logger_.warn(`Failed to copy BSP directory '${entry.name}': ${err}`) ;
                    continue ;
                }

                const sources = collectSources(destTarget, destTarget) ;
                const headers = collectHeaders(destTarget, destTarget) ;
                generateBspCMakeInclude(destTarget, sources, headers) ;
                this.logger_.info(`Generated bsp.cmake for ${entry.name}`) ;
            }
        }
    }

    private copyAssets() : void {
        const appInfo = this.env_.appInfo ;
        if (!appInfo) {
            this.logger_.warn('No application info available - cannot copy assets') ;
            return ;
        }

        // Load the depends database
        const dependsPath = path.join(__dirname, '..', 'depends.json') ;
        const dependsDB = loadDependsDB(dependsPath) ;
        if (dependsDB.length > 0) {
            this.logger_.info(`Loaded depends.json with ${dependsDB.length} entries`) ;
        } else {
            this.logger_.warn('No depends.json found or it is empty - no include directories will be resolved') ;
        }

        const destAssetsDir = path.join(this.dest_, 'assets') ;
        const copiedAssets = new Set<string>() ;

        for (const project of appInfo.projects) {
            const dirList = project.dirList ;

            for (const req of project.assetsRequests) {
                if (req.isBSP()) {
                    continue ;
                }

                const assetName = req.name() ;
                if (copiedAssets.has(assetName)) {
                    continue ;
                }

                const srcPath = req.fullPath(dirList) ;
                if (!fs.existsSync(srcPath)) {
                    this.logger_.warn(`Asset '${assetName}' not found at '${srcPath}' - skipping`) ;
                    continue ;
                }

                if (!fs.existsSync(destAssetsDir)) {
                    fs.mkdirSync(destAssetsDir, { recursive: true }) ;
                }

                const destPath = path.join(destAssetsDir, assetName) ;
                this.logger_.info(`Copying asset '${assetName}' from '${srcPath}'`) ;
                try {
                    fs.cpSync(srcPath, destPath, { recursive: true }) ;
                } catch (err) {
                    this.logger_.warn(`Failed to copy asset '${assetName}' from '${srcPath}': ${err}`) ;
                    continue ;
                }

                // Remove .git directory if present
                const gitDir = path.join(destPath, '.git') ;
                if (fs.existsSync(gitDir)) {
                    this.logger_.info(`Removing .git directory from asset '${assetName}'`) ;
                    try {
                        fs.rmSync(gitDir, { recursive: true, force: true }) ;
                    } catch (err) {
                        this.logger_.warn(`Failed to remove .git directory from asset '${assetName}': ${err}`) ;
                    }
                }

                // Generate CMakeLists.txt for the asset if it has source files.
                // Remap the project's ignore paths from the source asset location
                // to the copied destination location so ignored subtrees are excluded.
                const normSrc = path.normalize(srcPath) ;
                const assetIgnorePaths = project.ignorePath()
                    .filter(ip => path.normalize(ip).startsWith(normSrc))
                    .map(ip => path.join(destPath, path.relative(srcPath, ip))) ;
                if (assetIgnorePaths.length > 0) {
                    this.logger_.info(`  ignore paths for '${assetName}': ${assetIgnorePaths.join(', ')}`) ;
                }
                const sources = collectSources(destPath, destPath, [], assetIgnorePaths) ;
                const bspDir = project.bspName ? '${BSP_DIR}' : undefined ;
                const includeDirs = resolveIncludeDirs(assetName, dependsDB, '..', bspDir) ;
                const internalDirs = resolveAssetInternals(assetName, dependsDB) ;
                if (sources.length > 0) {
                    generateObjectLibraryCMakeLists(destPath, assetName, sources, includeDirs, internalDirs) ;
                    this.logger_.info(`Generated CMakeLists.txt for asset '${assetName}'`) ;
                } else {
                    // No source files - check for headers
                    const headers = collectHeaders(destPath, destPath, [], assetIgnorePaths) ;
                    if (headers.length > 0) {
                        generateHeaderOnlyCMakeLists(destPath, assetName, headers, includeDirs) ;
                        this.logger_.info(`Generated header-only CMakeLists.txt for asset '${assetName}'`) ;
                    }
                }

                copiedAssets.add(assetName) ;
            }
        }

        if (copiedAssets.size === 0) {
            this.logger_.info('No assets found to copy') ;
        } else {
            this.logger_.info(`Copied ${copiedAssets.size} asset(s) to '${destAssetsDir}'`) ;
        }
    }

    private resolveBspName() : string {
        const destBspsDir = path.join(this.dest_, 'bsps') ;
        if (!fs.existsSync(destBspsDir)) {
            throw new Error('No bsps directory found in destination') ;
        }

        const bspDirs = fs.readdirSync(destBspsDir, { withFileTypes: true })
            .filter(e => e.isDirectory() && e.name.startsWith('TARGET_'))
            .map(e => e.name) ;

        if (bspDirs.length === 0) {
            throw new Error('No BSP directories found in destination') ;
        }

        if (this.bspName) {
            if (!bspDirs.includes(this.bspName)) {
                throw new Error(`Specified BSP '${this.bspName}' not found. Available BSPs: ${bspDirs.join(', ')}`) ;
            }
            return this.bspName ;
        }

        if (bspDirs.length === 1) {
            this.logger_.info(`Auto-selected BSP: ${bspDirs[0]}`) ;
            return bspDirs[0] ;
        }

        throw new Error(`Multiple BSPs found (${bspDirs.join(', ')}). Use --bsp to specify which one to use.`) ;
    }

    private async copyProjects() : Promise<void> {
        const appInfo = this.env_.appInfo ;
        if (!appInfo) {
            this.logger_.warn('No application info available - cannot copy projects') ;
            return ;
        }

        for (const project of appInfo.projects) {
            const projName = project.name ;
            const srcProjDir = project.path ;
            const destProjDir = path.join(this.dest_, projName) ;

            this.logger_.info(`Copying project '${projName}' from '${srcProjDir}'`) ;
            fs.cpSync(srcProjDir, destProjDir, { recursive: true }) ;

            // Remove makefiles
            for (const mf of ['Makefile', 'makefile']) {
                const mfPath = path.join(destProjDir, mf) ;
                if (fs.existsSync(mfPath)) {
                    this.logger_.info(`Removing ${mf} from project '${projName}'`) ;
                    fs.unlinkSync(mfPath) ;
                }
            }

            // Collect asset subdirectory references for this project
            const assetSubs: AssetSubdirectory[] = [] ;
            const projectIncludeDirs: ConditionalIncludeDir[] = [] ;

            // If the project has an 'include' subdirectory, add it to the include path.
            if (fs.existsSync(path.join(srcProjDir, 'include'))) {
                projectIncludeDirs.push({ path: '${CMAKE_CURRENT_SOURCE_DIR}/include', conditions: [] }) ;
                this.logger_.info(`  Adding project include directory: include`) ;
            }

            const dirList = project.dirList ;
            const seenAssets = new Set<string>() ;

            // Load the depends database
            const dependsPath = path.join(__dirname, '..', 'depends.json') ;
            const dependsDB = loadDependsDB(dependsPath) ;

            for (const req of project.assetsRequests) {
                if (req.isBSP()) {
                    continue ;
                }

                const assetName = req.name() ;
                if (seenAssets.has(assetName)) {
                    continue ;
                }
                seenAssets.add(assetName) ;

                const destAssetPath = path.join(this.dest_, 'assets', assetName) ;
                if (fs.existsSync(destAssetPath)) {
                    // Remap the project's ignore paths to the destination asset location,
                    // matching the same filtering applied when the asset was scanned in copyAssets.
                    const srcAssetPath = req.fullPath(dirList) ;
                    const normSrcAsset = path.normalize(srcAssetPath) ;
                    const assetIgnorePaths = project.ignorePath()
                        .filter(ip => path.normalize(ip).startsWith(normSrcAsset))
                        .map(ip => path.join(destAssetPath, path.relative(srcAssetPath, ip))) ;

                    // Only include assets that have source files active for this project's components.
                    // Apply the same ignore paths used during CMakeLists generation so that assets
                    // with all sources ignored (e.g. entire directory ignored) are not included.
                    // Also guard against assets where no CMakeLists.txt was generated at all
                    // (e.g. another project's ignore rules suppressed the whole directory).
                    const assetCMakeLists = path.join(destAssetPath, 'CMakeLists.txt') ;
                    const assetSources = collectSources(destAssetPath, destAssetPath, [], assetIgnorePaths) ;
                    if (fs.existsSync(assetCMakeLists) && hasActiveSources(assetSources, project.components)) {
                        const relativePath = path.relative(destProjDir, destAssetPath).replace(/\\/g, '/') ;
                        assetSubs.push({
                            name: assetName,
                            relativePath,
                            targetName: `${projName}_cm33_${assetName}`
                        }) ;
                    }

                    // Resolve exported include directories for this asset
                    const assetsBaseDir = path.relative(destProjDir, path.join(this.dest_, 'assets')).replace(/\\/g, '/') ;
                    const exports = resolveAssetExports(assetName, dependsDB, assetsBaseDir) ;
                    projectIncludeDirs.push(...exports) ;
                } else {
                    this.logger_.warn(`Asset '${assetName}' not found in destination - skipping add_subdirectory`) ;
                }
            }

            // Generate CMakeLists.txt for the project
            const bspName = this.resolveBspName() ;
            const sources = collectSources(destProjDir, destProjDir) ;
            const components = project.components ;

            // Run 'make codegen' for each toolchain (LLVM_ARM, IAR, GCC_ARM, ARM) in both
            // Debug and Release configurations.  The flag files (.cflags etc.) are written to
            // build/<BSP>/{Debug,Release}/ and are overwritten for each toolchain, so they must
            // be read immediately after each toolchain's pair of runs.
            const codegenResult = await this.runMakeCodegenForProject(srcProjDir) ;
            const flagsByToolchain = codegenResult.flags ;

            const toolchainNames = Object.keys(flagsByToolchain) ;
            if (toolchainNames.length > 0) {
                const fmt = (fs: { debugFile?: string ; releaseFile?: string }, name: string) =>
                    `${name}: D=${fs.debugFile ? '✓' : '✗'} R=${fs.releaseFile ? '✓' : '✗'}` ;
                for (const tc of toolchainNames.sort()) {
                    const fbc = flagsByToolchain[tc] ;
                    const hasFlagFiles = !!(
                        fbc.c.debugFile || fbc.c.releaseFile ||
                        fbc.asm.debugFile || fbc.asm.releaseFile ||
                        fbc.link.debugFile || fbc.link.releaseFile
                    ) ;
                    if (hasFlagFiles) {
                        this.logger_.info(`  [${tc}] flag files — ${fmt(fbc.c, 'cflags')} | ${fmt(fbc.asm, 'asflags')} | ${fmt(fbc.cxx, 'cxxflags')} | ${fmt(fbc.link, 'ldflags')} | ${fmt(fbc.libs, 'ldlibs')}`) ;
                        if (fbc.link.hasCmse) {
                            this.logger_.info(`  [${tc}] CMSE TrustZone veneer generation detected for '${projName}'`) ;
                        }
                        const libCount = new Set([...fbc.libs.debug, ...fbc.libs.release]).size ;
                        if (libCount > 0) {
                            this.logger_.info(`  [${tc}] ldlibs: ${libCount} unique entr${libCount === 1 ? 'y' : 'ies'} (veneer consumer)`) ;
                        }
                    }
                }
            } else {
                this.logger_.warn(`  codegen produced no flags for '${projName}' — compile options will not be toolchain-conditional`) ;
            }

            // Use defines captured immediately after each config's codegen run.
            // This is correct for both Model 1 (build/<BSP>/<CONFIG>/.defines) and
            // Model 2 (build/.defines flat layout), since in Model 2 each codegen run
            // overwrites the same file and defines must be read before the next run.
            const { debugDefinesRaw, releaseDefinesRaw, debugDefinesFile, releaseDefinesFile } = codegenResult ;
            if (debugDefinesFile || releaseDefinesFile) {
                const dbgInfo = debugDefinesFile
                    ? `Debug: ${debugDefinesFile} (${debugDefinesRaw.length} defines)`
                    : 'Debug: not found' ;
                const relInfo = releaseDefinesFile
                    ? `Release: ${releaseDefinesFile} (${releaseDefinesRaw.length} defines)`
                    : 'Release: not found' ;
                this.logger_.info(`  defines files — ${dbgInfo} | ${relInfo}`) ;
            } else {
                this.logger_.info(`  defines files: none found under ${path.join(srcProjDir, 'build')}`) ;
            }
            // Exclude any COMPONENT_* defines already handled by the components mechanism.
            const componentDefineNames = new Set(
                components.map(c => `COMPONENT_${c.replace(/-/g, '_')}`)
            ) ;
            const filterDefines = (defs: string[]) => defs.filter(d => {
                const name = d.split('=')[0] ;
                return !name.startsWith('COMPONENT_') && !componentDefineNames.has(name) ;
            }) ;
            const debugDefines   = filterDefines(debugDefinesRaw) ;
            const releaseDefines = filterDefines(releaseDefinesRaw) ;

            generateProjectCMakeLists(destProjDir, projName, sources, assetSubs, projectIncludeDirs, bspName, components, flagsByToolchain, debugDefines, releaseDefines, dependsDB) ;
            this.logger_.info(`Generated CMakeLists.txt for project '${projName}'`) ;
        }
    }

    //
    // Run 'make codegen TOOLCHAIN=<t> CONFIG=<c>' for each of the four supported
    // toolchains (GCC_ARM, IAR, LLVM_ARM, ARM) in both Debug and Release configurations.
    // The flag files written by codegen (.cflags, .asflags, .cxxflags, .ldflags, .ldlibs)
    // all land in the same build/<BSP>/{Debug,Release}/ directories and are overwritten
    // with each successive toolchain run, so we read and store the flags immediately
    // after each toolchain's Debug+Release pair.
    //
    // .defines files are read immediately after the first successful codegen run for each
    // configuration.  This is required for Model 2 (flat build/ layout) where successive
    // codegen runs overwrite the same build/.defines file.
    //
    // Toolchains whose codegen runs both fail are omitted from the result so the
    // generated CMakeLists.txt only contains entries for toolchains that were available.
    //
    private async runMakeCodegenForProject(srcProjDir: string) : Promise<{
        flags: ProjectFlagsByToolchain ;
        debugDefinesRaw: string[] ;
        releaseDefinesRaw: string[] ;
        debugDefinesFile?: string ;
        releaseDefinesFile?: string ;
    }> {
        const ALL_TOOLCHAINS = ['GCC_ARM', 'IAR', 'LLVM_ARM', 'ARM'] as const ;
        type Toolchain = typeof ALL_TOOLCHAINS[number] ;
        const targetToToolchain: Record<string, Toolchain> = {
            gcc:  'GCC_ARM',
            iar:  'IAR',
            llvm: 'LLVM_ARM',
            arm:  'ARM',
        } ;
        const TOOLCHAINS: Toolchain[] = this.targets
            ? ALL_TOOLCHAINS.filter(tc => {
                const key = Object.keys(targetToToolchain).find(k => targetToToolchain[k] === tc) ;
                return key !== undefined && this.targets!.has(key) ;
              })
            : [...ALL_TOOLCHAINS] ;
        const CONFIGS    = ['Debug', 'Release'] as const ;
        const result: ProjectFlagsByToolchain = {} ;

        // Defines are toolchain-independent; capture them once per config from
        // the first successful codegen run for that config.
        let debugDefinesRaw:   string[] | undefined ;
        let releaseDefinesRaw: string[] | undefined ;
        let debugDefinesFile:   string | undefined ;
        let releaseDefinesFile: string | undefined ;

        const toolsDir = this.env_.toolsDir ;
        if (!toolsDir) {
            this.logger_.warn('  codegen: no tools directory located — skipping make codegen') ;
            return { flags: result, debugDefinesRaw: [], releaseDefinesRaw: [] } ;
        }

        const modusShellDir = path.join(toolsDir, 'modus-shell') ;
        if (!fs.existsSync(modusShellDir)) {
            this.logger_.warn(`  codegen: modus-shell not found at '${modusShellDir}' — skipping make codegen`) ;
            return { flags: result, debugDefinesRaw: [], releaseDefinesRaw: [] } ;
        }

        // IAR passes -S (preprocess-only) and --dependencies=m <file> to the
        // assembler as part of codegen.  For C and C++ codegen IAR similarly
        // emits --dependencies=m <file>.  In all cases keep the flag but
        // replace the make-specific filename argument ($out.d) with the CMake
        // build directory; IAR derives the dependency filename itself.
        const applyIarFiltering = (flags: ProjectFlagsByConfig) : ProjectFlagsByConfig => {
            const filterIarFlags = (flagList: string[], stripPreprocessOnly: boolean) : string[] => {
                const out: string[] = [] ;
                let i = 0 ;
                while (i < flagList.length) {
                    if (stripPreprocessOnly && (flagList[i] === '-S' || flagList[i] === '-r')) {
                        i++ ;
                    } else if (flagList[i] === '--dependencies=m') {
                        out.push('--dependencies=m') ;
                        i += 2 ; // consume flag + original filename argument
                        out.push('${CMAKE_CURRENT_BINARY_DIR}') ;
                    } else {
                        out.push(flagList[i++]) ;
                    }
                }
                return out ;
            } ;
            flags.asm.debug   = filterIarFlags(flags.asm.debug,   true) ;
            flags.asm.release = filterIarFlags(flags.asm.release,  true) ;
            flags.c.debug     = filterIarFlags(flags.c.debug,      false) ;
            flags.c.release   = filterIarFlags(flags.c.release,    false) ;
            flags.cxx.debug   = filterIarFlags(flags.cxx.debug,    false) ;
            flags.cxx.release = filterIarFlags(flags.cxx.release,  false) ;

            // For linker flags, if --config=<file> / -config=<file> references a
            // relative path it must be anchored to the CMake source directory so
            // CMake can locate the ICF file regardless of the build directory.
            const filterIarLinkFlags = (flagList: string[]) : string[] => {
                return flagList.map(flag => {
                    const m = flag.match(/^(-{1,2}config=)(.+)$/) ;
                    if (m) {
                        const filePath = m[2].replace(/^["']|["']$/g, '').replace(/\\/g, '/') ;
                        if (!path.isAbsolute(filePath) && !filePath.startsWith('${')) {
                            return `${m[1]}\${CMAKE_CURRENT_SOURCE_DIR}/${filePath}` ;
                        }
                    }
                    return flag ;
                }) ;
            } ;
            flags.link.debug   = filterIarLinkFlags(flags.link.debug) ;
            flags.link.release = filterIarLinkFlags(flags.link.release) ;
            return flags ;
        } ;

        const collectFlagsForConfig = (tc: string, config: 'Debug' | 'Release') : ProjectFlagsByConfig => {
            const flags = readProjectFlagsForConfig(srcProjDir, config) ;
            const hasAny = !!(
                flags.c.debugFile    || flags.c.releaseFile    ||
                flags.asm.debugFile  || flags.asm.releaseFile  ||
                flags.cxx.debugFile  || flags.cxx.releaseFile  ||
                flags.link.debugFile || flags.link.releaseFile ||
                flags.libs.debugFile || flags.libs.releaseFile
            ) ;
            if (!hasAny) {
                const expectedPath = path.join(srcProjDir, 'build') ;
                const msg = `No flag files (.cflags, .asflags, .cxxflags, .ldflags) found under '${expectedPath}' after successful make codegen for TOOLCHAIN=${tc} CONFIG=${config}` ;
                this.logger_.error(msg) ;
                throw new Error(msg) ;
            }
            return tc === 'IAR' ? applyIarFiltering(flags) : flags ;
        } ;

        for (const toolchain of TOOLCHAINS) {
            let debugFlags:   ProjectFlagsByConfig | null = null ;
            let releaseFlags: ProjectFlagsByConfig | null = null ;

            for (const config of CONFIGS) {
                this.logger_.info(`  Running: make codegen TOOLCHAIN=${toolchain} CONFIG=${config}`) ;
                try {
                    const [code, output] = await MTBUtils.callMake(
                        this.logger_,
                        toolsDir,
                        modusShellDir,
                        srcProjDir,
                        ['codegen', `TOOLCHAIN=${toolchain}`, `CONFIG=${config}`]
                    ) ;
                    if (code !== 0) {
                        this.logger_.warn(`  make codegen TOOLCHAIN=${toolchain} CONFIG=${config} exited with code ${code}`) ;
                        const firstLines = output.filter(l => l.trim().length > 0).slice(0, 5) ;
                        if (firstLines.length > 0) {
                            this.logger_.debug(`  output: ${firstLines.join(' | ')}`) ;
                        }
                    } else {
                        // Collect flags and defines immediately after each successful codegen so
                        // that a subsequent run cannot overwrite the files we need to read.
                        // This is critical for Model 2 (flat build/ layout) where all configs
                        // share the same output directory.
                        if (config === 'Debug') {
                            debugFlags = collectFlagsForConfig(toolchain, 'Debug') ;
                            if (debugDefinesRaw === undefined) {
                                const d = readProjectDefinesForConfig(srcProjDir, 'Debug') ;
                                debugDefinesRaw = d.defines ;
                                debugDefinesFile = d.filePath ;
                            }
                        } else {
                            releaseFlags = collectFlagsForConfig(toolchain, 'Release') ;
                            if (releaseDefinesRaw === undefined) {
                                const d = readProjectDefinesForConfig(srcProjDir, 'Release') ;
                                releaseDefinesRaw = d.defines ;
                                releaseDefinesFile = d.filePath ;
                            }
                        }
                    }
                } catch (err: any) {
                    this.logger_.warn(`  make codegen TOOLCHAIN=${toolchain} CONFIG=${config} failed: ${err.message}`) ;
                }
            }

            if (debugFlags || releaseFlags) {
                if (!(debugFlags && releaseFlags)) {
                    this.logger_.warn(`  codegen TOOLCHAIN=${toolchain}: only one config succeeded — collecting available flags`) ;
                }
                result[toolchain] = mergeProjectFlagsByConfig(
                    debugFlags   ?? { c: { debug: [], release: [] }, asm: { debug: [], release: [] }, cxx: { debug: [], release: [] }, link: { debug: [], release: [] }, libs: { debug: [], release: [] } },
                    releaseFlags ?? { c: { debug: [], release: [] }, asm: { debug: [], release: [] }, cxx: { debug: [], release: [] }, link: { debug: [], release: [] }, libs: { debug: [], release: [] } },
                ) ;
            } else {
                this.logger_.warn(`  codegen TOOLCHAIN=${toolchain}: both configs failed — toolchain omitted from CMakeLists.txt`) ;
            }
        }

        return {
            flags:              result,
            debugDefinesRaw:    debugDefinesRaw   ?? [],
            releaseDefinesRaw:  releaseDefinesRaw ?? [],
            debugDefinesFile,
            releaseDefinesFile,
        } ;
    }

    private generateTopLevel() : void {
        const appInfo = this.env_.appInfo ;
        if (!appInfo) {
            this.logger_.warn('No application info available - cannot generate top-level CMakeLists.txt') ;
            return ;
        }

        const projectNames = appInfo.projects.map(p => p.name) ;

        // Resolve sign-combine JSON: explicit arg → default path
        let signCombineInfo: SignCombineInfo | undefined ;
        let bspNameResolved: string | undefined ;
        const defaultSignJson = path.join(this.src_, 'configs', 'boot_with_extended_boot.json') ;
        const signJsonPath = this.signCombinePath ?? (fs.existsSync(defaultSignJson) ? defaultSignJson : undefined) ;

        if (signJsonPath) {
            try {
                bspNameResolved = this.resolveBspName() ;
                signCombineInfo = processSignCombineJson(signJsonPath, this.dest_, this.setOverrides) ;
                this.logger_.info(`Processed sign-combine config: ${signJsonPath}`) ;
            } catch (err: any) {
                this.logger_.warn(`Sign-combine processing skipped: ${err.message}`) ;
            }
        }

        generateTopLevelCMakeLists(this.dest_, projectNames, bspNameResolved, signCombineInfo, this.setOverrides) ;
        this.logger_.info('Generated top-level CMakeLists.txt') ;

        if (!this.targets || this.targets.has('gcc')) {
            generateGccToolchainCMake(this.dest_) ;
            this.logger_.info('Generated toolchains/gcc.cmake') ;
        }

        if (!this.targets || this.targets.has('iar')) {
            generateIarToolchainCMake(this.dest_) ;
            this.logger_.info('Generated toolchains/iar.cmake') ;
        }

        if (!this.targets || this.targets.has('llvm')) {
            generateLlvmToolchainCMake(this.dest_) ;
            this.logger_.info('Generated toolchains/llvm.cmake') ;
        }

        if (!this.targets || this.targets.has('arm')) {
            generateArmToolchainCMake(this.dest_) ;
            this.logger_.info('Generated toolchains/arm.cmake') ;
        }
    }
}
