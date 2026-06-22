# createproj

Creates a new ModusToolbox application from an assembled SDK directory. It reads the SDK structure for the specified BSP and scaffolds the application in the destination directory.

## Usage

```
createproj --sdk <path> --bsp <name> --dest <path>
```

## Required Arguments

| Argument | Description |
|---|---|
| `--sdk <path>` | Path to the SDK directory (as produced by `sdkmake`) |
| `--bsp <name>` | BSP name to use when creating the application |
| `--dest <path>` | Destination directory where the new application will be created |

## Example

```sh
createproj --sdk ./sdk \
           --bsp CY8CKIT-062S2-43012 \
           --dest ./my-app
```
