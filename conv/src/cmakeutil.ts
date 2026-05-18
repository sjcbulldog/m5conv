import * as fs from 'fs';
import * as path from 'path';

//
// An import that is conditional on a COMPONENT_* define.
//
export interface ComponentImport {
    component: string ;
    name: string ;
}

//
// An entry in the depends.json file describing an asset's
// exported include directories and imported dependencies.
//
export interface DependsEntry {
    name: string ;
    exports: string[] ;
    imports: (string | ComponentImport)[] ;
    includes?: string[] ;
    internal?: string[] ;
}

export interface CompileEntry {
    languages: string[] ;
    flags: string[] ;
}

export interface LinkEntry {
    flags: string[] ;
}

export interface CompileOptionsEntry {
    compile: CompileEntry ;
    link?: LinkEntry ;
}

//
// Flags read from a flag file (.cflags, .asflags, .cxxflags, .ldflags)
// for both Debug and Release configurations.
//
export interface ConfigFlagSet {
    debug: string[] ;
    release: string[] ;
    debugFile?: string ;
    releaseFile?: string ;
    // Set to true on link flag sets when CMSE veneer generation flags are present.
    hasCmse?: boolean ;
    // Linker library search directories extracted from -L / -Xlinker -L flags.
    linkDirs?: string[] ;
}

//
// Flag sets for all five flag files, keyed by language/purpose.
//
export interface ProjectFlagsByConfig {
    c: ConfigFlagSet ;
    asm: ConfigFlagSet ;
    cxx: ConfigFlagSet ;
    link: ConfigFlagSet ;
    // Entries from .ldlibs (additional link inputs, e.g. CMSE veneer object).
    libs: ConfigFlagSet ;
}

//
// Flag sets indexed by toolchain name.  Each key is a toolchain name as used
// by the ModusToolbox build system (e.g. 'GCC_ARM', 'IAR', 'LLVM_ARM', 'ARM').
// Built by running 'make codegen TOOLCHAIN=<t> CONFIG=<c>' for each combination
// and reading the resulting flag files after each toolchain pair.
//
export interface ProjectFlagsByToolchain {
    [toolchain: string]: ProjectFlagsByConfig ;
}

//
// Strip single-line (//) and multi-line (/* */) comments from a
// JSON string so it can be parsed with the standard JSON.parse.
//
function stripJsonComments(text: string) : string {
    let result = '' ;
    let i = 0 ;
    let inString = false ;
    let escape = false ;

    while (i < text.length) {
        const ch = text[i] ;

        if (escape) {
            result += ch ;
            escape = false ;
            i++ ;
            continue ;
        }

        if (inString) {
            if (ch === '\\') {
                escape = true ;
            } else if (ch === '"') {
                inString = false ;
            }
            result += ch ;
            i++ ;
            continue ;
        }

        // Not inside a string
        if (ch === '"') {
            inString = true ;
            result += ch ;
            i++ ;
        } else if (ch === '/' && i + 1 < text.length && text[i + 1] === '/') {
            // Single-line comment – skip to end of line
            i += 2 ;
            while (i < text.length && text[i] !== '\n') {
                i++ ;
            }
        } else if (ch === '/' && i + 1 < text.length && text[i + 1] === '*') {
            // Multi-line comment – skip to closing */
            i += 2 ;
            while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
                i++ ;
            }
            i += 2 ; // skip */
        } else {
            result += ch ;
            i++ ;
        }
    }

    return result ;
}

//
// Load the depends.json database from the given file path.
// Supports JSON with single-line and multi-line comments.
//
export function loadDependsDB(filePath: string) : DependsEntry[] {
    if (!fs.existsSync(filePath)) {
        return [] ;
    }
    const data = fs.readFileSync(filePath, 'utf-8') ;
    return JSON.parse(stripJsonComments(data)) as DependsEntry[] ;
}

export function loadCompileOptionsDB(filePath: string) : Record<string, CompileOptionsEntry> {
    if (!fs.existsSync(filePath)) {
        return {} ;
    }
    const data = fs.readFileSync(filePath, 'utf-8') ;
    return JSON.parse(stripJsonComments(data)) as Record<string, CompileOptionsEntry> ;
}

export function inferCompileOptionsProfile(coreType: string, coreName: string) : string | undefined {
    const normalizedType = coreType.trim().toLowerCase() ;
    const normalizedName = coreName.trim().toLowerCase() ;
    const combined = `${normalizedType} ${normalizedName}` ;

    if (combined.includes('m55') || combined.includes('cm55') || combined.includes('cortex-m55')) {
        return 'm55' ;
    }

    if (combined.includes('m33') || combined.includes('cm33') || combined.includes('cortex-m33')) {
        if (
            normalizedType.includes('_ns') ||
            normalizedType.includes('-ns') ||
            normalizedType.includes(' non-secure') ||
            normalizedType.includes(' nonsecure') ||
            normalizedName.includes('_ns') ||
            normalizedName.includes('-ns') ||
            normalizedName.includes(' non-secure') ||
            normalizedName.includes(' nonsecure')
        ) {
            return 'm33_ns' ;
        }

        if (
            normalizedType.includes('_s') ||
            normalizedType.includes('-s') ||
            normalizedType.includes(' secure') ||
            normalizedName.includes('_s') ||
            normalizedName.includes('-s') ||
            normalizedName.includes(' secure')
        ) {
            return 'm33_s' ;
        }

        return 'm33_ns' ;
    }

    return undefined ;
}

export function buildCompileLines(compile: CompileEntry) : string[] {
    if (compile.languages.length === 0 || compile.flags.length === 0) {
        return [] ;
    }

    const lines: string[] = [] ;
    const rawFlags = compile.flags.filter(f => f.trim() !== ')') ;
    for (const lang of compile.languages) {
        lines.push('add_compile_options(') ;
        for (const flag of rawFlags) {
            lines.push(flag.replace(/__LANG__/g, lang)) ;
        }
        lines.push(')') ;
    }

    return lines ;
}

export function buildLinkLines(link: LinkEntry) : string[] {
    if (link.flags.length === 0) {
        return [] ;
    }

    const lines: string[] = [] ;
    lines.push('add_link_options(') ;
    for (const flag of link.flags) {
        lines.push(`    ${flag}`) ;
    }
    lines.push(')') ;

    return lines ;
}

//
// Locate the .defines file produced by a ModusToolbox build under
// PROJECT/build/BSPNAME/CONFIGNAME/.defines.  Debug is preferred
// over Release; the first matching file found is returned.
//
export function findDefinesFile(srcProjDir: string) : string | undefined {
    const buildDir = path.join(srcProjDir, 'build') ;
    if (!fs.existsSync(buildDir)) {
        return undefined ;
    }

    const bspEntries = fs.readdirSync(buildDir, { withFileTypes: true })
        .filter(e => e.isDirectory()) ;

    const preferredConfigs = ['Debug', 'Release'] ;

    for (const config of preferredConfigs) {
        for (const bsp of bspEntries) {
            const candidate = path.join(buildDir, bsp.name, config, '.defines') ;
            if (fs.existsSync(candidate)) {
                return candidate ;
            }
        }
    }

    // Fall back to any config found
    for (const bsp of bspEntries) {
        const bspPath = path.join(buildDir, bsp.name) ;
        const configEntries = fs.readdirSync(bspPath, { withFileTypes: true })
            .filter(e => e.isDirectory()) ;
        for (const config of configEntries) {
            const candidate = path.join(bspPath, config.name, '.defines') ;
            if (fs.existsSync(candidate)) {
                return candidate ;
            }
        }
    }

    return undefined ;
}

//
// Locate the .defines files for both Debug and Release configurations under
// PROJECT/build/BSPNAME/{Debug,Release}/.defines.  Both configs are looked up
// from the same BSP directory — the first BSP directory that has at least one
// config is used to avoid mixing artefacts from different stale builds.
//
export function findDefinesFiles(srcProjDir: string) : { debug?: string ; release?: string } {
    const buildDir = path.join(srcProjDir, 'build') ;
    if (!fs.existsSync(buildDir)) {
        return {} ;
    }

    const bspEntries = fs.readdirSync(buildDir, { withFileTypes: true })
        .filter(e => e.isDirectory()) ;

    for (const bsp of bspEntries) {
        const bspPath = path.join(buildDir, bsp.name) ;
        const debugCandidate = path.join(bspPath, 'Debug', '.defines') ;
        const releaseCandidate = path.join(bspPath, 'Release', '.defines') ;
        const hasDebug = fs.existsSync(debugCandidate) ;
        const hasRelease = fs.existsSync(releaseCandidate) ;
        if (hasDebug || hasRelease) {
            return {
                debug: hasDebug ? debugCandidate : undefined,
                release: hasRelease ? releaseCandidate : undefined
            } ;
        }
    }

    return {} ;
}

function readDefinesFromFile(filePath: string) : string[] {
    const defines: string[] = [] ;
    const content = fs.readFileSync(filePath, 'utf-8') ;
    for (const token of content.split(/\s+/)) {
        const trimmed = token.trim() ;
        if (trimmed.startsWith('-D')) {
            const value = trimmed.substring(2).replace(/='([^']*)'$/, '=$1') ;
            if (value.length > 0) {
                defines.push(value) ;
            }
        }
    }
    return defines ;
}

//
// Read the .defines file for a project and return all preprocessor
// defines as bare strings (the leading -D is stripped).  Each line
// in the file is expected to contain one -D flag.
//
export function readProjectDefines(srcProjDir: string) : string[] {
    const definesPath = findDefinesFile(srcProjDir) ;
    if (!definesPath) {
        return [] ;
    }
    return readDefinesFromFile(definesPath) ;
}

//
// Read the .defines files for both Debug and Release configurations.
// Returns the defines for each config as arrays of bare strings
// (leading -D stripped), plus the paths to the files that were read.
//
export function readProjectDefinesByConfig(srcProjDir: string) : {
    debug: string[] ;
    release: string[] ;
    debugFile?: string ;
    releaseFile?: string ;
} {
    const files = findDefinesFiles(srcProjDir) ;
    return {
        debug:       files.debug   ? readDefinesFromFile(files.debug)   : [] ,
        release:     files.release ? readDefinesFromFile(files.release) : [] ,
        debugFile:   files.debug ,
        releaseFile: files.release ,
    } ;
}

//
// Read the .defines file for a single build configuration (Debug or Release).
// Returns the defines as bare strings (leading -D stripped) plus the path to
// the file that was read.
//
// Search order:
//   1. build/<BSPNAME>/<config>/.defines  (Model 1: BSP/CONFIG layout)
//   2. build/.defines                     (Model 2: flat layout)
//
// This must be called immediately after each configuration's codegen run when
// using the flat layout, because successive codegen runs overwrite the same file.
//
export function readProjectDefinesForConfig(
    srcProjDir: string,
    config: 'Debug' | 'Release',
) : { defines: string[] ; filePath?: string } {
    const buildDir = path.join(srcProjDir, 'build') ;
    if (!fs.existsSync(buildDir)) {
        return { defines: [] } ;
    }

    // Model 1: build/BSPNAME/Config/.defines
    for (const bsp of fs.readdirSync(buildDir, { withFileTypes: true }).filter(e => e.isDirectory())) {
        const candidate = path.join(buildDir, bsp.name, config, '.defines') ;
        if (fs.existsSync(candidate)) {
            return { defines: readDefinesFromFile(candidate), filePath: candidate } ;
        }
    }

    // Model 2: build/.defines (flat layout — caller must read immediately after codegen)
    const flat = path.join(buildDir, '.defines') ;
    if (fs.existsSync(flat)) {
        return { defines: readDefinesFromFile(flat), filePath: flat } ;
    }

    return { defines: [] } ;
}

// ---------------------------------------------------------------------------
// Flag-file reading (.cflags / .asflags / .cxxflags / .ldflags)
// ---------------------------------------------------------------------------

