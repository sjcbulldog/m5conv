# sdkmake

Creates a ModusToolbox 4.0 SDK from a collection of canonical CMake applications. It reads application metadata from the input directory, selects assets and BSP files for the requested BSPs, and assembles a merged SDK output directory.

## Usage

```
sdkmake --input <path> --bsps <bsplist> --output <path> [options]
```

## Required Arguments

| Argument | Description |
|---|---|
| `--input <path>` | Input directory containing canonical CMake applications |
| `--bsps <bsplist>` | Comma-separated list of BSP names to include in the SDK |
| `--output <path>` | Output directory for the assembled SDK |

## Optional Arguments

| Argument | Description |
|---|---|
| `--force` | Delete and recreate the output directory if it already exists |
| `--verbose` | Print detailed information about every file copied or skipped |
| `--quiet` | Suppress all output except errors |

## Example

```sh
sdkmake --input ./cmake-apps \
        --bsps CY8CKIT-062S2-43012,CY8CPROTO-062-4343W \
        --output ./sdk \
        --force --verbose
```

## Notes

- When an asset is referenced by more than one application it is merged (not duplicated) into the SDK output.
- BSP directories are copied once even when multiple applications share the same BSP.
