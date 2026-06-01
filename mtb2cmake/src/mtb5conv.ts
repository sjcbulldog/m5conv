import { ModusToolboxEnvironment, MTBLoadFlags } from "./mtbenv";
import { collectSources, collectHeaders, collectLibraries, collectProjectHeaderDirs, generateObjectLibraryCMakeLists, generateHeaderOnlyCMakeLists, generateLibraryAssetCMakeLists, generateProjectCMakeLists, generateTopLevelCMakeLists, generateAppInfoCMake, generateProjInfoCMake, generateGccToolchainCMake, generateIarToolchainCMake, generateLlvmToolchainCMake, generateArmToolchainCMake, generateBspCMakeInclude, generateCMakePresetsFile, generateVSCodeLaunchJson, generateVSCodeTasksJson, generateVSCodeSettingsJson, AssetSubdirectory, loadDependsDB, resolveIncludeDirs, resolveAssetExports, resolveAssetInternals, hasActiveSources, readProjectDefinesByConfig, readProjectDefinesForConfig, fixDefineFilePaths, readProjectFlagsByConfig, readProjectFlagsForConfig, mergeProjectFlagsByConfig, remapFlagPaths, ProjectFlagsByConfig, ProjectFlagsByToolchain, DependsEntry, ConditionalIncludeDir, processSignCombineJson, SignCombineInfo, generateWifiHostDriverResourceDefines } from './cmakeutil';
import { MTBUtils } from './mtbenv/misc/mtbutils';
import * as winston from 'winston';
import * as fs from 'fs';
import * as path from 'path';

// Recursively copy src to dest. Returns the list of paths that could not be
// copied (e.g. Windows permission-denied), allowing the caller to emit a
// consolidated warning rather than aborting the entire copy.
async function copyDirTolerant(src: string, dest: string, skipped: string[] = []): Promise<string[]> {
    await fs.promises.mkdir(dest, { recursive: true }) ;
    let entries: fs.Dirent[] ;
    try {
        entries = await fs.promises.readdir(src, { withFileTypes: true }) ;
    } catch (err) {
        skipped.push(`${src} (cannot read directory: ${err})`) ;
        return skipped ;
    }
    for (const entry of entries) {
        const srcEntry = path.join(src, entry.name) ;
        const destEntry = path.join(dest, entry.name) ;
        try {
            if (entry.isDirectory()) {
                await copyDirTolerant(srcEntry, destEntry, skipped) ;
            } else {
                await fs.promises.copyFile(srcEntry, destEntry) ;
            }
        } catch (err) {
            skipped.push(`${srcEntry} (${(err as NodeJS.ErrnoException).code ?? err})`) ;
        }
    }
    return skipped ;
}

function warnSkippedFiles(logger: winston.Logger, label: string, skipped: string[]): void {
    if (skipped.length === 0) return ;
    const bar = '='.repeat(72) ;
    logger.warn(bar) ;
    logger.warn(`WARNING: ${skipped.length} file(s)/director(ies) could not be copied from ${label}`) ;
    for (const s of skipped) {
        logger.warn(`  SKIPPED: ${s}`) ;
    }
    logger.warn(bar) ;
}

export class MTB5Converter {
    private src_ : string ;
    private dest_ : string ;
    private env_: ModusToolboxEnvironment ;
    private logger_ : winston.Logger ;
    public forceDeleteDest : boolean = false ;
    public cmakeOnly : boolean = false ;
    public bspName : string | undefined ;
    public dependsPath : string | undefined ;
    public signCombinePath : string | undefined ;
    public setOverrides : Map<string, string> = new Map() ;
    public targets : Set<string> | undefined ;
    // Projects detected to use CMSE TrustZone veneer generation (populated during copyProjects)
    private cmseProjects_ : Set<string> = new Set() ;

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
        if (this.cmakeOnly) {
            if (!fs.existsSync(this.dest_)) {
                throw new Error(`Destination directory does not exist: ${this.dest_} (--cmake-only requires an existing destination)`) ;
            }
        } else if (fs.existsSync(this.dest_)) {
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
        await this.copyBSPs() ;
        await this.copyAssets() ;
        await this.copyProjects() ;
        this.generateTopLevel() ;
    }

