import { ModusToolboxEnvironment, MTBLoadFlags } from "./mtbenv";
import { collectSources, collectHeaders, collectLibraries, collectProjectHeaderDirs, generateObjectLibraryCMakeLists, generateHeaderOnlyCMakeLists, generateLibraryAssetCMakeLists, generateProjectCMakeLists, generateTopLevelCMakeLists, generateMtbCMake, generateAppInfoCMake, generateProjInfoCMake, generateGccToolchainCMake, generateIarToolchainCMake, generateLlvmToolchainCMake, generateArmToolchainCMake, generateBspCMakeInclude, generateCMakePresetsFile, generateVSCodeLaunchJson, generateVSCodeTasksJson, generateVSCodeSettingsJson, AssetSubdirectory, loadDependsDB, resolveIncludeDirs, resolveAssetExports, resolveAssetInternals, hasActiveSources, readProjectDefinesByConfig, readProjectDefinesForConfig, fixDefineFilePaths, readProjectFlagsByConfig, readProjectFlagsForConfig, mergeProjectFlagsByConfig, remapFlagPaths, ProjectFlagsByConfig, ProjectFlagsByToolchain, DependsEntry, ConditionalIncludeDir, processSignCombineJson, SignCombineInfo, generateWifiHostDriverResourceDefines } from './cmakeutil';
import { MTBAssetRequest, MTBAssetStorageFormat } from './mtbenv/appdata/mtbassetreq';
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
                if (entry.name === 'build') continue ;
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

    // Preset names (e.g. 'gcc-debug', 'llvm-release') for which at least one project had
    // successful make codegen output.  Populated during copyProjects(); used by generateTopLevel()
    // to filter unsupported configurations out of CMakePresets.json.
    private supportedPresets_ : Set<string> = new Set() ;

    // Top-level shared directories copied from the source app into the destination.
    // Sources from these dirs are inlined directly into each project that references
    // them via MTB_SEARCH rather than being compiled as a separate library.
    private sharedTopLevelDirs_ : { name: string ; srcDir: string ; destPath: string }[] = [] ;

    // Public accessor for the final destination directory chosen by the converter.
    public getGeneratedDir(): string {
        return this.dest_ ;
    }

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
        const baseDest = this.dest_ ;

        // For cmake-only mode require the base destination to exist (we will create a subdir under it).
        if (this.cmakeOnly) {
            if (!fs.existsSync(baseDest)) {
                throw new Error(`Destination directory does not exist: ${baseDest} (--cmake-only requires an existing destination)`) ;
            }
        }

        // If --force was specified, remove the base destination before creating the final subdir.
        if (!this.cmakeOnly && this.forceDeleteDest && fs.existsSync(baseDest)) {
            this.logger_.info(`Removing existing destination directory: ${baseDest}`) ;
            try {
                fs.rmSync(baseDest, { recursive: true, force: true }) ;
            } catch (err: any) {
                throw new Error(`Failed to remove destination directory '${baseDest}': ${err.message}`) ;
            }
        }

        // Choose final destination as a subdirectory 'aN' under the provided destination
        // (e.g., <dest>/a1). Find the first non-existent aN.
        let n = 1 ;
        let finalDest = '' ;
        do {
            finalDest = path.join(baseDest, 'a' + n.toString()) ;
            n++ ;
        } while (fs.existsSync(finalDest)) ;
        if (finalDest !== this.dest_) {
            this.logger_.info(`Using destination subdirectory: ${finalDest}`) ;
        }
        this.dest_ = finalDest ;

        // Ensure destination directory exists for non-cmake-only conversions and write appname.json
        if (!this.cmakeOnly) {
            try {
                fs.mkdirSync(this.dest_, { recursive: true }) ;
            } catch (err: any) {
                throw new Error(`Failed to create destination directory '${this.dest_}': ${err.message}`) ;
            }

            // Write appname.json containing the basename of the source path
            const appnameObj = { appname: path.basename(this.src_) } ;
            const appnamePath = path.join(this.dest_, 'appname.json') ;
            try {
                fs.writeFileSync(appnamePath, JSON.stringify(appnameObj, null, 2), { encoding: 'utf-8' }) ;
                this.logger_.info(`Wrote appname file: ${appnamePath}`) ;
            } catch (err: any) {
                this.logger_.warn(`Failed to write appname.json to '${appnamePath}': ${err.message}`) ;
            }
        }

        await this.env_.load(MTBLoadFlags.appInfo, this.src_) ;
        await this.convertAppInfo() ;
    }

    private async convertAppInfo() : Promise<void> {
        this.logger_.info('Converting app info...') ;
        await this.copyBSPs() ;
        await this.copyAssets() ;
        await this.copyTopLevelSharedDirs() ;
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
        let wifiHostDriverDestPath: string | null = null ;

        for (const project of appInfo.projects) {
            const dirList = project.dirList ;

            for (const req of project.assetsRequests) {
                if (req.isBSP()) {
                    continue ;
                }

                const assetName = req.name() ;
                if (assetName === 'device-db' || assetName === 'core-make') {
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
                // asset to be present. Track the dest path so we can append resource
                // defines after ALL assets have been copied/processed (wifi-resources
                // may appear later in the asset list than wifi-host-driver).
                if (assetName === 'wifi-host-driver') {
                    wifiHostDriverDestPath = destPath ;
                    const wifiResourcesDestPath = path.join(destAssetsDir, 'wifi-resources') ;

                    if (!this.cmakeOnly && !copiedAssets.has('wifi-resources') && !fs.existsSync(wifiResourcesDestPath)) {
                        // wifi-resources was not yet processed. Try to find it as a sibling
                        // in the same shared directory (go up two levels: version → asset → shared,
                        // then look for wifi-resources/release-*).
                        const sharedDir = path.dirname(path.dirname(srcPath)) ;
                        const wifiResBaseDir = path.join(sharedDir, 'wifi-resources') ;
                        let wifiResourcesSrcPath : string | undefined ;
                        if (fs.existsSync(wifiResBaseDir)) {
                            const entries = fs.readdirSync(wifiResBaseDir) ;
                            const versionDir = entries.find(e => e.startsWith('release-')) ;
                            if (versionDir) {
                                wifiResourcesSrcPath = path.join(wifiResBaseDir, versionDir) ;
                            }
                        }
                        if (wifiResourcesSrcPath && fs.existsSync(wifiResourcesSrcPath)) {
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
                            this.logger_.warn(`Companion asset 'wifi-resources' not found near '${srcPath}' - resource defines will be omitted`) ;
                        }
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

        // Post-processing: append wifi-host-driver resource defines after ALL assets
        // are in the destination (wifi-resources may have been copied after wifi-host-driver).
        if (wifiHostDriverDestPath) {
            const wifiResourcesDestPath = path.join(destAssetsDir, 'wifi-resources') ;
            if (fs.existsSync(wifiResourcesDestPath)) {
                generateWifiHostDriverResourceDefines(wifiHostDriverDestPath, wifiResourcesDestPath) ;
                this.logger_.info(`Appended WiFi resource defines to wifi-host-driver CMakeLists.txt`) ;
            } else {
                this.logger_.warn(`wifi-resources not found in destination - WiFi resource defines omitted from wifi-host-driver`) ;
            }
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

    private async copyTopLevelSharedDirs() : Promise<void> {
        const appInfo = this.env_.appInfo ;
        if (!appInfo) return ;
        const entries = fs.readdirSync(this.src_, { withFileTypes: true }) ;
        const projectPaths = new Set(appInfo.projects.map(p => path.normalize(p.path))) ;
        for (const entry of entries) {
            if (!entry.isDirectory()) continue ;
            // Skip BSPs directory (case-insensitive) — BSPs are handled separately via copyBSPs()
            if (entry.name.toLowerCase() === 'bsps') continue ;
            const srcDir = path.join(this.src_, entry.name) ;
            // Skip if this directory is a known project path
            if (projectPaths.has(path.normalize(srcDir))) continue ;
            // Determine if the directory contains code files (.h, .c, .cpp, .cc, .s)
            const hasCode = (dir: string) : boolean => {
                const stack = [dir] ;
                while (stack.length > 0) {
                    const d = stack.pop()! ;
                    let ents: fs.Dirent[] ;
                    try { ents = fs.readdirSync(d, { withFileTypes: true }) ; } catch { continue ; }
                    for (const e of ents) {
                        const p = path.join(d, e.name) ;
                        if (e.isFile()) {
                            const ext = path.extname(e.name).toLowerCase() ;
                            if (ext === '.h' || ext === '.c' || ext === '.cpp' || ext === '.cc' || ext === '.cxx' || ext === '.s') {
                                return true ;
                            }
                        } else if (e.isDirectory()) {
                            stack.push(p) ;
                        }
                    }
                }
                return false ;
            } ;
            if (!hasCode(srcDir)) continue ;
            const destDir = path.join(this.dest_, entry.name) ;
            if (!this.cmakeOnly) {
                this.logger_.info(`Copying top-level shared directory: ${entry.name}`) ;
                const skipped = await copyDirTolerant(srcDir, destDir) ;
                warnSkippedFiles(this.logger_, `shared '${entry.name}'`, skipped) ;
                const gitDir = path.join(destDir, '.git') ;
                if (fs.existsSync(gitDir)) {
                    try { await fs.promises.rm(gitDir, { recursive: true, force: true }) ; } catch (e) { this.logger_.warn(`Failed to remove .git from shared '${entry.name}': ${e}`) ; }
                }
            } else if (!fs.existsSync(destDir)) {
                this.logger_.warn(`Shared directory '${entry.name}' not found in destination - skipping`) ;
                continue ;
            }
            // Collect sources from the destination dir for inline use in projects.
            // No CMakeLists.txt library is generated — sources are inlined directly
            // into each project that lists this directory in its MTB_SEARCH path.
            this.sharedTopLevelDirs_.push({ name: entry.name, srcDir: srcDir, destPath: destDir }) ;
        }
    }

    private async copyProjects() : Promise<void> {
        const appInfo = this.env_.appInfo ;
        if (!appInfo) {
            this.logger_.warn('No application info available - cannot copy projects') ;
            return ;
        }

        const dependsPath = this.dependsPath ?? '' ;
        const dependsDB = loadDependsDB(dependsPath) ;

        // Resolve the active BSP once up-front and read its dep asset names so we
        // can classify BSP-sourced assets as conditional in firmware.cmake.
        const bspDepsAssets = new Set<string>() ;
        let resolvedBspName: string | undefined ;
        try {
            resolvedBspName = this.resolveBspName() ;
            const bspDepsDir = path.join(this.dest_, 'bsps', resolvedBspName, 'deps') ;
            if (fs.existsSync(bspDepsDir)) {
                for (const dep of fs.readdirSync(bspDepsDir, { withFileTypes: true })) {
                    if (dep.isFile() && dep.name.endsWith('.mtbx')) {
                        try {
                            const req = MTBAssetRequest.createFromFile(
                                path.join(bspDepsDir, dep.name), MTBAssetStorageFormat.MTBX, true) ;
                            const name = req.name() ;
                            if (!name.startsWith('TARGET_')) {
                                bspDepsAssets.add(name) ;
                                this.logger_.info(`  BSP dep asset: ${name}`) ;
                            }
                        } catch (e) {
                            this.logger_.warn(`  Could not parse BSP dep file: ${e}`) ;
                        }
                    }
                }
            }
        } catch {
            // No BSP available — all assets will be unconditional in firmware.cmake
        }

        for (const project of appInfo.projects) {
            const projName = project.name ;
            const srcProjDir = project.path ;
            const destProjDir = path.join(this.dest_, projName) ;
            const normSrcProj = path.normalize(srcProjDir) ;
            const projectIgnorePaths = project.ignorePath()
                .filter(ip => path.normalize(ip).startsWith(normSrcProj))
                .map(ip => path.join(destProjDir, path.relative(srcProjDir, ip))) ;

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
            const headerDirs = collectProjectHeaderDirs(destProjDir, destProjDir, projectIgnorePaths) ;
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
                if (assetName === 'core-make') {
                    continue ;
                }
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
                            targetName: `${projName}_cm33_${assetName}`,
                            bspName: bspDepsAssets.has(assetName) ? resolvedBspName : undefined
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

            // Add top-level shared directory sources directly into the project
            // if the shared dir is part of this project's MTB_SEARCH path.
            const projectSearchPathsNorm = project.searchPath().map(p => path.normalize(p)) ;

            // Collect project-level sources, then inline sources from shared top-level
            // directories that this project references via MTB_SEARCH.
            let sources = collectSources(destProjDir, destProjDir, [], projectIgnorePaths) ;
            for (const shared of this.sharedTopLevelDirs_) {
                if (!projectSearchPathsNorm.includes(path.normalize(shared.srcDir))) continue ;
                if (!fs.existsSync(shared.destPath)) {
                    this.logger_.warn(`  Shared directory '${shared.name}' not found in destination - skipping`) ;
                    continue ;
                }
                this.logger_.info(`  Inlining shared directory '${shared.name}' sources into project '${projName}'`) ;
                const sharedIgnorePaths = project.ignorePath()
                    .filter(ip => path.normalize(ip).startsWith(path.normalize(shared.srcDir)))
                    .map(ip => path.join(shared.destPath, path.relative(shared.srcDir, ip))) ;
                sources.push(...collectSources(shared.destPath, destProjDir, [], sharedIgnorePaths)) ;
                projectIncludeDirs.push(...collectProjectHeaderDirs(shared.destPath, destProjDir)) ;
            }

            const components = project.components ;

            // Run 'make codegen' for each toolchain (LLVM_ARM, IAR, GCC_ARM, ARM) in both
            // Debug and Release configurations.  The flag files (.cflags etc.) are written to
            // build/<BSP>/{Debug,Release}/ and are overwritten for each toolchain, so they must
            // be read immediately after each toolchain's pair of runs.
            const codegenResult = await this.runMakeCodegenForProject(srcProjDir) ;
            const flagsByToolchain = codegenResult.flags ;

            const toolchainToPresetName: Record<string, string> = {
                GCC_ARM:  'gcc',
                IAR:      'iar',
                LLVM_ARM: 'llvm',
                ARM:      'arm',
            } ;

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

                    // Track which (toolchain, config) combinations produced flags so that
                    // generateTopLevel() can exclude unsupported presets from CMakePresets.json.
                    const shortName = toolchainToPresetName[tc] ;
                    if (shortName) {
                        const hasDebug = !!(
                            fbc.c.debugFile || fbc.asm.debugFile || fbc.cxx.debugFile ||
                            fbc.link.debugFile || fbc.libs.debugFile
                        ) ;
                        const hasRelease = !!(
                            fbc.c.releaseFile || fbc.asm.releaseFile || fbc.cxx.releaseFile ||
                            fbc.link.releaseFile || fbc.libs.releaseFile
                        ) ;
                        if (hasDebug)   this.supportedPresets_.add(`${shortName}-debug`) ;
                        if (hasRelease) this.supportedPresets_.add(`${shortName}-release`) ;
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
            // Also exclude wifi image defines that are emitted conditionally by the
            // wifi-host-driver CMakeLists.txt and must not be duplicated at project level.
            const componentDefineNames = new Set(
                components.map(c => `COMPONENT_${c.replace(/-/g, '_')}`)
            ) ;
            const wifiImageDefines = new Set([
                'CLM_IMAGE_NAME', 'CLM_IMAGE_SIZE',
                'FW_IMAGE_NAME',  'FW_IMAGE_SIZE',
                'NVRAM_IMAGE_NAME', 'NVRAM_IMAGE_SIZE',
            ]) ;
            const filterDefines = (defs: string[]) => defs.filter(d => {
                const name = d.split('=')[0] ;
                return !name.startsWith('COMPONENT_') && !componentDefineNames.has(name) && !wifiImageDefines.has(name) ;
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
                if (aName === 'device-db' || aName === 'core-make') continue ;
                const srcAssetPath = req.fullPath(dirList) ;
                assetPathMap.set(
                    path.normalize(srcAssetPath),
                    '${CMAKE_CURRENT_SOURCE_DIR}/../assets/' + aName
                ) ;
            }
            remapFlagPaths(flagsByToolchain, srcProjDir, assetPathMap) ;

            generateProjectCMakeLists(destProjDir, projName, sources, assetSubs, projectIncludeDirs, resolvedBspName, components, flagsByToolchain, debugDefines, releaseDefines, dependsDB) ;
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
            // --image_input flags are also stripped as they are not needed for CMake builds.
            const filterIarLinkFlags = (flagList: string[]) : string[] => {
                const out: string[] = [] ;
                let i = 0 ;
                while (i < flagList.length) {
                    const flag = flagList[i] ;
                    // Strip --image_input (with optional =arg or space-separated arg).
                    if (flag === '--image_input') {
                        i++ ; // consume flag
                        if (i < flagList.length && !flagList[i].startsWith('-')) {
                            i++ ; // consume argument
                        }
                        continue ;
                    }
                    if (flag.match(/^--image_input[= ]/)) {
                        i++ ;
                        continue ;
                    }
                    const m = flag.match(/^(-{1,2}config=)(.+)$/) ;
                    if (m) {
                        const filePath = m[2].replace(/^["']|["']$/g, '').replace(/\\/g, '/') ;
                        if (!path.isAbsolute(filePath) && !filePath.startsWith('${')) {
                            out.push(`${m[1]}\${CMAKE_CURRENT_SOURCE_DIR}/${filePath}`) ;
                            i++ ;
                            continue ;
                        }
                    }
                    out.push(flagList[i++]) ;
                }
                return out ;
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
            if (tc === 'IAR') return applyIarFiltering(flags) ;
            if (tc === 'ARM') {
                // MTB generates .asflags (armclang-format) and .asflags_s (armasm-format).
                // Since armasm is the assembler, replace the asm flags with .asflags_s.
                const replaceAsmFlagsFromSFile = (flagFile: string | undefined) : { flags: string[], file: string | undefined } => {
                    if (!flagFile) return { flags: [], file: undefined } ;
                    const sFile = flagFile.replace(/\.asflags$/, '.asflags_s') ;
                    if (!fs.existsSync(sFile)) return { flags: [], file: undefined } ;
                    const raw = fs.readFileSync(sFile, 'utf-8').trim().split(/\s+/).filter(t => t.length > 0) ;
                    // armasm does not support -D (defines) or -I (includes); strip them.
                    const tokens: string[] = [] ;
                    for (let i = 0; i < raw.length; i++) {
                        const t = raw[i] ;
                        if (t === '-D' || t === '-I') { i++ ; continue ; } // two-token form
                        if (t.startsWith('-D') || t.startsWith('-I')) continue ; // single-token form
                        tokens.push(t) ;
                    }
                    return { flags: tokens, file: sFile } ;
                } ;
                const dbg = replaceAsmFlagsFromSFile(flags.asm.debugFile) ;
                const rel = replaceAsmFlagsFromSFile(flags.asm.releaseFile) ;
                flags.asm = {
                    debug:       dbg.flags,
                    release:     rel.flags,
                    debugFile:   dbg.file,
                    releaseFile: rel.file,
                } ;
            }
            return flags ;
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

        // Resolve BSP independently from sign-combine detection so appinfo.cmake can
        // always populate MTBBSP/BSPPATH when a BSP is available.
        try {
            bspNameResolved = this.resolveBspName() ;
        } catch {
            // Keep best-effort behavior: top-level generation can still proceed without BSP.
        }

        if (signJsonPath) {
            try {
                signCombineInfo = processSignCombineJson(signJsonPath, this.dest_, this.setOverrides) ;
                this.logger_.info(`Processed sign-combine config: ${signJsonPath}`) ;
            } catch (err: any) {
                this.logger_.warn(`Sign-combine processing skipped: ${err.message}`) ;
            }
        }

        const sortedProjectNames = generateTopLevelCMakeLists(this.dest_, projectNames, bspNameResolved, signCombineInfo, this.setOverrides, this.cmseProjects_) ;
        this.logger_.info('Generated top-level CMakeLists.txt') ;

        generateMtbCMake(this.dest_, bspNameResolved, signCombineInfo) ;
        this.logger_.info('Generated mtb.cmake') ;

        // Generate appinfo.cmake with project list, BSP name/path, and sign-combine symbols.
        if (appInfo.projects.length > 0) {
            generateAppInfoCMake(this.dest_, sortedProjectNames, bspNameResolved, signCombineInfo, this.setOverrides) ;
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

        generateCMakePresetsFile(this.dest_, this.supportedPresets_.size > 0 ? this.supportedPresets_ : undefined) ;
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