// Single-token compile flags managed by the CMake build system.
const SKIP_COMPILE_FLAGS = new Set(['-c', '-MD', '-MMD', '-MP', '-MG']) ;

// Compile flags that consume the next whitespace-separated token as their argument.
const SKIP_COMPILE_FLAGS_WITH_ARG = new Set(['-MF', '-MT', '-MQ', '-o']) ;

// Linker tokens that either are CMake group markers or are build-system placeholders.
const SKIP_LINK_TOKENS = new Set(['-Wl,--start-group', '-Wl,--end-group']) ;

// Linker flags that consume the next whitespace-separated token as their argument.
const SKIP_LINK_FLAGS_WITH_ARG = new Set(['-o']) ;

//
// Rewrite a single linker flag token so that any embedded relative path
// (../foo) is anchored to ${CMAKE_CURRENT_SOURCE_DIR}.  Handles:
//   - bare relative paths          ../foo
//   - -T"../foo"                   quoted linker script (quotes stripped)
//   - -T../foo                     unquoted linker script
//   - -Wl,../foo                   comma-joined -Wl token
//
function fixRelativePath(token: string) : string {
    const srcVar = '${CMAKE_CURRENT_SOURCE_DIR}' ;

    // Bare relative path
    if (/^\.\.\//.test(token)) {
        return `${srcVar}/${token}` ;
    }
    // -T"../..." quoted linker script — strip quotes in output
    const tq = /^-T"(\.\.\/[^"]+)"$/.exec(token) ;
    if (tq) {
        return `-T${srcVar}/${tq[1]}` ;
    }
    // -T../... unquoted linker script
    const tu = /^-T(\.\.\/[^"]\S*)$/.exec(token) ;
    if (tu) {
        return `-T${srcVar}/${tu[1]}` ;
    }
    // -Wl,../... comma-joined flag
    const wl = /^(-Wl,)(\.\.\/\S+)$/.exec(token) ;
    if (wl) {
        return `${wl[1]}${srcVar}/${wl[2]}` ;
    }
    return token ;
}

//
// Tokenize a flag-file line (space-separated) and remove compile flags
// that CMake manages itself (dependency generation, output file, etc.).
//
function filterCompileTokens(tokens: string[]) : string[] {
    const result: string[] = [] ;
    let i = 0 ;
    while (i < tokens.length) {
        const tok = tokens[i] ;
        if (SKIP_COMPILE_FLAGS.has(tok)) {
            i++ ;
        } else if (SKIP_COMPILE_FLAGS_WITH_ARG.has(tok)) {
            i += 2 ;
        } else {
            result.push(tok) ;
            i++ ;
        }
    }
    return result ;
}

//
// Tokenize a linker flag-file line and remove/fix tokens that the CMake
// build system manages or that are Ninja/Make build-system placeholders.
// Relative paths are rewritten relative to ${CMAKE_CURRENT_SOURCE_DIR}.
// CMSE veneer generation flags (-Wl,--cmse-implib / --in-implib / --out-implib)
// are stripped; their presence is signalled via hasCmse.
// Library search path flags (-Xlinker -L <dir>, -L <dir>, -L<dir>) are
// stripped from the flag list and returned separately in linkDirs.
//
function filterLinkTokens(tokens: string[]) : { flags: string[], hasCmse: boolean, linkDirs: string[] } {
    const result: string[] = [] ;
    let hasCmse = false ;
    const linkDirs: string[] = [] ;
    let i = 0 ;
    while (i < tokens.length) {
        const tok = tokens[i] ;
        if (tok === '-Wl,--cmse-implib') {
            hasCmse = true ;
            i++ ;
        } else if (tok === '-Wl,--in-implib' || tok === '-Wl,--out-implib') {
            // Each is followed by a separate -Wl,<path> token — skip both.
            hasCmse = true ;
            i += 2 ;
        } else if (tok === '-Xlinker' && i + 2 < tokens.length && tokens[i + 1] === '-L') {
            // -Xlinker -L <dir> — extract the directory
            linkDirs.push(fixRelativePath(tokens[i + 2])) ;
            i += 3 ;
        } else if (tok === '-L' && i + 1 < tokens.length) {
            // -L <dir> (space-separated)
            linkDirs.push(fixRelativePath(tokens[i + 1])) ;
            i += 2 ;
        } else if (/^-L.+/.test(tok)) {
            // -L<dir> (attached, no space)
            linkDirs.push(fixRelativePath(tok.slice(2))) ;
            i++ ;
        } else if (SKIP_LINK_TOKENS.has(tok) || tok.includes('@')) {
            i++ ;
        } else if (SKIP_LINK_FLAGS_WITH_ARG.has(tok)) {
            i += 2 ;
        } else {
            result.push(fixRelativePath(tok)) ;
            i++ ;
        }
    }
    return { flags: result, hasCmse, linkDirs } ;
}

function parseFlags(content: string, isLink: boolean) : { flags: string[], hasCmse?: boolean, linkDirs?: string[] } {
    const tokens = content.trim().split(/\s+/).filter(t => t.length > 0) ;
    if (isLink) {
        const { flags, hasCmse, linkDirs } = filterLinkTokens(tokens) ;
        return { flags, hasCmse, linkDirs } ;
    }
    return { flags: filterCompileTokens(tokens) } ;
}

//
// Rewrite a single .ldlibs path token.  Object files (.o / .obj) are build
// artifacts that live in the CMake binary tree; everything else (prebuilt
// archives) lives in the source tree.
//
function fixLdLibPath(token: string) : string {
    if (!/^\.\.\//.test(token)) return token ;
    const binVar = '${CMAKE_CURRENT_BINARY_DIR}' ;
    const srcVar = '${CMAKE_CURRENT_SOURCE_DIR}' ;
    return /\.o(?:bj)?$/.test(token)
        ? `${binVar}/${token}`
        : `${srcVar}/${token}` ;
}

//
// Parse a .ldlibs file: space/newline-separated linker input paths.
// Relative paths are rewritten based on file type (see fixLdLibPath).
//
function parseLdLibs(content: string) : string[] {
    return content.trim().split(/\s+/)
        .filter(t => t.length > 0)
        .map(fixLdLibPath) ;
}

function emptyFlags() : ProjectFlagsByConfig {
    const e = () : ConfigFlagSet => ({ debug: [], release: [] }) ;
    return { c: e(), asm: e(), cxx: e(), link: e(), libs: e() } ;
}

//
// Read the .cflags, .asflags, .cxxflags, .ldflags, and .ldlibs files for
// both Debug and Release configurations.  Flags that are managed by the CMake
// build process (dependency generation, output-file selection) are omitted.
// CMSE veneer flags are stripped from ldflags and surfaced as link.hasCmse.
// Relative paths in linker flags are rewritten using ${CMAKE_CURRENT_SOURCE_DIR}
// (source artifacts) or ${CMAKE_CURRENT_BINARY_DIR} (object-file artifacts).
//
export function readProjectFlagsByConfig(srcProjDir: string) : ProjectFlagsByConfig {
    const buildDir = path.join(srcProjDir, 'build') ;
    if (!fs.existsSync(buildDir)) {
        return emptyFlags() ;
    }

    const bspEntries = fs.readdirSync(buildDir, { withFileTypes: true })
        .filter(e => e.isDirectory()) ;

    for (const bsp of bspEntries) {
        const bspPath = path.join(buildDir, bsp.name) ;
        const debugDir = path.join(bspPath, 'Debug') ;
        const releaseDir = path.join(bspPath, 'Release') ;

        const fileNames = ['.cflags', '.asflags', '.cxxflags', '.ldflags', '.ldlibs'] ;
        const hasAnyFlagFile = fileNames.some(
            f => fs.existsSync(path.join(debugDir, f)) || fs.existsSync(path.join(releaseDir, f))
        ) ;

        if (!hasAnyFlagFile) {
            continue ;
        }

        const readFlagSet = (name: string, isLink: boolean) : ConfigFlagSet => {
            const dbgFile  = path.join(debugDir,   name) ;
            const relFile  = path.join(releaseDir, name) ;
            const hasDbg   = fs.existsSync(dbgFile) ;
            const hasRel   = fs.existsSync(relFile) ;
            let debugFlags:   string[] = [] ;
            let releaseFlags: string[] = [] ;
            let hasCmse                = false ;
            const allLinkDirs: string[] = [] ;
            if (hasDbg) {
                const r = parseFlags(fs.readFileSync(dbgFile,  'utf-8'), isLink) ;
                debugFlags = r.flags ;
                if (r.hasCmse) hasCmse = true ;
                if (r.linkDirs) allLinkDirs.push(...r.linkDirs) ;
            }
            if (hasRel) {
                const r = parseFlags(fs.readFileSync(relFile, 'utf-8'), isLink) ;
                releaseFlags = r.flags ;
                if (r.hasCmse) hasCmse = true ;
                if (r.linkDirs) allLinkDirs.push(...r.linkDirs) ;
            }
            const linkDirs = [...new Set(allLinkDirs)] ;
            return {
                debug:       debugFlags,
                release:     releaseFlags,
                debugFile:   hasDbg ? dbgFile  : undefined,
                releaseFile: hasRel ? relFile : undefined,
                ...(isLink && { hasCmse }),
                ...(isLink && linkDirs.length > 0 && { linkDirs }),
            } ;
        } ;

        const readLibSet = (name: string) : ConfigFlagSet => {
            const dbgFile  = path.join(debugDir,   name) ;
            const relFile  = path.join(releaseDir, name) ;
            const hasDbg   = fs.existsSync(dbgFile) ;
            const hasRel   = fs.existsSync(relFile) ;
            return {
                debug:       hasDbg ? parseLdLibs(fs.readFileSync(dbgFile,  'utf-8')) : [],
                release:     hasRel ? parseLdLibs(fs.readFileSync(relFile, 'utf-8')) : [],
                debugFile:   hasDbg ? dbgFile  : undefined,
                releaseFile: hasRel ? relFile : undefined,
            } ;
        } ;

        return {
            c:    readFlagSet('.cflags',   false),
            asm:  readFlagSet('.asflags',  false),
            cxx:  readFlagSet('.cxxflags', false),
            link: readFlagSet('.ldflags',  true),
            libs: readLibSet('.ldlibs'),
        } ;
    }

    return emptyFlags() ;
}

//
// Read flag files for a single build configuration (Debug or Release).  The
// flags are stored in the appropriate slot of the returned ProjectFlagsByConfig
// (the other slot is left empty).
//
// Search order for flag files:
//   1. build/<BSPNAME>/<config>/   (standard ModusToolbox layout)
//   2. build/                      (flat layout used by some projects)
//
export function readProjectFlagsForConfig(
    srcProjDir: string,
    config: 'Debug' | 'Release',
) : ProjectFlagsByConfig {
    const fileNames = ['.cflags', '.asflags', '.cxxflags', '.ldflags', '.ldlibs'] ;
    const which = config === 'Debug' ? 'debug' : 'release' ;
    const buildDir = path.join(srcProjDir, 'build') ;

    let flagDir: string | undefined ;
    if (fs.existsSync(buildDir)) {
        // First: look in build/BSPNAME/Config/
        for (const bsp of fs.readdirSync(buildDir, { withFileTypes: true }).filter(e => e.isDirectory())) {
            const candidate = path.join(buildDir, bsp.name, config) ;
            if (fileNames.some(f => fs.existsSync(path.join(candidate, f)))) {
                flagDir = candidate ;
                break ;
            }
        }
        // Fallback: look in build/ directly
        if (!flagDir && fileNames.some(f => fs.existsSync(path.join(buildDir, f)))) {
            flagDir = buildDir ;
        }
    }

    if (!flagDir) {
        return emptyFlags() ;
    }

    const readFlagSet = (name: string, isLink: boolean) : ConfigFlagSet => {
        const filePath = path.join(flagDir!, name) ;
        const hasFile = fs.existsSync(filePath) ;
        let flags: string[] = [] ;
        let hasCmse = false ;
        const allLinkDirs: string[] = [] ;
        if (hasFile) {
            const r = parseFlags(fs.readFileSync(filePath, 'utf-8'), isLink) ;
            flags = r.flags ;
            if (r.hasCmse) hasCmse = true ;
            if (r.linkDirs) allLinkDirs.push(...r.linkDirs) ;
        }
        const linkDirs = [...new Set(allLinkDirs)] ;
        return {
            debug:       which === 'debug'   ? flags : [],
            release:     which === 'release' ? flags : [],
            debugFile:   (which === 'debug'   && hasFile) ? filePath : undefined,
            releaseFile: (which === 'release' && hasFile) ? filePath : undefined,
            ...(isLink && { hasCmse }),
            ...(isLink && linkDirs.length > 0 && { linkDirs }),
        } ;
    } ;

    const readLibSet = (name: string) : ConfigFlagSet => {
        const filePath = path.join(flagDir!, name) ;
        const hasFile = fs.existsSync(filePath) ;
        const libs = hasFile ? parseLdLibs(fs.readFileSync(filePath, 'utf-8')) : [] ;
        return {
            debug:       which === 'debug'   ? libs : [],
            release:     which === 'release' ? libs : [],
            debugFile:   (which === 'debug'   && hasFile) ? filePath : undefined,
            releaseFile: (which === 'release' && hasFile) ? filePath : undefined,
        } ;
    } ;

    return {
        c:    readFlagSet('.cflags',   false),
        asm:  readFlagSet('.asflags',  false),
        cxx:  readFlagSet('.cxxflags', false),
        link: readFlagSet('.ldflags',  true),
        libs: readLibSet('.ldlibs'),
    } ;
}

//
// Merge two ProjectFlagsByConfig values produced by readProjectFlagsForConfig
// (one for Debug, one for Release) into a single combined value.
//
export function mergeProjectFlagsByConfig(
    a: ProjectFlagsByConfig,
    b: ProjectFlagsByConfig,
) : ProjectFlagsByConfig {
    const mergeSet = (x: ConfigFlagSet, y: ConfigFlagSet) : ConfigFlagSet => {
        const hasCmse = (x.hasCmse || y.hasCmse) ? true : undefined ;
        const linkDirs = [...new Set([...(x.linkDirs ?? []), ...(y.linkDirs ?? [])])] ;
        return {
            debug:       x.debug.length   > 0 ? x.debug   : y.debug,
            release:     y.release.length > 0 ? y.release : x.release,
            debugFile:   x.debugFile   ?? y.debugFile,
            releaseFile: y.releaseFile ?? x.releaseFile,
            ...(hasCmse !== undefined && { hasCmse }),
            ...(linkDirs.length > 0 && { linkDirs }),
        } ;
    } ;
    return {
        c:    mergeSet(a.c,    b.c),
        asm:  mergeSet(a.asm,  b.asm),
        cxx:  mergeSet(a.cxx,  b.cxx),
        link: mergeSet(a.link, b.link),
        libs: mergeSet(a.libs, b.libs),
    } ;
}

//
// Split a ConfigFlagSet into flags common to both configs, debug-only, and
// release-only.  When only one config has flags, all flags are returned in
// 'common' so they apply unconditionally.
//
function splitByConfig(flagSet: ConfigFlagSet) : {
    common: string[] ; debugOnly: string[] ; releaseOnly: string[] ;
} {
    const hasBoth = flagSet.debug.length > 0 && flagSet.release.length > 0 ;
    if (!hasBoth) {
        const all = flagSet.debug.length > 0 ? flagSet.debug : flagSet.release ;
        return { common: all, debugOnly: [], releaseOnly: [] } ;
    }
    return {
        common:      flagSet.debug.filter(f => flagSet.release.includes(f)),
        debugOnly:   flagSet.debug.filter(f => !flagSet.release.includes(f)),
        releaseOnly: flagSet.release.filter(f => !flagSet.debug.includes(f)),
    } ;
}

//
// Given an asset name and the depends database, resolve the
// include directories that should be added to this asset's
// target_include_directories.  For each import of the asset,
// find that import in the database and collect its exports.
// The paths are prefixed with the assets base directory.
//
export function resolveIncludeDirs(
    assetName: string,
    dependsDB: DependsEntry[],
    assetsBaseDir: string,
    bspDir?: string
) : ConditionalIncludeDir[] {
    const entry = dependsDB.find(e => e.name === assetName) ;
    if (!entry) {
        return [] ;
    }

    const includeDirs: ConditionalIncludeDir[] = [] ;

    // Add the asset's own export directories as include paths
    if (entry.exports) {
        for (const exp of entry.exports) {
            includeDirs.push({ path: exp, conditions: extractPathConditions(exp) }) ;
        }
    }

    // Add the asset's own include directories
    if (entry.includes) {
        for (const inc of entry.includes) {
            includeDirs.push({ path: inc, conditions: extractPathConditions(inc) }) ;
        }
    }

    for (const imp of entry.imports) {
        if (typeof imp === 'object') {
            // Conditional import: resolve the named dependency's exports
            // and wrap them with the component condition.
            const componentCondition: DirCondition = {
                type: 'component',
                dirName: `COMPONENT_${imp.component}`,
                value: imp.component
            } ;
            const depEntry = dependsDB.find(e => e.name === imp.name) ;
            if (depEntry) {
                for (const exp of depEntry.exports) {
                    const dir = `${assetsBaseDir}/${imp.name}/${exp}` ;
                    const conditions = [componentCondition, ...extractPathConditions(exp)] ;
                    includeDirs.push({ path: dir, conditions }) ;
                }
            }
            continue ;
        }

        if (typeof imp === 'string' && imp.startsWith('***BSP***')) {
            if (bspDir) {
                const suffix = imp.substring('***BSP***'.length) ;
                includeDirs.push({ path: `${bspDir}${suffix}`, conditions: [] }) ;
            }
            continue ;
        }

        if (imp === '***PROJECT***') {
            includeDirs.push({ path: '${PROJECTDIR}', conditions: [] }) ;
            continue ;
        }

        const depEntry = dependsDB.find(e => e.name === imp) ;
        if (depEntry) {
            for (const exp of depEntry.exports) {
                const dir = `${assetsBaseDir}/${imp}/${exp}` ;
                includeDirs.push({ path: dir, conditions: extractPathConditions(exp) }) ;
            }
        }
    }

    return includeDirs ;
}

//
// For a given asset, resolve its exported include directories
// relative to the given base directory.  The returned paths
// respect COMPONENT_*, TARGET_*, CONFIG_*, and TOOLCHAIN_*
// conditions found in the export path segments.
//
export function resolveAssetExports(
    assetName: string,
    dependsDB: DependsEntry[],
    assetsBaseDir: string
) : ConditionalIncludeDir[] {
    const entry = dependsDB.find(e => e.name === assetName) ;
    if (!entry) {
        return [] ;
    }

    const includeDirs: ConditionalIncludeDir[] = [] ;
    for (const exp of entry.exports) {
        const dir = `${assetsBaseDir}/${assetName}/${exp}` ;
        includeDirs.push({ path: dir, conditions: extractPathConditions(exp) }) ;
    }
    return includeDirs ;
}

//
// For a given asset, resolve its internal-only include directories.
// These paths are relative to the asset's own root directory and are
// expressed using ${CMAKE_CURRENT_SOURCE_DIR} so they are valid inside
// the asset's own CMakeLists.txt.  Unlike exports, these are NEVER
// propagated to dependent targets — they are PRIVATE to the OBJECT
// target only.
//
export function resolveAssetInternals(
    assetName: string,
    dependsDB: DependsEntry[]
) : ConditionalIncludeDir[] {
    const entry = dependsDB.find(e => e.name === assetName) ;
    if (!entry || !entry.internal || entry.internal.length === 0) {
        return [] ;
    }

    const includeDirs: ConditionalIncludeDir[] = [] ;
    for (const int of entry.internal) {
        const dir = `\${CMAKE_CURRENT_SOURCE_DIR}/${int}` ;
        includeDirs.push({ path: dir, conditions: extractPathConditions(int) }) ;
    }
    return includeDirs ;
}

//
// A condition derived from a special parent directory name
// (COMPONENT_*, TARGET_*, CONFIG_*, or TOOLCHAIN_*).
//
export interface DirCondition {
    type: 'component' | 'target' | 'config' | 'toolchain' ;
    dirName: string ;
    value: string ;
}

//
// A source file path paired with the conditions required to include it.
//
export interface ConditionalSource {
    relPath: string ;
    conditions: DirCondition[] ;
}

//
// The recognized special directory prefixes and their condition types.
//
const specialPrefixes: ReadonlyArray<{ prefix: string, type: DirCondition['type'] }> = [
    { prefix: 'COMPONENT_', type: 'component' },
    { prefix: 'TARGET_',    type: 'target' },
    { prefix: 'CONFIG_',    type: 'config' },
    { prefix: 'TOOLCHAIN_', type: 'toolchain' },
] ;

//
// An include directory path paired with any conditions derived
// from COMPONENT_*, TARGET_*, CONFIG_*, or TOOLCHAIN_* segments
// in the path.
//
export interface ConditionalIncludeDir {
    path: string ;
    conditions: DirCondition[] ;
}

//
// Scan a directory path for segments that match COMPONENT_*,
// TARGET_*, CONFIG_*, or TOOLCHAIN_* and return the conditions
// they imply.
//
export function extractPathConditions(dirPath: string) : DirCondition[] {
    const conditions: DirCondition[] = [] ;
    const segments = dirPath.split('/') ;
    for (const seg of segments) {
        for (const sp of specialPrefixes) {
            if (seg.startsWith(sp.prefix)) {
                conditions.push({
                    type: sp.type,
                    dirName: seg,
                    value: seg.substring(sp.prefix.length)
                }) ;
                break ;
            }
        }
    }
    return conditions ;
}

//
// The file extensions treated as source files.
//
const sourceExtensions = new Set(['.c', '.s']) ;

//
// The file extensions treated as header files.
//
const headerExtensions = new Set(['.h']) ;

//
// Recursively collect all source files (*.c, *.s) under a directory,
// tracking which COMPONENT_*, TARGET_*, CONFIG_*, and TOOLCHAIN_*
// directories each file is nested under.  Conditions accumulate as
// the tree is descended, so nested special directories produce
// multiple conditions on the same file.
// ignorePaths is an optional list of absolute directory paths whose
// contents should be excluded from the result (sourced from the
// project's MTBProjectInfo.ignorePath()).
//
export function collectSources(
    dir: string,
    baseDir: string,
    conditions: DirCondition[] = [],
    ignorePaths: string[] = []
) : ConditionalSource[] {
    const results: ConditionalSource[] = [] ;
    const entries = fs.readdirSync(dir, { withFileTypes: true }) ;

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name) ;
        const normFull = path.normalize(fullPath) ;

        if (ignorePaths.some(ip => normFull.startsWith(path.normalize(ip)))) {
            continue ;
        }

        if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase() ;
            if (sourceExtensions.has(ext)) {
                const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/') ;
                results.push({ relPath, conditions: [...conditions] }) ;
            }
        } else if (entry.isDirectory()) {
            let newConditions = [...conditions] ;

            for (const sp of specialPrefixes) {
                if (entry.name.startsWith(sp.prefix)) {
                    newConditions.push({
                        type: sp.type,
                        dirName: entry.name,
                        value: entry.name.substring(sp.prefix.length)
                    }) ;
                    break ;
                }
            }

            results.push(...collectSources(fullPath, baseDir, newConditions, ignorePaths)) ;
        }
    }

    return results ;
}

