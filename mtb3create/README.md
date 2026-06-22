# mtb3create

Creates all ModusToolbox template applications for one or more BSPs by invoking the ModusToolbox project creator tool. Each application is placed under a BSP-named sub-directory inside the destination directory. Creation logs are written to a `logs/` sub-directory.

## Usage

```
mtb3create --bsps <bsplist> --dest <path> --creator <path> [--force]
```

## Required Arguments

| Argument | Description |
|---|---|
| `--bsps <bsplist>` | Comma-separated list of BSP identifiers, e.g. `BSP_DESIGN_MODUS3,BSP_FOO` |
| `--dest <path>` | Destination directory where application sub-directories are created |
| `--creator <path>` | Path to the ModusToolbox project creator executable |

## Optional Arguments

| Argument | Description |
|---|---|
| `--force` | Delete the contents of `--dest` before creating applications if the directory is not empty |
| `--help`, `-h` | Display usage information |

## Output Layout

```
<dest>/
  <BSP_NAME>/
    <AppId>/       ← application source tree
    ...
  logs/
    <AppId>_<BSP>.log
```

## Example

```sh
mtb3create --bsps CY8CKIT-062S2-43012,CY8CPROTO-062-4343W \
           --dest ./apps \
           --creator "C:/ModusToolbox/tools_3.4/project-creator/project-creator-cli.exe" \
           --force
```

## Notes

- The tool tries several common invocation patterns for the creator executable and picks the first one that succeeds.
- A per-application log file is always written under `<dest>/logs/` regardless of success or failure.
- Exit code is non-zero if any application fails to create.

## Packaging

```sh
npm run pkg:all   # builds binaries for Windows, Linux, and macOS
```
