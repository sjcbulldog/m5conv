# GitHub Copilot Instructions

## Project Overview

This repository uses **ModusToolbox** (by Infineon) for embedded firmware development.

## Creating Projects with project-creator-cli

When generating commands to create a new ModusToolbox project, use `project-creator-cli`. Full command-line reference is in [`.github/create.md`](.github/create.md).

### Quick Reference

**Clone mode** (from remote manifest):
```sh
project-creator-cli --board-id <BOARD_ID> --app-id <APP_ID>
# Short form:
project-creator-cli -b <BOARD_ID> -a <APP_ID>
```

**Import mode** (from local paths):
```sh
project-creator-cli --board-path <path/to/BSP> --app-path <path/to/app>
```

**Common optional flags:**
| Flag | Short | Description |
|------|-------|-------------|
| `--target-dir <DIR>` | `-d` | Output directory (default: cwd) |
| `--user-app-name <NAME>` | `-n` | Override default app name |
| `--sdk-id <ID>` | | Specify SDK ID (use with `--sdk-version`) |
| `--sdk-version <VER>` | | Specify SDK version (use with `--sdk-id`) |
| `--app-commit <Commit>` | | Pin app template to a specific commit |
| `--board-commit <Commit>` | | Pin BSP to a specific commit |
| `--app-uri <URI>` | | Custom URI for app template |
| `--board-uri <URI>` | | Custom URI for BSP |
| `--use-modus-shell` | | Use bundled git/make from modus-shell/bin |
| `--verbose <0-3>` | | Verbosity level |
| `--list-boards` | | List available BSP IDs |
| `--list-apps <BOARD_ID>` | | List apps available for a given BSP |
| `--list-sdk-ids` | | List all SDK IDs |
| `--list-sdk-versions-for-id <ID>` | | List SDK versions for a given SDK ID |
| `--version` | `-v` | Show tool version |
| `--help` | `-h` | Show help |

> **Note:** `--board-id` and `--board-path` are mutually exclusive. Same for `--app-id` and `--app-path`.

### Example

```sh
# Clone Hello World for CY8CKIT-062-WIFI-BT into ./my-project
project-creator-cli -b CY8CKIT-062-WIFI-BT -a mtb-example-hal-hello-world -d ./my-project -n my-project
```

### Tool Location (default Windows install)
```
C:\users\<user>\ModusToolbox\tools_3.x\project-creator\project-creator-cli.exe
```

## General Guidelines

- Prefer HAL-based examples (`mtb-example-hal-*`) for portability across Infineon BSPs.
- Use `--use-modus-shell` when the system PATH does not include a compatible `git` or `make`.
- When suggesting build or flash commands, prefer `make build` and `make program` from the project root.
