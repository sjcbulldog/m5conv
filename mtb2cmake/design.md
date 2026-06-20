# mtb5conv — Design Document

## What Is This Program?

`mtb5conv` is a command-line tool that converts a **ModusToolbox 3.x application** from its
native Make-based build system into a self-contained **CMake** project tree. The output can
be handed directly to any CMake-aware IDE or CI pipeline without requiring ModusToolbox's
`make` infrastructure to be installed on the build machine.

The tool performs three main activities:

1. **Reads** the ModusToolbox application metadata (app info, project info, asset manifests)
   from the source directory.
2. **Copies** the BSP directories, middleware asset directories, and application project
   directories to a new destination tree, stripping Make-specific artefacts (e.g. `Makefile`).
3. **Generates** a full hierarchy of `CMakeLists.txt` and `.cmake` files that reproduce the
   build semantics of the original Make build for four toolchains (GCC, IAR, LLVM/Clang, ARM
   Compiler 6) and two configurations (Debug / Release).

---

## How Is It Used?

### Prerequisites

* Node.js (runs the compiled TypeScript)
* A ModusToolbox 3.x installation (needed only to run `make codegen` during conversion)
* A previously-created ModusToolbox application in a source directory

### Build

```
npm run build       # compiles TypeScript → dist/
```

### Run

```
node dist/index.js --source <mtb-app-dir> --dest <output-dir> [options]
```

### Command-Line Options

| Option | Description |
|---|---|
| `--source <path>` | *(required)* Path to the ModusToolbox application directory |
| `--dest <path>` | *(required)* Path to the destination directory to create |
| `--force` | Delete the destination directory if it already exists |
| `--bsp <name>` | Select a specific BSP when multiple `TARGET_*` directories exist |
| `--sign-combine <path>` | Path to an EPT sign-combine JSON config (e.g. `boot_with_extended_boot.json`) |
| `--set <key> <value>` | Override a symbol value in the sign-combine config (repeatable) |
| `--target <list>` | Comma-separated toolchains to generate (`iar`, `gcc`, `llvm`, `arm`; default: all) |
| `--cmake-only` | Re-generate CMake files only — skip file copies (destination must exist; cannot combine with `--force`) |
| `--logfile <path>` | Append log output to a file in addition to the console |
| `--help` | Print usage and exit |

### Typical Workflow

```bash
# First conversion
node dist/index.js --source ~/projects/my_mtb_app --dest ~/cmake_out --force

# After changing source files only (regenerate cmake without re-copying)
node dist/index.js --source ~/projects/my_mtb_app --dest ~/cmake_out --cmake-only

# Limit to GCC and IAR toolchains only
node dist/index.js --source ~/projects/my_mtb_app --dest ~/cmake_out --target gcc,iar --force
```

---

## Destination Directory Layout

```
<dest>/
├── CMakeLists.txt          # top-level; add_subdirectory for each project
├── appinfo.cmake           # device, BSP, component, and sign-combine info
├── toolchains/
│   ├── gcc.cmake           # GCC_ARM toolchain file
│   ├── iar.cmake           # IAR toolchain file
│   ├── llvm.cmake          # LLVM_ARM toolchain file
│   └── arm.cmake           # ARM Compiler 6 toolchain file
├── bsps/
│   └── TARGET_<bspname>/
│       ├── <bsp source files ...>
│       └── bsp.cmake       # include()-able BSP source/header list
├── assets/
│   └── <asset-name>/
│       ├── <asset source files ...>
│       └── CMakeLists.txt  # OBJECT library or header-only target
└── <project-name>/
    ├── <project source files ...>
    ├── CMakeLists.txt      # project executable target; links assets & BSP
    └── projinfo.cmake      # component list for the project
```

---

## Internal Design

### Entry Point — `src/index.ts`

Parses the command line, validates arguments, constructs an `MTB5Converter` instance, and
calls `converter.convert()`.  All business logic lives in `MTB5Converter`.

---

### Converter — `src/mtb5conv.ts` — `MTB5Converter`

The central orchestrator.  Its public `convert()` method drives the following phases in order:

#### Phase 1 — Load App Info
```
env_.load(MTBLoadFlags.appInfo, source)
```
Delegates to `ModusToolboxEnvironment` (see below) to parse `Makefile`-derived variables,
discover projects, assets, and BSPs.

#### Phase 2 — `copyBSPs()`
* Scans `source/BSPs/TARGET_*/` directories.
* Copies each BSP directory to `dest/bsps/TARGET_*/` (skipped in `--cmake-only` mode).
* Scans the BSP's `deps/` subdirectory for `*.mtbx` files; parses each to extract the
  referenced asset name (ignoring any `TARGET_*` entries).
* Calls `generateBspCMakeInclude()` to produce a `bsp.cmake` file alongside each BSP,
  passing the list of BSP dependency asset names so they are emitted as
  `add_subdirectory` calls at the top of the file.