//
// Recursively collect all header files (*.h) under a directory,
// tracking which COMPONENT_*, TARGET_*, CONFIG_*, and TOOLCHAIN_*
// directories each file is nested under.
//
export function collectHeaders(
    dir: string,
    baseDir: string,
    conditions: DirCondition[] = [],
    ignorePaths: string[] = []
) : ConditionalSource[] {
    const results: ConditionalSource[] = [] ;
    const entries = fs.readdirSync(dir, { withFileTypes: true }) ;

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name) ;
        const normFull = path.normalize(fullPath) ;

        if (ignorePaths.some(ip => normFull.startsWith(path.normalize(ip)))) {
            continue ;
        }

        if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase() ;
            if (headerExtensions.has(ext)) {
                const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/') ;
                results.push({ relPath, conditions: [...conditions] }) ;
            }
        } else if (entry.isDirectory()) {
            let newConditions = [...conditions] ;

            for (const sp of specialPrefixes) {
                if (entry.name.startsWith(sp.prefix)) {
                    newConditions.push({
                        type: sp.type,
                        dirName: entry.name,
                        value: entry.name.substring(sp.prefix.length)
                    }) ;
                    break ;
                }
            }

            results.push(...collectHeaders(fullPath, baseDir, newConditions, ignorePaths)) ;
        }
    }

    return results ;
}

