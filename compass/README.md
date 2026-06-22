# compass (compass-asset-manifest-tool)

Generates per-asset `asset.json` component manifests for a ModusToolbox SDK assets directory. For each asset sub-directory it discovers all `COMPONENT_*` directories, determines whether each component is `local` (used by only one asset) or `global` (shared across multiple assets), and writes an `asset.json` manifest file into each asset directory.

## Usage

```
compass [--sdk <path>] [<assets-dir>]
```

## Arguments

| Argument | Description |
|---|---|
| `<assets-dir>` | *(Positional, optional)* Path to the assets directory. Defaults to `./assets` relative to the current working directory |
| `--sdk <path>` | Path to an SDK root directory; the assets directory is resolved as `<sdk>/assets` |

Only one of the positional argument or `--sdk` should be provided. If both are omitted the tool defaults to `./assets`.

## Output

For every sub-directory found inside the assets directory, a file named `asset.json` is written with the following structure:

```json
{
  "components": [
    { "name": "COMPONENT_FREERTOS", "type": "global", "description": "TBD" },
    { "name": "COMPONENT_CM4",      "type": "local",  "description": "TBD" }
  ]
}
```

A component is marked `global` if it appears in more than one asset; otherwise it is `local`.

## Examples

```sh
# Use the default ./assets directory
compass

# Specify an assets directory explicitly
compass ./path/to/assets

# Derive the assets directory from an SDK root
compass --sdk ./sdk
```