    private async copyBSPs() : Promise<void> {
        const srcBspsDir = path.join(this.src_, 'BSPs') ;
        if (!fs.existsSync(srcBspsDir)) {
            this.logger_.warn(`No BSPs directory found in source: ${srcBspsDir}`) ;
            return ;
        }

        const destBspsDir = path.join(this.dest_, 'bsps') ;
        if (!this.cmakeOnly) {
            fs.mkdirSync(destBspsDir, { recursive: true }) ;
        }

        const entries = fs.readdirSync(srcBspsDir, { withFileTypes: true }) ;
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith('TARGET_')) {
                const srcTarget = path.join(srcBspsDir, entry.name) ;
                const destTarget = path.join(destBspsDir, entry.name) ;
                if (!this.cmakeOnly) {
                    this.logger_.info(`Copying BSP directory: ${entry.name}`) ;
                    const bspSkipped = await copyDirTolerant(srcTarget, destTarget) ;
                    warnSkippedFiles(this.logger_, `BSP '${entry.name}'`, bspSkipped) ;

                    const bspMk = path.join(destTarget, 'bsp.mk') ;
                    if (fs.existsSync(bspMk)) {
                        this.logger_.info(`Removing bsp.mk from BSP '${entry.name}'`) ;
                        fs.unlinkSync(bspMk) ;
                    }
                } else if (!fs.existsSync(destTarget)) {
                    this.logger_.warn(`BSP directory '${entry.name}' not found in destination - skipping`) ;
                    continue ;
                }

                const sources = collectSources(destTarget, destTarget) ;
                const headers = collectHeaders(destTarget, destTarget) ;
                generateBspCMakeInclude(destTarget, sources, headers) ;
                this.logger_.info(`Generated bsp.cmake for ${entry.name}`) ;
            }
        }
    }

    private async copyAssets() : Promise<void> {
        const appInfo = this.env_.appInfo ;
        if (!appInfo) {
            this.logger_.warn('No application info available - cannot copy assets') ;
            return ;
        }

        // Load the depends database
        const dependsPath = this.dependsPath ?? '' ;
        const dependsDB = loadDependsDB(dependsPath) ;
        if (dependsDB.length === 0) {
            throw new Error(`No assets found in depends file '${dependsPath}'`) ;
        }
        this.logger_.info(`Found ${dependsDB.length} asset(s) in depends file:`) ;
        for (const entry of dependsDB) {
            this.logger_.info(`  ${entry.name}`) ;
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
                if (assetName === 'device-db') {
                    continue ;
                }

                if (copiedAssets.has(assetName)) {
                    continue ;
                }

                const srcPath = req.fullPath(dirList) ;
                const destPath = path.join(destAssetsDir, assetName) ;
                if (!this.cmakeOnly) {
                    if (!fs.existsSync(srcPath)) {
                        this.logger_.warn(`Asset '${assetName}' not found at '${srcPath}' - skipping`) ;
                        continue ;
                    }

                    if (!fs.existsSync(destAssetsDir)) {
                        fs.mkdirSync(destAssetsDir, { recursive: true }) ;
                    }

                    this.logger_.info(`Copying asset '${assetName}' from '${srcPath}'`) ;
                    const assetSkipped = await copyDirTolerant(srcPath, destPath) ;
                    warnSkippedFiles(this.logger_, `asset '${assetName}'`, assetSkipped) ;

                    // Remove .git directory if present
                    const gitDir = path.join(destPath, '.git') ;
                    if (fs.existsSync(gitDir)) {
                        this.logger_.info(`Removing .git directory from asset '${assetName}'`) ;
                        try {
                            await fs.promises.rm(gitDir, { recursive: true, force: true }) ;
                        } catch (err) {
                            this.logger_.warn(`Failed to remove .git directory from asset '${assetName}': ${err}`) ;
                        }
                    }
                } else if (!fs.existsSync(destPath)) {
                    this.logger_.warn(`Asset '${assetName}' not found in destination - skipping`) ;
                    continue ;
                }

                // Generate CMakeLists.txt for the asset if it has source files.
                // Remap the project's ignore paths from the source asset location
                // to the copied destination location so ignored subtrees are excluded.
                const normSrc = path.normalize(srcPath) ;
                const assetIgnorePaths = project.ignorePath()
                    .filter(ip => path.normalize(ip).startsWith(normSrc))
                    .map(ip => path.join(destPath, path.relative(srcPath, ip))) ;
                const dependsEntry = dependsDB.find(e => e.name === assetName) ;
                if (dependsEntry?.excludes) {
                    for (const excl of dependsEntry.excludes) {
                        assetIgnorePaths.push(path.join(destPath, excl)) ;
                    }
                }
                const sources = collectSources(destPath, destPath, [], assetIgnorePaths) ;
                const libraries = collectLibraries(destPath, destPath, [], assetIgnorePaths) ;
                const bspDir = project.bspName ? '${BSP_DIR}' : undefined ;
                const includeDirs = resolveIncludeDirs(assetName, dependsDB, '..', bspDir) ;
                const internalDirs = resolveAssetInternals(assetName, dependsDB) ;
                if (sources.length > 0) {
                    generateObjectLibraryCMakeLists(destPath, assetName, sources, includeDirs, internalDirs, libraries) ;
                    this.logger_.info(`Generated CMakeLists.txt for asset '${assetName}'`) ;
                    if (libraries.length > 0) {
                        this.logger_.info(`  Asset '${assetName}' includes ${libraries.length} prebuilt librar${libraries.length === 1 ? 'y' : 'ies'}`) ;
                    }
                } else if (libraries.length > 0) {
                    generateLibraryAssetCMakeLists(destPath, assetName, libraries, includeDirs) ;
                    this.logger_.info(`Generated library-only CMakeLists.txt for asset '${assetName}' (${libraries.length} prebuilt librar${libraries.length === 1 ? 'y' : 'ies'})`) ;
                } else {
                    // No source or library files - generate a header-only INTERFACE target
                    generateHeaderOnlyCMakeLists(destPath, assetName, includeDirs) ;
                    this.logger_.info(`Generated header-only CMakeLists.txt for asset '${assetName}'`) ;
                }

                // Special case: wifi-host-driver requires the companion wifi-resources
                // asset to be present and its CMakeLists.txt to include conditional
                // resource defines (CLM_IMAGE_NAME, FW_IMAGE_NAME, NVRAM_IMAGE_NAME).
                if (assetName === 'wifi-host-driver') {
                    const wifiResourcesDestPath = path.join(destAssetsDir, 'wifi-resources') ;

                    if (!this.cmakeOnly && !copiedAssets.has('wifi-resources') && !fs.existsSync(wifiResourcesDestPath)) {
                        const wifiResourcesSrcPath = path.join(path.dirname(srcPath), 'wifi-resources') ;
                        if (fs.existsSync(wifiResourcesSrcPath)) {
                            this.logger_.info(`Copying companion asset 'wifi-resources' for wifi-host-driver`) ;
                            const resSkipped = await copyDirTolerant(wifiResourcesSrcPath, wifiResourcesDestPath) ;
                            warnSkippedFiles(this.logger_, "asset 'wifi-resources'", resSkipped) ;
                            const gitDir = path.join(wifiResourcesDestPath, '.git') ;
                            if (fs.existsSync(gitDir)) {
                                try {
                                    await fs.promises.rm(gitDir, { recursive: true, force: true }) ;
                                } catch (err) {
                                    this.logger_.warn(`Failed to remove .git from wifi-resources: ${err}`) ;
                                }
                            }
                        } else {
                            this.logger_.warn(`Companion asset 'wifi-resources' not found at '${wifiResourcesSrcPath}' - skipping resource defines`) ;
                        }
                    }

                    if (fs.existsSync(wifiResourcesDestPath)) {
                        generateWifiHostDriverResourceDefines(destPath, wifiResourcesDestPath) ;
                        this.logger_.info(`Appended WiFi resource defines to wifi-host-driver CMakeLists.txt`) ;
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

        const dependsPath = this.dependsPath ?? '' ;
        const dependsDB = loadDependsDB(dependsPath) ;

        for (const project of appInfo.projects) {
            const projName = project.name ;
            const srcProjDir = project.path ;
            const destProjDir = path.join(this.dest_, projName) ;

            if (!this.cmakeOnly) {
                this.logger_.info(`Copying project '${projName}' from '${srcProjDir}'`) ;
                const projSkipped = await copyDirTolerant(srcProjDir, destProjDir) ;
                warnSkippedFiles(this.logger_, `project '${projName}'`, projSkipped) ;

                // Remove makefiles
                for (const mf of ['Makefile', 'makefile']) {
                    const mfPath = path.join(destProjDir, mf) ;
                    if (fs.existsSync(mfPath)) {
                        this.logger_.info(`Removing ${mf} from project '${projName}'`) ;
                        fs.unlinkSync(mfPath) ;
                    }
                }
            }

            // Collect asset subdirectory references for this project
            const assetSubs: AssetSubdirectory[] = [] ;
            const projectIncludeDirs: ConditionalIncludeDir[] = [] ;

            // Recursively find all directories under the project root that contain
            // header files (*.h) and add each unique directory to the include path.
            const headerDirs = collectProjectHeaderDirs(destProjDir, destProjDir) ;
            for (const d of headerDirs) {
                projectIncludeDirs.push(d) ;
                const relLabel = d.path.replace('${CMAKE_CURRENT_SOURCE_DIR}/', '').replace('${CMAKE_CURRENT_SOURCE_DIR}', '.') ;
                this.logger_.info(`  Adding project include directory: ${relLabel}`) ;
            }

            const dirList = project.dirList ;
            const seenAssets = new Set<string>() ;

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
                    const dependsEntryForAsset = dependsDB.find(e => e.name === assetName) ;
                    if (dependsEntryForAsset?.excludes) {
                        for (const excl of dependsEntryForAsset.excludes) {
                            assetIgnorePaths.push(path.join(destAssetPath, excl)) ;
                        }
                    }

                    // Only include assets that have source or library files active for this project's components.
                    // Apply the same ignore paths used during CMakeLists generation so that assets
                    // with all sources ignored (e.g. entire directory ignored) are not included.
                    // Also guard against assets where no CMakeLists.txt was generated at all
                    // (e.g. another project's ignore rules suppressed the whole directory).
                    const assetCMakeLists = path.join(destAssetPath, 'CMakeLists.txt') ;
                    const assetSources = collectSources(destAssetPath, destAssetPath, [], assetIgnorePaths) ;
                    const assetLibraries = collectLibraries(destAssetPath, destAssetPath, [], assetIgnorePaths) ;
                    if (fs.existsSync(assetCMakeLists) && (hasActiveSources(assetSources, project.components) || hasActiveSources(assetLibraries, project.components))) {
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
                            this.cmseProjects_.add(projName) ;
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

            // Remap linker flag/lib paths that reference files inside source asset
            // directories (e.g. ../../mtb_shared/wifi-host-driver/...) to the
            // corresponding path under assets/<name>/ in the cmake project layout.
            const assetPathMap = new Map<string, string>() ;
            for (const req of project.assetsRequests) {
                if (req.isBSP()) continue ;
                const aName = req.name() ;
                if (aName === 'device-db') continue ;
                const srcAssetPath = req.fullPath(dirList) ;
                assetPathMap.set(
                    path.normalize(srcAssetPath),
                    '${CMAKE_CURRENT_SOURCE_DIR}/../assets/' + aName
                ) ;
            }
            remapFlagPaths(flagsByToolchain, srcProjDir, assetPathMap) ;

            generateProjectCMakeLists(destProjDir, projName, sources, assetSubs, projectIncludeDirs, bspName, components, flagsByToolchain, debugDefines, releaseDefines, dependsDB) ;
            this.logger_.info(`Generated CMakeLists.txt for project '${projName}'`) ;
            generateProjInfoCMake(destProjDir, components) ;
            this.logger_.info(`Generated projinfo.cmake for project '${projName}'`) ;
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
                                debugDefinesRaw = fixDefineFilePaths(d.defines, srcProjDir) ;
                                debugDefinesFile = d.filePath ;
                            }
                        } else {
                            releaseFlags = collectFlagsForConfig(toolchain, 'Release') ;
                            if (releaseDefinesRaw === undefined) {
                                const d = readProjectDefinesForConfig(srcProjDir, 'Release') ;
                                releaseDefinesRaw = fixDefineFilePaths(d.defines, srcProjDir) ;
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

        generateTopLevelCMakeLists(this.dest_, projectNames, bspNameResolved, signCombineInfo, this.setOverrides, this.cmseProjects_) ;
        this.logger_.info('Generated top-level CMakeLists.txt') ;

        // Generate appinfo.cmake using device and component info from the first project.
        if (appInfo.projects.length > 0) {
            const firstProject = appInfo.projects[0] ;
            const device = firstProject.device ?? '' ;
            const additionalDevicesRaw = firstProject.getVar('MTB_ADDITIONAL_DEVICES') ?? '' ;
            const deviceList = [device, ...additionalDevicesRaw.split(' ').filter(d => d.length > 0)] ;
            const components = firstProject.components ;
            generateAppInfoCMake(this.dest_, device, deviceList, bspNameResolved, signCombineInfo, this.setOverrides) ;
            this.logger_.info('Generated appinfo.cmake') ;
        }

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

        generateCMakePresetsFile(this.dest_) ;
        this.logger_.info('Generated CMakePresets.json') ;

        // Resolve BSP name for launch.json search dirs (best-effort; skipped if
        // the bsps/ directory is absent or contains multiple BSPs without --bsp).
        let bspNameForLaunch: string | undefined = bspNameResolved ;
        if (!bspNameForLaunch) {
            try {
                bspNameForLaunch = this.resolveBspName() ;
            } catch {
                // No BSP available yet — launch.json will omit the BSP search dir
            }
        }

        generateVSCodeLaunchJson(this.dest_, projectNames, bspNameForLaunch) ;
        this.logger_.info('Generated .vscode/launch.json') ;

        generateVSCodeTasksJson(this.dest_) ;
        this.logger_.info('Generated .vscode/tasks.json') ;

        generateVSCodeSettingsJson(this.dest_) ;
        this.logger_.info('Generated .vscode/settings.json') ;
    }
}