//
// Build a grouping key from a set of conditions so files that
// share identical conditions can be emitted together.
//
export function conditionKey(conditions: DirCondition[]) : string {
    return conditions.map(c => `${c.type}:${c.dirName}`).join('|') ;
}

//
// Convert a set of conditions into a CMake if() expression.
// COMPONENT_*, TARGET_*, and CONFIG_* become variable-truthiness checks.
// TOOLCHAIN_* becomes a MTBTOOLCHAIN string comparison.
//
export function conditionToCMake(conditions: DirCondition[]) : string {
    const parts = conditions.map(c => {
        if (c.type === 'toolchain') {
            return `MTBTOOLCHAIN STREQUAL "${c.value}"` ;
        }
        return c.dirName.replace(/-/g, '_') ;
    }) ;
    return parts.join(' AND ') ;
}

//
// Group a flat list of ConditionalSource entries into
// unconditional files and groups of files sharing each
// unique condition set.
//
export function groupSources(sources: ConditionalSource[]) : {
    unconditional: string[] ;
    conditionalGroups: Map<string, { conditions: DirCondition[], files: string[] }> ;
} {
    const unconditional: string[] = [] ;
    const conditionalGroups = new Map<string, { conditions: DirCondition[], files: string[] }>() ;

    for (const src of sources) {
        if (src.conditions.length === 0) {
            unconditional.push(src.relPath) ;
        } else {
            const key = conditionKey(src.conditions) ;
            if (!conditionalGroups.has(key)) {
                conditionalGroups.set(key, { conditions: src.conditions, files: [] }) ;
            }
            conditionalGroups.get(key)!.files.push(src.relPath) ;
        }
    }

    unconditional.sort() ;
    return { unconditional, conditionalGroups } ;
}

//
// Check whether a source file's conditions are satisfied by the
// given set of active components.  A condition is satisfied if:
//   - component type: the component name (COMPONENT_XXX) is in the set
//   - target/config/toolchain types are always considered satisfied
//     (they are resolved at CMake configure time, not here)
//
function conditionsSatisfied(conditions: DirCondition[], components: Set<string>) : boolean {
    for (const c of conditions) {
        if (c.type === 'component') {
            if (!components.has(c.dirName)) {
                return false ;
            }
        }
    }
    return true ;
}

//
// Determine whether a list of conditional sources contains at
// least one source file that would be active given the project's
// component list.  Unconditional sources are always active.
// Sources gated by TARGET_*, CONFIG_*, or TOOLCHAIN_* are
// considered potentially active since those are resolved at
// CMake configure time.
//
export function hasActiveSources(
    sources: ConditionalSource[],
    components: string[]
) : boolean {
    const compSet = new Set(components.map(c => `COMPONENT_${c}`)) ;
    for (const src of sources) {
        if (conditionsSatisfied(src.conditions, compSet)) {
            return true ;
        }
    }
    return false ;
}

//
// Generate a CMakeLists.txt that builds the given sources as a
// project-scoped STATIC library backed by a companion OBJECT
// library. The parent project may override the library name by
// setting MTB5_ASSET_LIBRARY_NAME before add_subdirectory().
//
export function generateObjectLibraryCMakeLists(
    targetDir: string,
    libraryName: string,
    sources: ConditionalSource[],
    includeDirs: ConditionalIncludeDir[] = [],
    internalDirs: ConditionalIncludeDir[] = []
) : void {
    const { unconditional, conditionalGroups } = groupSources(sources) ;

    const lines: string[] = [] ;
    lines.push('cmake_minimum_required(VERSION 3.16)') ;
    lines.push(`project(${libraryName} LANGUAGES C ASM)`) ;
    lines.push('') ;
    // MTB5_ASSET_LIBRARY_NAME is set by the parent project's add_subdirectory
    // wrapper so that multiple projects sharing the same asset directory each
    // get a uniquely-named OBJECT target and avoid CMake target-name collisions.
    lines.push(`if(DEFINED MTB5_ASSET_LIBRARY_NAME)`) ;
    lines.push(`    set(MTB5_ASSET_TARGET \${MTB5_ASSET_LIBRARY_NAME})`) ;
    lines.push('else()') ;
    lines.push(`    set(MTB5_ASSET_TARGET ${libraryName})`) ;
    lines.push('endif()') ;
    lines.push('') ;
    // OBJECT library: object files are linked directly into the executable
    // (no intermediate .a archive).  CMake 3.12+ propagates the PUBLIC
    // interface of an OBJECT library to any target that links against it.
    lines.push('add_library(${MTB5_ASSET_TARGET} OBJECT)') ;

    // Add unconditional sources
    if (unconditional.length > 0) {
        lines.push('') ;
        lines.push('target_sources(${MTB5_ASSET_TARGET} PRIVATE') ;
        for (const f of unconditional) {
            lines.push(`    ${f}`) ;
        }
        lines.push(')') ;
    }

    // Add conditional source groups
    const sortedKeys = [...conditionalGroups.keys()].sort() ;
    for (const key of sortedKeys) {
        const group = conditionalGroups.get(key)! ;
        group.files.sort() ;

        lines.push('') ;
        lines.push(`if(${conditionToCMake(group.conditions)})`) ;
        lines.push('    target_sources(${MTB5_ASSET_TARGET} PRIVATE') ;
        for (const f of group.files) {
            lines.push(`        ${f}`) ;
        }
        lines.push('    )') ;
        lines.push('endif()') ;
    }

    // Public include directories — propagated to every target that links
    // against this OBJECT library (CMake 3.12+ PUBLIC-interface propagation).
    if (includeDirs.length > 0) {
        const unconditionalIncs = includeDirs.filter(d => d.conditions.length === 0) ;
        const conditionalIncs = includeDirs.filter(d => d.conditions.length > 0) ;

        if (unconditionalIncs.length > 0) {
            lines.push('') ;
            lines.push('target_include_directories(${MTB5_ASSET_TARGET} PUBLIC') ;
            for (const d of unconditionalIncs) {
                lines.push(`    ${d.path}`) ;
            }
            lines.push(')') ;
        }

        const incGroups = new Map<string, { conditions: DirCondition[], dirs: string[] }>() ;
        for (const d of conditionalIncs) {
            const key = conditionKey(d.conditions) ;
            if (!incGroups.has(key)) {
                incGroups.set(key, { conditions: d.conditions, dirs: [] }) ;
            }
            incGroups.get(key)!.dirs.push(d.path) ;
        }

        const sortedIncKeys = [...incGroups.keys()].sort() ;
        for (const key of sortedIncKeys) {
            const group = incGroups.get(key)! ;
            lines.push('') ;
            lines.push(`if(${conditionToCMake(group.conditions)})`) ;
            lines.push('    target_include_directories(${MTB5_ASSET_TARGET} PUBLIC') ;
            for (const d of group.dirs) {
                lines.push(`        ${d}`) ;
            }
            lines.push('    )') ;
            lines.push('endif()') ;
        }
    }

    // Internal include directories — PRIVATE to this target only,
    // never propagated to consumers.
    if (internalDirs.length > 0) {
        const unconditionalInt = internalDirs.filter(d => d.conditions.length === 0) ;
        const conditionalInt   = internalDirs.filter(d => d.conditions.length > 0) ;

        if (unconditionalInt.length > 0) {
            lines.push('') ;
            lines.push('target_include_directories(${MTB5_ASSET_TARGET} PRIVATE') ;
            for (const d of unconditionalInt) {
                lines.push(`    ${d.path}`) ;
            }
            lines.push(')') ;
        }

        const intGroups = new Map<string, { conditions: DirCondition[], dirs: string[] }>() ;
        for (const d of conditionalInt) {
            const key = conditionKey(d.conditions) ;
            if (!intGroups.has(key)) {
                intGroups.set(key, { conditions: d.conditions, dirs: [] }) ;
            }
            intGroups.get(key)!.dirs.push(d.path) ;
        }

        const sortedIntKeys = [...intGroups.keys()].sort() ;
        for (const key of sortedIntKeys) {
            const group = intGroups.get(key)! ;
            lines.push('') ;
            lines.push(`if(${conditionToCMake(group.conditions)})`) ;
            lines.push('    target_include_directories(${MTB5_ASSET_TARGET} PRIVATE') ;
            for (const d of group.dirs) {
                lines.push(`        ${d}`) ;
            }
            lines.push('    )') ;
            lines.push('endif()') ;
        }
    }

    lines.push('') ;

    const cmakePath = path.join(targetDir, 'CMakeLists.txt') ;
    fs.writeFileSync(cmakePath, lines.join('\n')) ;
}

