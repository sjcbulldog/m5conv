# mtb3create

TypeScript command-line tool that creates all ModusToolbox code examples valid for one or more BSPs.

## Usage

```powershell
node dist/index.js --bsps BSP_ONE,BSP_TWO --dest C:\apps\mtb --creator C:\path\to\project-creator.exe
```

Arguments:

- `--bsps BSPLIST` comma-separated list of BSP names.
- `--dest PATH` destination directory for generated applications.
- `--creator PATH` path to the ModusToolbox project creator executable.
- `--force` if destination exists and is non-empty, delete its contents first.

Behavior:

- `--dest` must be non-existent or empty.
- With `--force`, destination contents are deleted before generation.
- Each BSP gets its own subdirectory under the destination (dest/<BSP>). All applications for a BSP are created inside that BSP subdirectory.
- Duplicate app ids across different BSPs are not skipped; applications are created per-BSP in their respective folders.

## Build

```powershell
npm install
npm run build
```

## Notes on creator invocation

Different ModusToolbox versions use slightly different command formats. This CLI tries multiple known invocation patterns for both:

- listing app ids for each BSP
- creating each application from app id + BSP + target path

If your creator binary uses a custom syntax, adapt candidate argument arrays in `src/index.ts`.
