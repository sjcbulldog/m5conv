# Asset Manifest Generator

TypeScript command-line tool to generate `asset.json` files for each asset directory.

## Behavior

- Scans asset directories under `assets/` (or a custom directory path you pass as first argument).
- Scans asset directories under `assets/` by default.
- Supports `--sdk SDKDIR` to treat `SDKDIR` as the SDK root and scan `SDKDIR/assets`.
- Treats each immediate subdirectory of an asset that starts with `COMPONENT_` as a component.
- Writes an `asset.json` file inside each asset directory.
- Manifest shape:

```json
{
  "components": [
    {
      "name": "COMPONENT_EXAMPLE",
      "type": "local",
      "description": "TBD"
    }
  ]
}
```

- `type` is:
  - `local` if the component appears in exactly one asset
  - `global` if the component appears in multiple assets

## Usage

```bash
npm install
npm run build
npm run generate:assets
```

Optionally provide an assets directory:

```bash
npm run generate:assets -- ./path/to/assets
```

Or provide an SDK directory that contains `assets/`:

```bash
npm run generate:assets -- --sdk ./path/to/sdk
```

For local development without build:

```bash
npm run dev:generate:assets
```