//
// Generate a bsp.cmake file designed to be included by a parent
// CMakeLists.txt via include().  Uses ${BSP_TARGET} as the target
// name and ${BSP_DIR} for source file paths so the parent can
// set these before including the file.  Sources are added with
// target_sources and conditional COMPONENT_*, TARGET_*, CONFIG_*,
// and TOOLCHAIN_* rules are honoured.
//
export function generateBspCMakeInclude(
    targetDir: string,
    sources: ConditionalSource[],
    headers: ConditionalSource[] = []
) : void {
    const { unconditional, conditionalGroups } = groupSources(sources) ;

    const lines: string[] = [] ;
    lines.push('#') ;
    lines.push('# BSP source file include - include() this from a parent CMakeLists.txt') ;
    lines.push('# Set BSP_TARGET to the target to add sources to before including.') ;
    lines.push('# Set BSP_DIR to the path of this BSP directory.') ;
    lines.push('#') ;
    lines.push('') ;

    // Unconditional sources
    if (unconditional.length > 0) {
        lines.push('target_sources(${BSP_TARGET} PRIVATE') ;
        for (const f of unconditional) {
            lines.push(`    \${BSP_DIR}/${f}`) ;
        }
        lines.push(')') ;
    }

    // Conditional source groups
    const sortedKeys = [...conditionalGroups.keys()].sort() ;
    for (const key of sortedKeys) {
        const group = conditionalGroups.get(key)! ;
        group.files.sort() ;

        lines.push('') ;
        lines.push(`if(${conditionToCMake(group.conditions)})`) ;
        lines.push('    target_sources(${BSP_TARGET} PRIVATE') ;
        for (const f of group.files) {
            lines.push(`        \${BSP_DIR}/${f}`) ;
        }
        lines.push('    )') ;
        lines.push('endif()') ;
    }

    // Collect include directories from header file locations
    const includeDirMap = new Map<string, DirCondition[]>() ;
    for (const hdr of headers) {
        const dir = path.dirname(hdr.relPath).replace(/\\/g, '/') ;
        const dirKey = dir === '.' ? '' : dir ;
        if (!includeDirMap.has(dirKey)) {
            includeDirMap.set(dirKey, hdr.conditions) ;
        }
    }

    // Group include directories by conditions
    const unconditionalIncDirs: string[] = [] ;
    const conditionalIncGroups = new Map<string, { conditions: DirCondition[], dirs: string[] }>() ;
    for (const [dir, conditions] of includeDirMap) {
        const incPath = dir ? `\${BSP_DIR}/${dir}` : '${BSP_DIR}' ;
        if (conditions.length === 0) {
            unconditionalIncDirs.push(incPath) ;
        } else {
            const key = conditionKey(conditions) ;
            if (!conditionalIncGroups.has(key)) {
                conditionalIncGroups.set(key, { conditions, dirs: [] }) ;
            }
            conditionalIncGroups.get(key)!.dirs.push(incPath) ;
        }
    }

    if (unconditionalIncDirs.length > 0) {
        unconditionalIncDirs.sort() ;
        lines.push('') ;
        lines.push('target_include_directories(${BSP_TARGET} PUBLIC') ;
        for (const d of unconditionalIncDirs) {
            lines.push(`    ${d}`) ;
        }
        lines.push(')') ;
    }

    const sortedIncKeys = [...conditionalIncGroups.keys()].sort() ;
    for (const key of sortedIncKeys) {
        const group = conditionalIncGroups.get(key)! ;
        group.dirs.sort() ;
        lines.push('') ;
        lines.push(`if(${conditionToCMake(group.conditions)})`) ;
        lines.push('    target_include_directories(${BSP_TARGET} PUBLIC') ;
        for (const d of group.dirs) {
            lines.push(`        ${d}`) ;
        }
        lines.push('    )') ;
        lines.push('endif()') ;
    }

    lines.push('') ;

    const cmakePath = path.join(targetDir, 'bsp.cmake') ;
    fs.writeFileSync(cmakePath, lines.join('\n')) ;
}

//
// Generate a CMakeLists.txt that copies header files to the build
// directory so they are available to other build targets.  Uses the
// same conditional inclusion rules for COMPONENT_*, TARGET_*,
// CONFIG_*, and TOOLCHAIN_* directories.
//
export function generateHeaderOnlyCMakeLists(
    targetDir: string,
    libraryName: string,
    headers: ConditionalSource[],
    includeDirs: ConditionalIncludeDir[] = []
) : void {
    const { unconditional, conditionalGroups } = groupSources(headers) ;

    const lines: string[] = [] ;
    lines.push('cmake_minimum_required(VERSION 3.16)') ;
    lines.push(`project(${libraryName})`) ;
    lines.push('') ;
    lines.push(`set(HEADER_DEST \${CMAKE_BINARY_DIR}/include/\${PROJECT_NAME})`) ;
    lines.push('') ;

    // Unconditional headers
    lines.push('set(HEADERS') ;
    for (const f of unconditional) {
        lines.push(`    ${f}`) ;
    }
    lines.push(')') ;

    // Conditional header groups
    const sortedKeys = [...conditionalGroups.keys()].sort() ;
    for (const key of sortedKeys) {
        const group = conditionalGroups.get(key)! ;
        group.files.sort() ;

        lines.push('') ;
        lines.push(`if(${conditionToCMake(group.conditions)})`) ;
        lines.push('    list(APPEND HEADERS') ;
        for (const f of group.files) {
            lines.push(`        ${f}`) ;
        }
        lines.push('    )') ;
        lines.push('endif()') ;
    }

    lines.push('') ;
    lines.push(`add_custom_target(\${PROJECT_NAME}_headers ALL)`) ;
    lines.push('') ;
    lines.push('foreach(HDR ${HEADERS})') ;
    lines.push('    get_filename_component(HDR_DIR ${HDR} DIRECTORY)') ;
    lines.push('    add_custom_command(TARGET ${PROJECT_NAME}_headers POST_BUILD') ;
    lines.push('        COMMAND ${CMAKE_COMMAND} -E make_directory ${HEADER_DEST}/${HDR_DIR}') ;
    lines.push('        COMMAND ${CMAKE_COMMAND} -E copy ${CMAKE_CURRENT_SOURCE_DIR}/${HDR} ${HEADER_DEST}/${HDR_DIR}/') ;
    lines.push('    )') ;
    lines.push('endforeach()') ;

    // Add include directories from dependencies
    if (includeDirs.length > 0) {
        const unconditionalIncs = includeDirs.filter(d => d.conditions.length === 0) ;
        const conditionalIncs = includeDirs.filter(d => d.conditions.length > 0) ;

        if (unconditionalIncs.length > 0) {
            lines.push('') ;
            lines.push(`target_include_directories(\${PROJECT_NAME}_headers PUBLIC`) ;
            for (const d of unconditionalIncs) {
                lines.push(`    ${d.path}`) ;
            }
            lines.push(')') ;
        }

        const incGroups = new Map<string, { conditions: DirCondition[], dirs: string[] }>() ;
        for (const d of conditionalIncs) {
            const key = conditionKey(d.conditions) ;
            if (!incGroups.has(key)) {
                incGroups.set(key, { conditions: d.conditions, dirs: [] }) ;
            }
            incGroups.get(key)!.dirs.push(d.path) ;
        }

        const sortedIncKeys = [...incGroups.keys()].sort() ;
        for (const key of sortedIncKeys) {
            const group = incGroups.get(key)! ;
            lines.push('') ;
            lines.push(`if(${conditionToCMake(group.conditions)})`) ;
            lines.push(`    target_include_directories(\${PROJECT_NAME}_headers PUBLIC`) ;
            for (const d of group.dirs) {
                lines.push(`        ${d}`) ;
            }
            lines.push('    )') ;
            lines.push('endif()') ;
        }
    }

    lines.push('') ;

    const cmakePath = path.join(targetDir, 'CMakeLists.txt') ;
    fs.writeFileSync(cmakePath, lines.join('\n')) ;
}

//
// Information about an asset dependency to include via add_subdirectory.
//
export interface AssetSubdirectory {
    name: string ;
    relativePath: string ;
    targetName: string ;
}

//
// Topologically sort assets so that consumers appear before the assets they
// depend on (correct GCC static-link order).  Only dependency edges between
// assets that are actually present in the `assets` array are considered;
// ***BSP*** / ***PROJECT*** imports and unrecognised names are ignored.
// ComponentImport edges are only followed when the component is active.
//
// If a dependency cycle is detected among the active assets, an error is
// printed to stderr and the process exits with code 1.
//
function sortAssetsByDependency(
    assets: AssetSubdirectory[],
    dependsDB: DependsEntry[],
    activeComponents: string[] = []
) : AssetSubdirectory[] {
    if (assets.length <= 1) {
        return assets ;
    }

    const activeComponentSet = new Set(activeComponents) ;
    const assetNameSet = new Set(assets.map(a => a.name)) ;

    // Build adjacency list: A → Set<B> where A imports B (edge: A must come before B).
    const adjList = new Map<string, Set<string>>() ;
    for (const asset of assets) {
        adjList.set(asset.name, new Set<string>()) ;
    }

    for (const asset of assets) {
        const entry = dependsDB.find(e => e.name === asset.name) ;
        if (!entry) {
            continue ;
        }
        const neighbors = adjList.get(asset.name)! ;
        for (const imp of entry.imports) {
            if (typeof imp === 'object') {
                // ComponentImport: only materialise this edge when the component is active.
                if (activeComponentSet.has(imp.component) && assetNameSet.has(imp.name)) {
                    neighbors.add(imp.name) ;
                }
            } else {
                // Skip ***BSP*** / ***PROJECT*** pseudo-entries.
                if (imp.startsWith('***')) {
                    continue ;
                }
                if (assetNameSet.has(imp)) {
                    neighbors.add(imp) ;
                }
            }
        }
    }

    // Kahn's algorithm — queue seeded in original assets order for stable output.
    const inDegree = new Map<string, number>() ;
    for (const asset of assets) {
        inDegree.set(asset.name, 0) ;
    }
    for (const neighbors of adjList.values()) {
        for (const b of neighbors) {
            inDegree.set(b, (inDegree.get(b) ?? 0) + 1) ;
        }
    }

    const queue: string[] = [] ;
    for (const asset of assets) {
        if (inDegree.get(asset.name) === 0) {
            queue.push(asset.name) ;
        }
    }

    const sortedSet = new Set<string>() ;
    const sorted: string[] = [] ;

    while (sorted.length < assets.length) {
        // When the queue empties but nodes remain, a cycle exists among them.
        // Break it by picking the first unsorted node in original assets order.
        if (queue.length === 0) {
            const cycleNode = assets.find(a => !sortedSet.has(a.name))! ;
            console.warn(`Warning: dependency cycle detected — breaking at '${cycleNode.name}'`) ;
            queue.push(cycleNode.name) ;
        }

        const name = queue.shift()! ;
        if (sortedSet.has(name)) {
            continue ;
        }
        sortedSet.add(name) ;
        sorted.push(name) ;

        // Decrement in-degrees of neighbors; iterate in original assets order for stability.
        const neighbors = adjList.get(name)! ;
        for (const asset of assets) {
            if (neighbors.has(asset.name) && !sortedSet.has(asset.name)) {
                const newDeg = (inDegree.get(asset.name) ?? 0) - 1 ;
                inDegree.set(asset.name, newDeg) ;
                if (newDeg === 0) {
                    queue.push(asset.name) ;
                }
            }
        }
    }

    const nameToAsset = new Map(assets.map(a => [a.name, a])) ;
    return sorted.map(name => nameToAsset.get(name)!) ;
}

//
// Generate a CMakeLists.txt for a project that builds its own sources
// (with COMPONENT_*, TARGET_*, CONFIG_*, TOOLCHAIN_* conditional inclusion)
// and includes each required asset via add_subdirectory.
//
export function generateFirmwareCMake(
    targetDir: string,
    projectName: string,
    assets: AssetSubdirectory[]
) : void {
    const lines: string[] = [] ;
    lines.push('# This file is generated by the MTB5 converter and should not be edited by hand.') ;
    lines.push('# It is regenerated each time the converter is run.') ;
    lines.push('') ;

    if (assets.length > 0) {
        lines.push('set(PROJECTDIR ${CMAKE_CURRENT_SOURCE_DIR})') ;
        lines.push('') ;
        for (const asset of assets) {
            lines.push(`set(MTB5_ASSET_LIBRARY_NAME ${asset.targetName})`) ;
            lines.push(`add_subdirectory(${asset.relativePath} \${CMAKE_BINARY_DIR}/${projectName}/${asset.name})`) ;
            lines.push('unset(MTB5_ASSET_LIBRARY_NAME)') ;
        }
    }

    const firmwarePath = path.join(targetDir, 'firmware.cmake') ;
    fs.writeFileSync(firmwarePath, lines.join('\n')) ;
}