#### Phase 3 — `copyAssets()`
* Iterates the asset requests from each project's `MTBProjectInfo`.
* Copies each referenced middleware asset (except `device-db` and BSP assets) to
  `dest/assets/<name>/` (skipped in `--cmake-only` mode), stripping any `.git` directory.
* For each copied asset, calls either `generateObjectLibraryCMakeLists()` (source files
  present) or `generateHeaderOnlyCMakeLists()` (header-only asset).
* Asset include directories are resolved via `depends.json`.

#### Phase 4 — `copyProjects()`
* Copies each project directory to `dest/<project-name>/`.
* Removes `Makefile`/`makefile` from the destination.
* Runs `make codegen` for each toolchain × configuration combination via
  `runMakeCodegenForProject()` to capture compiler/linker flags.
* Reads `.defines` files after each codegen run to capture preprocessor defines.
* Calls `generateProjectCMakeLists()` and `generateProjInfoCMake()`.

#### Phase 5 — `generateTopLevel()`
* Calls `generateTopLevelCMakeLists()` (top-level `CMakeLists.txt`).
* Calls `generateAppInfoCMake()` (`appinfo.cmake`).
* Optionally processes a sign-combine JSON file via `processSignCombineJson()`.
* Calls one `generateXxxToolchainCMake()` per enabled toolchain target.

---

### Environment — `src/mtbenv/`

A library (originally part of a larger ModusToolbox VS Code extension) that understands the
ModusToolbox directory layout and metadata format.

| File | Purpose |
|---|---|
| `mtbenv/mtbenv.ts` — `ModusToolboxEnvironment` | Singleton that orchestrates loading; locates the ModusToolbox tools directory; exposes `appInfo` and `toolsDir`. |
| `mtbenv/loadflags.ts` — `MTBLoadFlags` | Bit-flags controlling which parts of the environment to load (`appInfo`, `manifestDb`, etc.). |
| `mtbenv/mtbcmd.ts` — `MTBCommand` | Thin wrapper around `child_process.spawn` for running ModusToolbox make commands. |
| `appdata/mtbappinfo.ts` — `MTBAppInfo` | Parsed representation of the top-level application: type (`combined` vs `application`), list of projects, Makefile variables. |
| `appdata/mtbprojinfo.ts` — `MTBProjectInfo` | Per-project metadata: name, path, device, components, asset requests, ignore paths. |
| `appdata/mtbassetreq.ts` — `MTBAssetRequest` | A single middleware asset reference from a project's dependency list. |
| `appdata/mtbdirlist.ts` — `MTBDirList` | Resolves the `CY_GETLIBS_PATH` search path used to find assets. |
| `misc/mtbutils.ts` — `MTBUtils` | Utility helpers, including `callMake()` (invokes `make` via modus-shell). |

---

### CMake Utilities — `src/cmakeutil.ts`

A collection of pure functions that produce CMake source text.

#### Source / Header Collection
| Function | Description |
|---|---|
| `collectSources(dir, baseDir, ...)` | Recursively finds `*.c` / `*.s` files; attaches `DirCondition[]` metadata from `COMPONENT_*`, `TARGET_*`, `CONFIG_*`, `TOOLCHAIN_*` parent directory names. |
| `collectHeaders(dir, baseDir, ...)` | Same as above but for `*.h` files. |
| `groupSources(sources)` | Partitions a `ConditionalSource[]` list into unconditional files and groups sharing identical conditions. |
| `hasActiveSources(sources, components)` | Returns `true` if at least one source would be active given the project's component set. |

#### Condition Handling
| Function | Description |
|---|---|
| `extractPathConditions(path)` | Extracts `DirCondition[]` from path segments. |
| `conditionToCMake(conditions)` | Serialises conditions to a CMake `if()` expression. |
| `conditionKey(conditions)` | Stable string key for grouping conditions. |

#### Flag-File Parsing
| Function | Description |
|---|---|
| `readProjectFlagsByConfig(srcProjDir)` | Reads `.cflags`, `.asflags`, `.cxxflags`, `.ldflags`, `.ldlibs` for Debug and Release from `build/<BSP>/<Config>/`. |
| `readProjectFlagsForConfig(srcProjDir, config)` | Single-config variant; used immediately after each `make codegen` run. |
| `mergeProjectFlagsByConfig(a, b)` | Merges per-config flag sets into one `ProjectFlagsByConfig`. |
| `filterCompileTokens(tokens)` | Strips CMake-managed compile flags (`-c`, `-MD`, `-MF <file>`, etc.). |
| `filterLinkTokens(tokens)` | Strips CMake-managed linker flags; detects CMSE veneer flags; extracts `-L` dirs. |

