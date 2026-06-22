# mtb2cmake

Converts a single ModusToolbox 3.x application directory into a CMake project compatible with ModusToolbox 5.x (MTB5). It reads the application's asset dependencies, copies source and BSP files, and emits a complete CMake project with toolchain files for all supported compilers.

## Usage

```
mtb2cmake --source <path> --dest <path> --depends <path> [options]
```

## Required Arguments

| Argument | Description |
|---|---|
| `--source <path>` | Source directory of the ModusToolbox 3.x application |
| `--dest <path>` | Destination root directory for the generated CMake project |
| `--depends <path>` | Path to the `depends.json` file describing asset dependencies |

## Optional Arguments

| Argument | Description |
|---|---|
| `--bsp <name>` | BSP name to use; required when multiple BSPs are present in the source |
| `--target <list>` | Comma-separated toolchain targets to generate (`iar`, `gcc`, `llvm`, `arm`); defaults to all four |
| `--force` | Delete the destination directory before conversion if it already exists |
| `--cmake-only` | Regenerate CMake files only; skip all file copies. Destination must already exist. Cannot be combined with `--force` |
| `--sign-combine <path>` | Path to an EPT sign-combine JSON configuration file |
| `--set <key> <value>` | Override a sign-combine symbol value; may be repeated for multiple overrides |
| `--generated-dir <file>` | Write the full path of the generated CMake directory (forward slashes) to this file |
| `--logfile <path>` | Write log output to this file |
| `--help` | Display usage information |

## Example

```sh
mtb2cmake --source ./workspace/CY8CKIT-062S2-43012/MyApp \
          --dest ./output \
          --bsp CY8CKIT-062S2-43012 \
          --target gcc,llvm,iar,arm \
          --depends ./depends.json \
          --force
```

## Packaging

```sh
npm run pkg:all   # builds binaries for Windows, Linux, and macOS
```