export function generateProjectCMakeLists(
    targetDir: string,
    projectName: string,
    sources: ConditionalSource[],
    assets: AssetSubdirectory[],
    includeDirs: ConditionalIncludeDir[] = [],
    bspName?: string,
    components: string[] = [],
    flagsByToolchain?: ProjectFlagsByToolchain,
    debugDefines: string[] = [],
    releaseDefines: string[] = [],
    dependsDB?: DependsEntry[]
) : void {
    const { unconditional, conditionalGroups } = groupSources(sources) ;

    // Always include CXX so that g++ is available as the linker driver.
    const hasCxx = true ;
    const languages = 'C CXX ASM' ;

    const lines: string[] = [] ;
    lines.push('cmake_minimum_required(VERSION 3.16)') ;
    lines.push(`project(${projectName} LANGUAGES ${languages})`) ;

    // Emit per-toolchain add_compile_options / add_link_options blocks derived
    // from running 'make codegen TOOLCHAIN=<t> CONFIG=<c>' for each combination.
    // Each block is guarded by  if(MTBTOOLCHAIN STREQUAL "<t>")  so that only the
    // flags matching the active toolchain are applied at CMake configure time.
    if (flagsByToolchain && Object.keys(flagsByToolchain).length > 0) {
        const toolchains = Object.keys(flagsByToolchain).sort() ;

        interface ToolchainBlock {
            toolchain: string ;
            compileLines: string[] ;
            linkLines: string[] ;
        }
        const blocks: ToolchainBlock[] = [] ;

        for (const toolchain of toolchains) {
            const fbc = flagsByToolchain[toolchain] ;
            const langDefs: Array<{ lang: string ; flags: ConfigFlagSet }> = [
                { lang: 'C',   flags: fbc.c },
                { lang: 'ASM', flags: fbc.asm },
                { lang: 'CXX', flags: fbc.cxx },
            ] ;
            const compileLines: string[] = [] ;
            for (const { lang, flags } of langDefs) {
                const { common, debugOnly, releaseOnly } = splitByConfig(flags) ;
                for (const f of common) {
                    compileLines.push(`        $<$<COMPILE_LANGUAGE:${lang}>:${f}>`) ;
                }
                for (const f of debugOnly) {
                    compileLines.push(`        $<$<AND:$<COMPILE_LANGUAGE:${lang}>,$<CONFIG:Debug>>:${f}>`) ;
                }
                for (const f of releaseOnly) {
                    compileLines.push(`        $<$<AND:$<COMPILE_LANGUAGE:${lang}>,$<CONFIG:Release>>:${f}>`) ;
                }
            }

            const { common: lc, debugOnly: ld, releaseOnly: lr } = splitByConfig(fbc.link) ;
            const linkLines: string[] = [] ;
            for (const f of lc) linkLines.push(`        ${f}`) ;
            for (const f of ld) linkLines.push(`        $<$<CONFIG:Debug>:${f}>`) ;
            for (const f of lr) linkLines.push(`        $<$<CONFIG:Release>:${f}>`) ;

            if (compileLines.length > 0 || linkLines.length > 0) {
                blocks.push({ toolchain, compileLines, linkLines }) ;
            }
        }

        if (blocks.length > 0) {
            lines.push('') ;
            for (let i = 0; i < blocks.length; i++) {
                const { toolchain, compileLines, linkLines } = blocks[i] ;
                const keyword = i === 0 ? 'if' : 'elseif' ;
                lines.push(`${keyword}(MTBTOOLCHAIN STREQUAL "${toolchain}")`) ;
                if (compileLines.length > 0) {
                    lines.push('    add_compile_options(') ;
                    lines.push(...compileLines) ;
                    lines.push('    )') ;
                }
                if (linkLines.length > 0) {
                    lines.push('    add_link_options(') ;
                    lines.push(...linkLines) ;
                    lines.push('    )') ;
                }
            }
            lines.push('endif()') ;
        }
    }

    lines.push('') ;
    lines.push(`set(APPNAME ${projectName}.elf)`) ;
    lines.push('') ;
    lines.push('if(NOT CMAKE_BUILD_TYPE)') ;
    lines.push('    set(CMAKE_BUILD_TYPE Debug)') ;
    lines.push('endif()') ;
    lines.push('') ;

    // Toolchain names that appear in MTB_COMPONENTS and must be handled dynamically
    // at CMake time (based on MTBTOOLCHAIN) rather than baked in statically.
    const TOOLCHAIN_COMPONENTS = new Set(['GCC_ARM', 'IAR', 'LLVM_ARM', 'ARM']) ;

    // Set component defines (normalise dashes to underscores for valid CMake identifiers;
    // skip toolchain components which are handled separately below).
    if (components.length > 0) {
        const sorted = [...components]
            .filter(c => !TOOLCHAIN_COMPONENTS.has(c))
            .sort() ;
        if (sorted.length > 0) {
            for (const comp of sorted) {
                lines.push(`set(COMPONENT_${comp.replace(/-/g, '_')} 1)`) ;
            }
            lines.push('') ;
            lines.push('add_compile_definitions(') ;
            for (const comp of sorted) {
                lines.push(`    COMPONENT_${comp.replace(/-/g, '_')}`) ;
            }
            lines.push(')') ;
            lines.push('') ;
        }
    }

    // Toolchain component: set COMPONENT_<MTBTOOLCHAIN> at CMake configure time
    // so the correct toolchain-specific source directories are selected.
    lines.push('set(COMPONENT_${MTBTOOLCHAIN} 1)') ;
    lines.push('add_compile_definitions(COMPONENT_${MTBTOOLCHAIN})') ;
    lines.push('') ;

    // Add project-specific defines (from Debug/Release .defines files) using
    // add_compile_definitions so they propagate to child directories.
    // Generator expressions select the correct set for each build configuration.
    const commonDefines      = debugDefines.filter(d => releaseDefines.includes(d)) ;
    const debugOnlyDefines   = debugDefines.filter(d => !releaseDefines.includes(d)) ;
    const releaseOnlyDefines = releaseDefines.filter(d => !debugDefines.includes(d)) ;

    const hasConfigDefines =
        commonDefines.length > 0 || debugOnlyDefines.length > 0 || releaseOnlyDefines.length > 0 ;

    if (hasConfigDefines) {
        lines.push('add_compile_definitions(') ;
        for (const def of commonDefines) {
            lines.push(`    ${def}`) ;
        }
        for (const def of debugOnlyDefines) {
            lines.push(`    $<$<CONFIG:Debug>:${def}>`) ;
        }
        for (const def of releaseOnlyDefines) {
            lines.push(`    $<$<CONFIG:Release>:${def}>`) ;
        }
        lines.push(')') ;
        lines.push('') ;
    }

    // Set BSP_DIR— can be overridden from the command line:
    //   cmake -DBSP_DIR=/path/to/bsp ...
    if (bspName) {
        lines.push('if(NOT DEFINED BSP_DIR)') ;
        lines.push(`    set(BSP_DIR \${CMAKE_CURRENT_SOURCE_DIR}/../bsps/${bspName})`) ;
        lines.push('endif()') ;
        lines.push('') ;
    }

    // Include asset subdirectories via generated firmware.cmake.
    // PROJECTDIR exposes this project's source directory to assets that declare
    // ***PROJECT*** in their imports (e.g. mtb-srf picks up the project's
    // application-level headers such as FreeRTOSConfig.h).
    generateFirmwareCMake(targetDir, projectName, assets) ;
    lines.push('include(${CMAKE_CURRENT_SOURCE_DIR}/firmware.cmake)') ;
    lines.push('')

    // Build the executable with unconditional sources
    if (unconditional.length > 0) {
        lines.push('add_executable(${APPNAME}') ;
        for (const f of unconditional) {
            lines.push(`    ${f}`) ;
        }
        lines.push(')') ;
    } else {
        lines.push('add_executable(${APPNAME})') ;
    }
    // Use g++ (the C++ compiler driver) for linking so that C++ runtime
    // start-up libraries are included automatically.
    lines.push('set_target_properties(${APPNAME} PROPERTIES LINKER_LANGUAGE CXX)') ;

    // GCC_ARM entry drives GCC-specific constructs: link search dirs, CMSE veneer,
    // and additional link inputs (.ldlibs).  These are inherently GCC linker concepts.
    const gccFlags = flagsByToolchain?.['GCC_ARM'] ;

    // Link search directories extracted from -L / -Xlinker -L flags in .ldflags.
    const linkDirs = gccFlags?.link.linkDirs ?? [] ;
    if (linkDirs.length > 0) {
        lines.push('') ;
        lines.push('target_link_directories(${APPNAME} PRIVATE') ;
        for (const dir of linkDirs) {
            lines.push(`    ${dir}`) ;
        }
        lines.push(')') ;
    }

    // CMSE TrustZone NSC veneer generation (secure project only).
    // The link step writes a fresh veneer to a .tmp file; the custom command
    // promotes it to the canonical path only when it has changed, avoiding
    // spurious downstream rebuilds.
    if (gccFlags?.link.hasCmse) {
        lines.push('') ;
        lines.push('set(NSC_VENEER_TMP  ${CMAKE_CURRENT_BINARY_DIR}/nsc_veneer.o.tmp)') ;
        lines.push('set(NSC_VENEER_PATH ${CMAKE_CURRENT_BINARY_DIR}/nsc_veneer.o)') ;
        lines.push('') ;
        // CMSE veneer link flags (-Wl,--cmse-implib / -Wl,--out-implib) use
        // GCC linker syntax; only emit them for the GCC toolchain.
        lines.push('if(MTBTOOLCHAIN STREQUAL "GCC_ARM")') ;
        lines.push('    target_link_options(${APPNAME} PRIVATE') ;
        lines.push('        -Wl,--cmse-implib') ;
        lines.push('        -Wl,--out-implib=${NSC_VENEER_TMP}') ;
        lines.push('    )') ;
        lines.push('endif()') ;
        lines.push('') ;
        lines.push('add_custom_command(') ;
        lines.push('    OUTPUT ${NSC_VENEER_PATH}') ;
        lines.push('    COMMAND ${CMAKE_COMMAND} -E copy_if_different ${NSC_VENEER_TMP} ${NSC_VENEER_PATH}') ;
        lines.push('    DEPENDS $<TARGET_FILE:${APPNAME}>') ;
        lines.push('    COMMENT "Updating NSC veneer import library"') ;
        lines.push('    VERBATIM') ;
        lines.push(')') ;
        lines.push('add_custom_target(${APPNAME}_veneer ALL DEPENDS ${NSC_VENEER_PATH})') ;
    }

    // Link against inputs from .ldlibs (e.g. CMSE veneer from the secure project).
    // These are GCC-specific object/archive paths; derive from the GCC_ARM entry.
    const libsEntries = [
        ...new Set([
            ...(gccFlags?.libs.debug ?? []),
            ...(gccFlags?.libs.release ?? []),
        ])
    ].filter(e => e.length > 0) ;

    // Link asset libraries (dependency-sorted)
    const linkedAssets = dependsDB
        ? sortAssetsByDependency(assets, dependsDB, components)
        : assets ;

    // Wrap all object files and libraries in --start-group / --end-group so
    // that circular references between object files and libraries are resolved
    // correctly by the GCC linker.  These linker directives are GCC-specific,
    // so they are only emitted for the GCC toolchain.  --start-group goes into
    // target_link_options (which the GCC link rule places before the object
    // files) and --end-group is appended via a second target_link_libraries
    // call so it ends up after all libraries on the link line.
    lines.push('') ;
    lines.push('if(MTBTOOLCHAIN STREQUAL "GCC_ARM")') ;
    lines.push('    target_link_options(${APPNAME} PRIVATE -Wl,--start-group)') ;
    lines.push('endif()') ;
    lines.push('') ;
    lines.push('target_link_libraries(${APPNAME} PRIVATE') ;
    for (const lib of libsEntries) {
        lines.push(`    ${lib}`) ;
    }
    for (const asset of linkedAssets) {
        lines.push(`    ${asset.targetName}`) ;
    }
    lines.push(')') ;
    lines.push('') ;
    lines.push('if(MTBTOOLCHAIN STREQUAL "GCC_ARM")') ;
    lines.push('    target_link_libraries(${APPNAME} PRIVATE -Wl,--end-group)') ;
    lines.push('endif()') ;

    // Include BSP sources
    if (bspName) {
        lines.push('') ;
        lines.push('set(BSP_TARGET ${APPNAME})') ;
        lines.push('include(${BSP_DIR}/bsp.cmake)') ;
    }

    // Add conditional source groups
    const sortedKeys = [...conditionalGroups.keys()].sort() ;
    for (const key of sortedKeys) {
        const group = conditionalGroups.get(key)! ;
        group.files.sort() ;

        lines.push('') ;
        lines.push(`if(${conditionToCMake(group.conditions)})`) ;
        lines.push('    target_sources(${APPNAME} PRIVATE') ;
        for (const f of group.files) {
            lines.push(`        ${f}`) ;
        }
        lines.push('    )') ;
        lines.push('endif()') ;
    }

    // Add include directories from asset exports
    if (includeDirs.length > 0) {
        const unconditionalIncs = includeDirs.filter(d => d.conditions.length === 0) ;
        const conditionalIncs = includeDirs.filter(d => d.conditions.length > 0) ;

        if (unconditionalIncs.length > 0) {
            lines.push('') ;
            lines.push('target_include_directories(${APPNAME} PUBLIC') ;
            for (const d of unconditionalIncs) {
                lines.push(`    ${d.path}`) ;
            }
            lines.push(')') ;
        }

        const incGroups = new Map<string, { conditions: DirCondition[], dirs: string[] }>() ;
        for (const d of conditionalIncs) {
            const key = conditionKey(d.conditions) ;
            if (!incGroups.has(key)) {
                incGroups.set(key, { conditions: d.conditions, dirs: [] }) ;
            }
            incGroups.get(key)!.dirs.push(d.path) ;
        }

        const sortedIncKeys = [...incGroups.keys()].sort() ;
        for (const key of sortedIncKeys) {
            const group = incGroups.get(key)! ;
            lines.push('') ;
            lines.push(`if(${conditionToCMake(group.conditions)})`) ;
            lines.push('    target_include_directories(${APPNAME} PUBLIC') ;
            for (const d of group.dirs) {
                lines.push(`        ${d}`) ;
            }
            lines.push('    )') ;
            lines.push('endif()') ;
        }
    }

    // Linker map file output in the build directory (GCC syntax only).
    lines.push('') ;
    lines.push('if(MTBTOOLCHAIN STREQUAL "GCC_ARM")') ;
    lines.push('    target_link_options(${APPNAME} PRIVATE') ;
    lines.push(`        -Wl,-Map=\${CMAKE_BINARY_DIR}/${projectName}.map`) ;
    lines.push('    )') ;
    lines.push('endif()') ;

    // Post-build: convert the ELF to an Intel HEX file in the top-level build dir.
    // IAR's ielftool uses "--ihex <input> <output>" while GCC/LLVM/ARM objcopy uses "-O ihex <input> <output>".
    lines.push('') ;
    lines.push('if(MTBTOOLCHAIN STREQUAL "IAR")') ;
    lines.push('    add_custom_command(TARGET ${APPNAME} POST_BUILD') ;
    lines.push(`        COMMAND \${CMAKE_OBJCOPY} --ihex \$<TARGET_FILE:\${APPNAME}> \${CMAKE_BINARY_DIR}/${projectName}.hex`) ;
    lines.push('        COMMENT "Generating HEX file"') ;
    lines.push('        VERBATIM') ;
    lines.push('    )') ;
    lines.push('else()') ;
    lines.push('    add_custom_command(TARGET ${APPNAME} POST_BUILD') ;
    lines.push(`        COMMAND \${CMAKE_OBJCOPY} -O ihex \$<TARGET_FILE:\${APPNAME}> \${CMAKE_BINARY_DIR}/${projectName}.hex`) ;
    lines.push('        COMMENT "Generating HEX file"') ;
    lines.push('        VERBATIM') ;
    lines.push('    )') ;
    lines.push('endif()') ;
    lines.push('') ;

    const cmakePath = path.join(targetDir, 'CMakeLists.txt') ;
    fs.writeFileSync(cmakePath, lines.join('\n')) ;
}