#### Defines Parsing
| Function | Description |
|---|---|
| `readProjectDefinesForConfig(srcProjDir, config)` | Reads a `.defines` file (Model 1: `build/<BSP>/<Config>/.defines` or Model 2: `build/.defines`). |
| `fixDefineFilePaths(defines, baseDir)` | Resolves relative-path values embedded inside `"../../..."` defines to absolute paths. |

#### Dependency Resolution
| Function | Description |
|---|---|
| `loadDependsDB(path)` | Parses `depends.json` (supports `//` and `/* */` comments). |
| `resolveIncludeDirs(asset, db, base, bspDir)` | Walks `imports` recursively to collect PUBLIC include directories for an asset's `CMakeLists.txt`. |
| `resolveAssetExports(asset, db, base)` | Collects the PUBLIC exported include directories of an asset for propagation to the parent project. |
| `resolveAssetInternals(asset, db)` | Collects PRIVATE internal include directories for an asset. |

#### CMake File Generation
| Function | Generates |
|---|---|
| `generateObjectLibraryCMakeLists(dir, name, ...)` | `CMakeLists.txt` for a middleware asset as a CMake `OBJECT` library. |
| `generateHeaderOnlyCMakeLists(dir, name, ...)` | `CMakeLists.txt` for a header-only asset using `add_custom_target`. |
| `generateBspCMakeInclude(dir, sources, headers, bspDeps)` | `bsp.cmake` include file for a BSP directory; `bspDeps` emits `add_subdirectory` calls for assets declared in the BSP's `deps/*.mtbx` files. |
| `generateProjectCMakeLists(dir, name, ...)` | `CMakeLists.txt` for an application project; includes toolchain-conditional compile/link flags. |
| `generateProjInfoCMake(dir, components)` | `projinfo.cmake` exposing the project's component list. |
| `generateTopLevelCMakeLists(dest, projects, ...)` | Root `CMakeLists.txt` with `add_subdirectory` for each project and optional sign-combine steps. |
| `generateAppInfoCMake(dest, device, ...)` | `appinfo.cmake` with device ID, BSP name, and sign-combine symbol overrides. |
| `generateGccToolchainCMake(dest)` | `toolchains/gcc.cmake` |
| `generateIarToolchainCMake(dest)` | `toolchains/iar.cmake` |
| `generateLlvmToolchainCMake(dest)` | `toolchains/llvm.cmake` |
| `generateArmToolchainCMake(dest)` | `toolchains/arm.cmake` |

---

### Dependency Database — `depends.json`

A JSON file (with comment support) that lives next to the compiled `dist/` directory.  It is
a hand-maintained list of ModusToolbox middleware assets, each entry recording:

| Field | Meaning |
|---|---|
| `name` | Asset name as used in `.mtb` manifest files |
| `exports` | Subdirectories the asset exports as PUBLIC include paths |
| `imports` | Other assets or special tokens (`***BSP***`, `***PROJECT***`) this asset depends on for include resolution |
| `includes` | Additional include directories added directly to the asset target |
| `internal` | Subdirectories that are PRIVATE to the asset's own compilation |
| `excludes` | Subdirectories that should not be scanned for source files |

Special import tokens:
* `***BSP***` — resolves to the BSP root directory (`${BSP_DIR}`).
* `***BSP***/some/path` — resolves to a specific subdirectory of the BSP.
* `***PROJECT***` — resolves to the project source directory (`${PROJECTDIR}`).

Conditional imports use the `ComponentImport` shape `{ "component": "FREERTOS", "name": "freertos" }`,
which wraps the resolved include directories inside a CMake `if(COMPONENT_FREERTOS)` guard.

---

### Key Data Types

| Type | Module | Description |
|---|---|---|
| `ConditionalSource` | `cmakeutil.ts` | A source or header file path paired with its `DirCondition[]`. |
| `ConditionalIncludeDir` | `cmakeutil.ts` | An include path paired with its `DirCondition[]`. |
| `DirCondition` | `cmakeutil.ts` | A single condition derived from a special parent directory (`COMPONENT_*`, `TARGET_*`, `CONFIG_*`, `TOOLCHAIN_*`). |
| `DependsEntry` | `cmakeutil.ts` | One record from `depends.json`. |
| `ProjectFlagsByConfig` | `cmakeutil.ts` | Compile and link flags for both Debug and Release, keyed by language (c, asm, cxx, link, libs). |
| `ProjectFlagsByToolchain` | `cmakeutil.ts` | `ProjectFlagsByConfig` indexed by toolchain name. |
| `ConfigFlagSet` | `cmakeutil.ts` | A pair of flag arrays (debug / release) for one language, plus the source file paths. |
| `SignCombineInfo` | `cmakeutil.ts` | Parsed sign-combine JSON describing post-build image combination commands. |

---

### Logging

Winston is used for all diagnostic output.  The logger is created in `MTB5Converter`'s
constructor and always writes to `Console`.  If `--logfile` is supplied a second `File`
transport is added.  Log messages use `timestamp [level]: message` format.
