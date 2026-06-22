# cmake2ide (`cmod`)

Converts a CMake-based ModusToolbox project into IDE project files. It uses the CMake File API to read the project model and then generates project files for the requested IDE backends. Supported targets are IAR Embedded Workbench, Eclipse CDT (via cmake4eclipse), and Keil µVision.

## Usage

```
cmod [--input <cmake-source-dir>] [--iar <output-dir>] [--eclipse <eclipse-dir>]
     [--uvision <output-dir>] [--greenhills <output-dir>] [--force]
```

## Arguments

| Argument | Description |
|---|---|
| `--input <cmake-source-dir>` | Root of the CMake project source tree. Required for `--iar`, `--uvision`, and `--greenhills`. Optional for `--eclipse` (see below) |
| `--iar <output-dir>` | Generate an IAR Embedded Workbench workspace (`.eww` / `.ewp`) in `<output-dir>` |
| `--eclipse <eclipse-dir>` | Generate Eclipse CDT project files. See Eclipse mode details below |
| `--uvision <output-dir>` | Generate a Keil µVision workspace (`.uvmpw` / `.uvprojx`) in `<output-dir>` |
| `--greenhills <output-dir>` | *(Not yet implemented)* Reserved for future Green Hills MULTI support |
| `--force`, `-f` | Overwrite the output directory if it already exists and is not empty |
| `--help`, `-h` | Display usage information |

At least one output target (`--iar`, `--eclipse`, `--uvision`, or `--greenhills`) must be specified.

## Eclipse Mode

`--eclipse` has two sub-modes:

- **Copy mode** (`--input` + `--eclipse`): Copies the CMake source tree to `<eclipse-dir>`, then adds Eclipse project files. The toolchain used is `<source>/toolchains/gcc.cmake`.
- **In-place mode** (`--eclipse` only, no `--input`): Modifies the existing CMake project at `<eclipse-dir>` in place. The directory must already exist and contain `toolchains/gcc.cmake`.

## Toolchain File Resolution

| Backend | Toolchain file |
|---|---|
| `--iar` | `<source>/toolchains/iar.cmake` |
| `--eclipse` | `<source>/toolchains/gcc.cmake` (or `<eclipse-dir>/toolchains/gcc.cmake` in-place) |
| `--uvision` | `<source>/toolchains/keil.cmake` if present, otherwise `gcc.cmake` |

## Examples

```sh
# Generate an IAR workspace
cmod --input ./my-cmake-app --iar ./iar-output --force

# Generate a Keil µVision workspace
cmod --input ./my-cmake-app --uvision ./uvision-output

# Add Eclipse project files to an existing CMake project in-place
cmod --eclipse ./my-cmake-app

# Generate IAR and Eclipse in a single run
cmod --input ./my-cmake-app --iar ./iar-out --eclipse ./eclipse-out --force
```

## Notes

- CMake is invoked with `-G Ninja` to configure a temporary build directory for model extraction; the temporary directory is removed automatically when the tool exits.
- Multiple backends can be generated in a single invocation.

## Packaging

```sh
npm run pkg:all   # builds binaries for Windows, Linux, and macOS
```
