# bulk3tocmake

Bulk-converts all ModusToolbox 3.x applications in a workspace directory to CMake projects. For each application sub-directory found in `--source` it invokes `mtb2cmake`, then builds the generated project with `cmake --preset=llvm-debug` followed by `cmake --build`. Successfully converted applications are moved to `--good`; failed applications are moved to `--bad`.

## Usage

```
bulk3tocmake --source <path> --dest <path> --good <path> --bad <path> \
             --depends <path> --mtb2cmake <path> [options]
```

## Required Arguments

| Argument | Description |
|---|---|
| `--source <path>` | ModusToolbox workspace directory; its basename is used as the BSP name |
| `--dest <path>` | Destination root directory for the converted CMake projects |
| `--good <path>` | Directory to move application source into when conversion and build succeed |
| `--bad <path>` | Directory to move application source into when conversion or build fails |
| `--depends <path>` | Path to the `depends.json` file |
| `--mtb2cmake <path>` | Path to the `mtb2cmake` executable |

## Optional Arguments

| Argument | Description |
|---|---|
| `--dry-run` | Print the `mtb2cmake` command line for each application and exit without running anything |
| `--fancy` | Enable split-screen ANSI UI with an application status list in the top third of the terminal and scrolling output below |
| `--help` | Display usage information |

## Example

```sh
bulk3tocmake --source ./workspace/CY8CKIT-062S2-43012 \
             --dest ./cmake-output \
             --good ./apps/good \
             --bad ./apps/bad \
             --depends ./depends.json \
             --mtb2cmake ./bin/win11/mtb2cmake.exe \
             --fancy
```

## Notes

- The directory `mtb_shared` inside `--source` is always excluded.
- Each application is processed sequentially; build failures do not stop the remaining applications.
- Exit code is non-zero if any application fails.

## Packaging

```sh
npm run pkg:all   # builds binaries for Windows, Linux, and macOS
```
