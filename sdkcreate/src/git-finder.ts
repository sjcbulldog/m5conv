import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const CYGWIN_CANDIDATES = [
  "C:\\cygwin64\\bin\\git.exe",
  "C:\\cygwin\\bin\\git.exe",
];

const GIT_FOR_WINDOWS_CANDIDATES = [
  "C:\\Program Files\\Git\\cmd\\git.exe",
  "C:\\Program Files\\Git\\bin\\git.exe",
  "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
  "C:\\Program Files (x86)\\Git\\bin\\git.exe",
];

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function testGit(gitPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(gitPath, ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

/** Search for ModusToolbox modus-shell git under the user's home directory. */
async function findModusShellGit(): Promise<string | undefined> {
  const userProfile = process.env["USERPROFILE"] ?? os.homedir();
  const mtbDir = path.join(userProfile, "ModusToolbox");

  let entries: string[];
  try {
    entries = await readdir(mtbDir);
  } catch {
    return undefined;
  }

  // Prefer the newest tools_* version.
  const toolsDirs = entries
    .filter((e) => /^tools_\d/.test(e))
    .sort()
    .reverse();

  for (const toolsDir of toolsDirs) {
    const gitPath = path.join(
      mtbDir,
      toolsDir,
      "modus-shell",
      "opt",
      "msys2",
      "usr",
      "bin",
      "git.exe",
    );
    if (await fileExists(gitPath)) {
      return gitPath;
    }
  }

  return undefined;
}

/**
 * Locate a usable git executable, searching (in order):
 *   1. System PATH
 *   2. Cygwin (cygwin64 then cygwin)
 *   3. Git for Windows
 *   4. ModusToolbox modus-shell
 */
export async function findGit(): Promise<string> {
  if (await testGit("git")) {
    return "git";
  }

  for (const candidate of [...CYGWIN_CANDIDATES, ...GIT_FOR_WINDOWS_CANDIDATES]) {
    if ((await fileExists(candidate)) && (await testGit(candidate))) {
      return candidate;
    }
  }

  const modusShelLGit = await findModusShellGit();
  if (modusShelLGit && (await testGit(modusShelLGit))) {
    return modusShelLGit;
  }

  throw new Error(
    "git not found. Install Git for Windows (https://git-scm.com), " +
      "Cygwin with git, or ModusToolbox with modus-shell.",
  );
}