//
// Describes a single "file" reference extracted from a sign-combine JSON,
// symbolised as {{SYMBOL_NAME}}.
//
export interface SignCombineFileSymbol {
    symbolName: string ;     // CMake variable / EPT symbol, e.g. "PROJ_CM33_S_HEX"
    basename: string ;       // original filename, e.g. "proj_cm33_s.hex"
    isTerminalOutput: boolean ; // true when the file appears only in outputs[], never inputs[]
}

//
// Aggregated result of processSignCombineJson().
//
export interface SignCombineInfo {
    destJsonRelPath: string ;          // path relative to destDir, e.g. "configs/boot_with_extended_boot_symbolic.json"
    symbols: SignCombineFileSymbol[] ;
    outputSymbolName: string ;         // name of the terminal-output symbol used as add_custom_command OUTPUT
}

//
// Recursively collect all "file" key values from an EPT config JSON object,
// tracking which appear under "inputs" vs "outputs" arrays.
//
function collectFileValues(
    obj: unknown,
    inInputs: boolean,
    inputFiles: Map<string, number>,  // filePath → insertion order
    outputFiles: Map<string, number>
) : void {
    if (Array.isArray(obj)) {
        for (const item of obj) {
            collectFileValues(item, inInputs, inputFiles, outputFiles) ;
        }
    } else if (obj && typeof obj === 'object') {
        for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
            if (key === 'inputs' && Array.isArray(value)) {
                collectFileValues(value, true, inputFiles, outputFiles) ;
            } else if (key === 'outputs' && Array.isArray(value)) {
                collectFileValues(value, false, inputFiles, outputFiles) ;
            } else if (key === 'file' && typeof value === 'string') {
                const counter = inInputs ? inputFiles : outputFiles ;
                if (!counter.has(value)) {
                    counter.set(value, inputFiles.size + outputFiles.size) ;
                }
            } else {
                collectFileValues(value, inInputs, inputFiles, outputFiles) ;
            }
        }
    }
}

//
// Deep-clone a JSON value, replacing every "file" key whose value appears in
// symbolMap with the corresponding {{SYMBOL_NAME}} placeholder.
//
function symbolizeJson(obj: unknown, symbolMap: Map<string, string>) : unknown {
    if (Array.isArray(obj)) {
        return obj.map(item => symbolizeJson(item, symbolMap)) ;
    } else if (obj && typeof obj === 'object') {
        const result: Record<string, unknown> = {} ;
        for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
            if (key === 'file' && typeof value === 'string' && symbolMap.has(value)) {
                result[key] = `{{${symbolMap.get(value)}}}` ;
            } else {
                result[key] = symbolizeJson(value, symbolMap) ;
            }
        }
        return result ;
    }
    return obj ;
}

//
// Derive a valid CMake identifier from a filename.
// e.g. "proj_cm33_s.hex" → "PROJ_CM33_S_HEX"
//
function filenameToSymbol(filename: string) : string {
    return filename.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/, '') ;
}

//
// Read srcJsonPath, replace all "file" values with {{SYMBOL}} placeholders,
// write the symbolised JSON to <destDir>/configs/<stem>_symbolic.json, and
// return metadata used when generating the top-level CMakeLists.txt.
//
// setOverrides maps symbol names to override values; when present, the
// generated cmake set() uses that value instead of ${CMAKE_BINARY_DIR}/<basename>.
//
export function processSignCombineJson(
    srcJsonPath: string,
    destDir: string,
    setOverrides: Map<string, string> = new Map()
) : SignCombineInfo {
    const raw = fs.readFileSync(srcJsonPath, 'utf-8') ;
    const json = JSON.parse(raw) ;

    const inputFiles  = new Map<string, number>() ;
    const outputFiles = new Map<string, number>() ;
    collectFileValues(json, false, inputFiles, outputFiles) ;

    // Build insertion-ordered list of all unique file paths
    const allFiles = new Map<string, { order: number; inInput: boolean; inOutput: boolean }>() ;
    for (const [fp, order] of inputFiles) {
        allFiles.set(fp, { order, inInput: true, inOutput: false }) ;
    }
    for (const [fp, order] of outputFiles) {
        if (allFiles.has(fp)) {
            allFiles.get(fp)!.inOutput = true ;
        } else {
            allFiles.set(fp, { order, inInput: false, inOutput: true }) ;
        }
    }

    // Assign symbol names in order of first appearance
    const symbolMap = new Map<string, string>() ; // filePath → symbolName
    const usedSymbols = new Set<string>() ;
    const sortedFiles = [...allFiles.entries()].sort((a, b) => a[1].order - b[1].order) ;

    for (const [fp] of sortedFiles) {
        const base = path.basename(fp) ;
        let sym = filenameToSymbol(base) ;
        if (usedSymbols.has(sym)) {
            let counter = 2 ;
            while (usedSymbols.has(`${sym}_${counter}`)) { counter++ ; }
            sym = `${sym}_${counter}` ;
        }
        symbolMap.set(fp, sym) ;
        usedSymbols.add(sym) ;
    }

    const symbolized = symbolizeJson(json, symbolMap) ;

    const stem = path.basename(srcJsonPath, path.extname(srcJsonPath)) ;
    const destConfigsDir = path.join(destDir, 'configs') ;
    fs.mkdirSync(destConfigsDir, { recursive: true }) ;
    const destFilename = `${stem}_symbolic.json` ;
    fs.writeFileSync(path.join(destConfigsDir, destFilename), JSON.stringify(symbolized, null, 4)) ;

    // Build symbol descriptors
    const symbols: SignCombineFileSymbol[] = sortedFiles.map(([fp, info]) => ({
        symbolName: symbolMap.get(fp)!,
        basename: path.basename(fp),
        isTerminalOutput: info.inOutput && !info.inInput,
    })) ;

    // Pick the output symbol: prefer terminal output; otherwise last symbol
    const terminalOutputs = symbols.filter(s => s.isTerminalOutput) ;
    const outputSymbol = terminalOutputs.length > 0
        ? terminalOutputs[terminalOutputs.length - 1]
        : symbols[symbols.length - 1] ;

    return {
        destJsonRelPath: `configs/${destFilename}`,
        symbols,
        outputSymbolName: outputSymbol.symbolName,
    } ;
}

