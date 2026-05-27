# Edge Board Build Automation Instructions

## Overview

Create all ModusToolbox projects for the `KIT_PSE84_EVAL_EPC2` board, convert each to
CMake format, build each with Ninja, and record pass/fail results.

---

## Prerequisites

| Tool | Path |
|------|------|
| project-creator-cli | `C:/users/butch/ModusToolbox/tools_3.8/project-creator/project-creator-cli.exe` |
| conv | `C:/m5conv/bin/conv.exe` |
| cmake | `C:/Program Files/CMake/bin/cmake.exe` |
| ninja | `C:/Users/butch/ModusToolbox/tools_3.8/ninja/ninja.exe` |
| arm-none-eabi-gcc | `C:/Users/butch/Infineon/Tools/mtb-gcc-arm-eabi/14.2.1/gcc/bin/arm-none-eabi-gcc.exe` |

Add ninja to PATH before running:
```powershell
$env:PATH = "C:\Users\butch\ModusToolbox\tools_3.8\ninja;$env:PATH"
```

---

## Directory Layout

| Purpose | Path |
|---------|------|
| MTB projects (source) | `C:/m5conv/projects/mtb/edge/<app-id>` |
| CMake projects (dest) | `C:/m5conv/projects/mtb5/edge/<app-id>` |
| Per-step log files | `C:/m5conv/logs/<step>_<app-id>.log` |
| Final results | `C:/m5conv/results.txt` |

Create these directories before starting:
```powershell
New-Item -ItemType Directory -Force "C:\m5conv\projects\mtb\edge"
New-Item -ItemType Directory -Force "C:\m5conv\projects\mtb5\edge"
New-Item -ItemType Directory -Force "C:\m5conv\logs"
```

---

## App List

Get the current list of apps for the board:
```powershell
& "C:\users\butch\ModusToolbox\tools_3.8\project-creator\project-creator-cli.exe" --list-apps KIT_PSE84_EVAL_EPC2 2>&1 | Select-String "^[-a-z]*$"
```

At the time of writing this produces 144 apps. The app IDs are used as-is for
directory names (do **not** rename them).

---

## Step-by-Step Process (per app)

### Step 1 — Create the MTB Project

```powershell
$app = "mtb-example-psoc-edge-hello-world"   # replace with actual app ID
$logFile = "C:\m5conv\logs\create_$app.log"

& "C:\users\butch\ModusToolbox\tools_3.8\project-creator\project-creator-cli.exe" `
    --board-id KIT_PSE84_EVAL_EPC2 `
    --app-id $app `
    --target-dir "C:\m5conv\projects\mtb\edge" 2>&1 | Tee-Object -FilePath $logFile
```

**Success check:** The directory `C:\m5conv\projects\mtb\edge\<app-id>\Makefile` must exist
after the command completes.

**Important:** The tool emits `WARNING:Failed to load proxy settings...` on every run.
This is harmless. Do **not** treat WARNING lines as failures. Only treat the run as
failed if:
- The exit code is non-zero **and** the `Makefile` does not exist, **or**
- The output contains `"Successfully created"` is absent **and** no `Makefile` was written.

The reliable success test is:
```powershell
Test-Path "C:\m5conv\projects\mtb\edge\$app\Makefile"
```

---

### Step 2 — Fix the BSP Directory

The project-creator places the BSP inside `proj_*/libs/TARGET_*` rather than a
top-level `BSPs/TARGET_*` directory. The `conv` tool expects `BSPs/`. Copy it:

```powershell
$projectDir = "C:\m5conv\projects\mtb\edge\$app"
$bspsDir    = Join-Path $projectDir "BSPs"

if (-not (Test-Path $bspsDir)) {
    foreach ($projSubdir in Get-ChildItem $projectDir -Directory -Filter "proj_*") {
        $libsDir = Join-Path $projSubdir.FullName "libs"
        if (-not (Test-Path $libsDir)) { continue }
        foreach ($bsp in Get-ChildItem $libsDir -Directory -Filter "TARGET_*") {
            New-Item -ItemType Directory -Force $bspsDir | Out-Null
            $dest = Join-Path $bspsDir $bsp.Name
            if (-not (Test-Path $dest)) {
                Copy-Item -Recurse -Force $bsp.FullName $dest
            }
        }
    }
}
```

---

### Step 3 — Convert to CMake with conv

```powershell
$src     = "C:\m5conv\projects\mtb\edge\$app"
$dest    = "C:\m5conv\projects\mtb5\edge\$app"
$logFile = "C:\m5conv\logs\conv_$app.log"