//
// Generate a top-level CMakeLists.txt that includes each project via
// add_subdirectory().  When a paired secure/non-secure project set is
// detected (names ending in _s / _ns), the _s project is ordered first
// and an add_dependencies() call ensures the _ns target is not built
// until the _s target is complete.
//
export function generateTopLevelCMakeLists(
    destDir: string,
    projectNames: string[],
    bspName?: string,
    signCombineInfo?: SignCombineInfo,
    setOverrides: Map<string, string> = new Map()
) : void {
    const lines: string[] = [] ;
    lines.push('cmake_minimum_required(VERSION 3.16)') ;
    lines.push(`project(${path.basename(destDir)})`) ;
    lines.push('') ;
    lines.push('if(NOT DEFINED MTBTOOLCHAIN)') ;
    lines.push('    set(MTBTOOLCHAIN "GCC_ARM")') ;
    lines.push('endif()') ;
    lines.push('') ;

    // Sort so _s (secure) projects are added before their _ns counterparts
    const sorted = [...projectNames].sort((a, b) => {
        const aSecure = a.endsWith('_s') ;
        const bSecure = b.endsWith('_s') ;
        if (aSecure && !bSecure) return -1 ;
        if (!aSecure && bSecure) return 1 ;
        return a.localeCompare(b) ;
    }) ;

    for (const proj of sorted) {
        lines.push(`add_subdirectory(${proj})`) ;
    }

    // For each _ns project that has a matching _s project, declare the
    // build-order dependency so CMake builds _s before _ns.
    const secureNsPairs: Array<{ ns: string; s: string }> = [] ;
    for (const proj of sorted) {
        if (proj.endsWith('_ns')) {
            const sName = proj.slice(0, -3) + '_s' ;
            if (sorted.includes(sName)) {
                secureNsPairs.push({ ns: proj, s: sName }) ;
            }
        }
    }

    if (secureNsPairs.length > 0) {
        lines.push('') ;
        for (const pair of secureNsPairs) {
            // When the secure project generates an NSC veneer, depend on its
            // _veneer custom target so the veneer file is ready before the
            // non-secure project links.  Fall back to the ELF target itself
            // for non-CMSE secure projects.
            lines.push(`if(TARGET ${pair.s}.elf_veneer)`) ;
            lines.push(`    add_dependencies(${pair.ns}.elf ${pair.s}.elf_veneer)`) ;
            lines.push('else()') ;
            lines.push(`    add_dependencies(${pair.ns}.elf ${pair.s}.elf)`) ;
            lines.push('endif()') ;
        }
    }

    lines.push('') ;

    if (bspName && signCombineInfo) {
        // --- EPT sign-combine section ---
        lines.push('find_program(EPT edgeprotecttools.exe)') ;
        lines.push('if ("${EPT}" STREQUAL "EPT-NOTFOUND")') ;
        lines.push('    message(FATAL_ERROR "Could not find program edgeprotecttools")') ;
        lines.push('endif()') ;
        lines.push('message(STATUS "Found edgeprotecttools: ${EPT}")') ;
        lines.push(`set(BSPPATH \${CMAKE_SOURCE_DIR}/bsps/${bspName})`) ;

        for (const sym of signCombineInfo.symbols) {
            const value = setOverrides.has(sym.symbolName)
                ? setOverrides.get(sym.symbolName)!
                : `\${CMAKE_BINARY_DIR}/${sym.basename}` ;
            lines.push(`set(${sym.symbolName} ${value})`) ;
        }

        lines.push('') ;
        const outputVar = `\${${signCombineInfo.outputSymbolName}}` ;
        const setArgs = signCombineInfo.symbols
            .map(s => `--set ${s.symbolName} \${${s.symbolName}}`)
            .join(' ') ;
        lines.push('add_custom_command(') ;
        lines.push(`    OUTPUT ${outputVar}`) ;
        lines.push(`    COMMAND \${EPT} run-config -i \${CMAKE_SOURCE_DIR}/${signCombineInfo.destJsonRelPath} --symbol-search \${BSPPATH} ${setArgs}`) ;
        lines.push('    COMMENT "Combining and signing to create single output file"') ;
        lines.push('    VERBATIM') ;
        lines.push(')') ;
        lines.push('') ;
        lines.push('add_custom_target(') ;
        lines.push('    SignCombine ALL') ;
        lines.push(`    DEPENDS ${outputVar}`) ;
        lines.push(')') ;
        const elfDeps = sorted.map(p => `${p}.elf`).join(' ') ;
        lines.push(`add_dependencies(SignCombine ${elfDeps})`) ;
        lines.push('') ;
    }

    const cmakePath = path.join(destDir, 'CMakeLists.txt') ;
    fs.writeFileSync(cmakePath, lines.join('\n')) ;
}

//
// Generate a toolchain.cmake for cross-compiling with
// arm-none-eabi-gcc targeting ARM Cortex-M.  The compiler
// is assumed to be available on the system PATH.
//
export function generateGccToolchainCMake(destDir: string) : void {
    const lines: string[] = [] ;
    lines.push('# Cross-compilation toolchain for ARM Cortex-M using GCC') ;
    lines.push('#') ;
    lines.push('# Usage:') ;
    lines.push('#   cmake -DCMAKE_TOOLCHAIN_FILE=toolchains/gcc.cmake ..') ;
    lines.push('#') ;
    lines.push('') ;
    lines.push('set(MTBTOOLCHAIN "GCC_ARM" CACHE STRING "ModusToolbox toolchain identifier")') ;
    lines.push('') ;
    lines.push('set(CMAKE_SYSTEM_NAME Generic)') ;
    lines.push('set(CMAKE_SYSTEM_PROCESSOR arm)') ;
    lines.push('') ;
    lines.push('set(CMAKE_C_COMPILER arm-none-eabi-gcc)') ;
    lines.push('set(CMAKE_CXX_COMPILER arm-none-eabi-g++)') ;
    lines.push('set(CMAKE_ASM_COMPILER arm-none-eabi-gcc)') ;
    lines.push('') ;
    lines.push('set(CMAKE_OBJCOPY arm-none-eabi-objcopy)') ;
    lines.push('set(CMAKE_OBJDUMP arm-none-eabi-objdump)') ;
    lines.push('set(CMAKE_SIZE arm-none-eabi-size)') ;
    lines.push('') ;
    lines.push('# Skip compiler tests for cross-compilation') ;
    lines.push('set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)') ;
    lines.push('') ;
    lines.push('# Cortex-M common flags') ;
    lines.push('set(CMAKE_C_FLAGS_INIT "-mthumb")') ;
    lines.push('set(CMAKE_CXX_FLAGS_INIT "-mthumb")') ;
    lines.push('set(CMAKE_ASM_FLAGS_INIT "-mthumb")') ;
    lines.push('') ;
    lines.push('# Cross-compilation search path settings') ;
    lines.push('set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)') ;
    lines.push('set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)') ;
    lines.push('set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)') ;
    lines.push('set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)') ;
    lines.push('') ;

    const toolchainsDir = path.join(destDir, 'toolchains') ;
    fs.mkdirSync(toolchainsDir, { recursive: true }) ;
    const cmakePath = path.join(toolchainsDir, 'gcc.cmake') ;
    fs.writeFileSync(cmakePath, lines.join('\n')) ;
}

export function generateIarToolchainCMake(destDir: string) : void {
    const lines: string[] = [] ;
    lines.push('# Cross-compilation toolchain for ARM Cortex-M using IAR') ;
    lines.push('#') ;
    lines.push('# Usage:') ;
    lines.push('#   cmake -DCMAKE_TOOLCHAIN_FILE=toolchains/iar.cmake ..') ;
    lines.push('#') ;
    lines.push('') ;
    lines.push('set(MTBTOOLCHAIN "IAR" CACHE STRING "ModusToolbox toolchain identifier")') ;
    lines.push('') ;
    lines.push('set(CMAKE_SYSTEM_NAME Generic)') ;
    lines.push('set(CMAKE_SYSTEM_PROCESSOR arm)') ;
    lines.push('') ;
    lines.push('set(CMAKE_C_COMPILER iccarm)') ;
    lines.push('set(CMAKE_CXX_COMPILER iccarm)') ;
    lines.push('set(CMAKE_ASM_COMPILER iasmarm)') ;
    lines.push('') ;
    lines.push('set(CMAKE_OBJCOPY ielftool)') ;
    lines.push('set(CMAKE_OBJDUMP iobjmanip)') ;
    lines.push('set(CMAKE_SIZE isize)') ;
    lines.push('') ;
    lines.push('# Skip compiler tests for cross-compilation') ;
    lines.push('set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)') ;
    lines.push('') ;
    lines.push('# Cross-compilation search path settings') ;
    lines.push('set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)') ;
    lines.push('set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)') ;
    lines.push('set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)') ;
    lines.push('set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)') ;
    lines.push('') ;

    const toolchainsDir = path.join(destDir, 'toolchains') ;
    fs.mkdirSync(toolchainsDir, { recursive: true }) ;
    const cmakePath = path.join(toolchainsDir, 'iar.cmake') ;
    fs.writeFileSync(cmakePath, lines.join('\n')) ;
}

export function generateLlvmToolchainCMake(destDir: string) : void {
    const lines: string[] = [] ;
    lines.push('# Cross-compilation toolchain for ARM Cortex-M using LLVM/Clang') ;
    lines.push('#') ;
    lines.push('# Usage:') ;
    lines.push('#   cmake -DCMAKE_TOOLCHAIN_FILE=toolchains/llvm.cmake ..') ;
    lines.push('#') ;
    lines.push('') ;
    lines.push('set(MTBTOOLCHAIN "LLVM_ARM" CACHE STRING "ModusToolbox toolchain identifier")') ;
    lines.push('') ;
    lines.push('set(CMAKE_SYSTEM_NAME Generic)') ;
    lines.push('set(CMAKE_SYSTEM_PROCESSOR arm)') ;
    lines.push('') ;
    lines.push('set(CMAKE_C_COMPILER clang)') ;
    lines.push('set(CMAKE_CXX_COMPILER clang++)') ;
    lines.push('set(CMAKE_ASM_COMPILER clang)') ;
    lines.push('') ;
    lines.push('set(CMAKE_OBJCOPY llvm-objcopy)') ;
    lines.push('set(CMAKE_OBJDUMP llvm-objdump)') ;
    lines.push('set(CMAKE_SIZE llvm-size)') ;
    lines.push('') ;
    lines.push('# Skip compiler tests for cross-compilation') ;
    lines.push('set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)') ;
    lines.push('') ;
    lines.push('# Cortex-M common flags') ;
    lines.push('set(CMAKE_C_FLAGS_INIT "-mthumb")') ;
    lines.push('set(CMAKE_CXX_FLAGS_INIT "-mthumb")') ;
    lines.push('set(CMAKE_ASM_FLAGS_INIT "-mthumb")') ;
    lines.push('') ;
    lines.push('# Cross-compilation search path settings') ;
    lines.push('set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)') ;
    lines.push('set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)') ;
    lines.push('set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)') ;
    lines.push('set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)') ;
    lines.push('') ;

    const toolchainsDir = path.join(destDir, 'toolchains') ;
    fs.mkdirSync(toolchainsDir, { recursive: true }) ;
    const cmakePath = path.join(toolchainsDir, 'llvm.cmake') ;
    fs.writeFileSync(cmakePath, lines.join('\n')) ;
}

export function generateArmToolchainCMake(destDir: string) : void {
    const lines: string[] = [] ;
    lines.push('# Cross-compilation toolchain for ARM Cortex-M using Arm Compiler 6') ;
    lines.push('#') ;
    lines.push('# Usage:') ;
    lines.push('#   cmake -DCMAKE_TOOLCHAIN_FILE=toolchains/arm.cmake ..') ;
    lines.push('#') ;
    lines.push('') ;
    lines.push('set(MTBTOOLCHAIN "ARM" CACHE STRING "ModusToolbox toolchain identifier")') ;
    lines.push('') ;
    lines.push('set(CMAKE_SYSTEM_NAME Generic)') ;
    lines.push('set(CMAKE_SYSTEM_PROCESSOR arm)') ;
    lines.push('') ;
    lines.push('set(CMAKE_C_COMPILER armclang)') ;
    lines.push('set(CMAKE_CXX_COMPILER armclang)') ;
    lines.push('set(CMAKE_ASM_COMPILER armclang)') ;
    lines.push('') ;
    lines.push('set(CMAKE_OBJCOPY fromelf)') ;
    lines.push('set(CMAKE_OBJDUMP fromelf)') ;
    lines.push('set(CMAKE_SIZE fromelf)') ;
    lines.push('') ;
    lines.push('# Skip compiler tests for cross-compilation') ;
    lines.push('set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)') ;
    lines.push('') ;
    lines.push('# Cortex-M common flags (armclang requires --target for cross compilation)') ;
    lines.push('set(CMAKE_C_FLAGS_INIT "--target=arm-arm-none-eabi -mthumb")') ;
    lines.push('set(CMAKE_CXX_FLAGS_INIT "--target=arm-arm-none-eabi -mthumb")') ;
    lines.push('set(CMAKE_ASM_FLAGS_INIT "--target=arm-arm-none-eabi -mthumb")') ;
    lines.push('') ;
    lines.push('# Cross-compilation search path settings') ;
    lines.push('set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)') ;
    lines.push('set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)') ;
    lines.push('set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)') ;
    lines.push('set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)') ;
    lines.push('') ;

    const toolchainsDir = path.join(destDir, 'toolchains') ;
    fs.mkdirSync(toolchainsDir, { recursive: true }) ;
    const cmakePath = path.join(toolchainsDir, 'arm.cmake') ;
    fs.writeFileSync(cmakePath, lines.join('\n')) ;
}