& "C:\m5conv\bin\conv.exe" --source $src --dest $dest 2>&1 | Tee-Object -FilePath $logFile
```

**Success check:**
```powershell
Test-Path "C:\m5conv\projects\mtb5\edge\$app\CMakeLists.txt"
```

If the output contains `"Conversion failed:"` the step has failed (even if exit code is 0).

---

### Step 4 — CMake Configure (Ninja generator)

```powershell
$cmakeProject = "C:\m5conv\projects\mtb5\edge\$app"
$buildDir     = Join-Path $cmakeProject "build"
$toolchain    = Join-Path $cmakeProject "toolchains\gcc.cmake"
$logFile      = "C:\m5conv\logs\cmake_$app.log"

& cmake `
    -G Ninja `
    -DCMAKE_TOOLCHAIN_FILE="$toolchain" `
    -B "$buildDir" `
    "$cmakeProject" 2>&1 | Tee-Object -FilePath $logFile
```

**Success check:** exit code 0.

---

### Step 5 — CMake Build

```powershell
$buildDir = "C:\m5conv\projects\mtb5\edge\$app\build"
$logFile  = "C:\m5conv\logs\build_$app.log"

& cmake --build "$buildDir" 2>&1 | Tee-Object -FilePath $logFile
```

**Success check:** exit code 0.

---

## Results File Format

Write one line per app to `C:\m5conv\results.txt` using this format:

```
<app-id padded to 65 chars> : <STATUS>
```

Where `<STATUS>` is one of:

| Status | Meaning |
|--------|---------|
| `SUCCESS` | All 4 steps passed |
| `CREATE_FAILED` | Step 1 failed (no Makefile after creation) |
| `CONV_FAILED` | Step 3 failed (no CMakeLists.txt or "Conversion failed" in output) |
| `CMAKE_NO_TOOLCHAIN` | Step 4 skipped — `toolchains/gcc.cmake` not found |
| `CMAKE_CONFIG_FAILED` | Step 4 cmake configure returned non-zero |
| `BUILD_FAILED` | Step 5 cmake build returned non-zero |

Add a header and summary section:

```
================================================================================
ModusToolbox to CMake Build Results
Board: KIT_PSE84_EVAL_EPC2
Started: <timestamp>
Total apps: <N>
================================================================================

<one line per app>

================================================================================
SUMMARY
================================================================================
Total:    <N>
Passed:   <N>
Failed:   <N>
Finished: <timestamp>
================================================================================
```

---

## Automation Script

The full automation script is at `C:\m5conv\run_edge_build.ps1`.

Run it with:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\m5conv\run_edge_build.ps1
```

Or to run silently in the background with output to a log:
```powershell
Start-Process powershell.exe `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File C:\m5conv\run_edge_build.ps1" `
    -RedirectStandardOutput "C:\m5conv\run_edge_build.log" `
    -RedirectStandardError  "C:\m5conv\run_edge_build_err.log" `
    -PassThru `
    -WindowStyle Hidden
```

Monitor progress:
```powershell
Get-Content "C:\m5conv\run_edge_build.log" -Wait -Tail 20
```

Check results:
```powershell
Get-Content "C:\m5conv\results.txt"
```

---

## Re-run / Resume Behaviour

The script is **idempotent**:

- If `<mtbDir>/<app>/Makefile` already exists → skip Step 1 (create)
- If `<cmakeDir>/<app>/CMakeLists.txt` already exists → skip Step 3 (conv)
- If `<cmakeDir>/<app>/build/build.ninja` already exists → skip Step 4 (configure)
- Step 5 (build) always runs so incremental rebuilds pick up any changes

To force a full re-run of a specific app, delete its directories:
```powershell
$app = "mtb-example-psoc-edge-hello-world"
Remove-Item -Recurse -Force "C:\m5conv\projects\mtb\edge\$app"
Remove-Item -Recurse -Force "C:\m5conv\projects\mtb5\edge\$app"
```
