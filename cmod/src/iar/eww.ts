/**
 * Generates an IAR Embedded Workbench workspace file (.eww) that references
 * a set of .ewp project files.
 */
import { xmlEscape } from "./xml.js";

export interface IarEwwProjectRef {
  /** Path to .ewp file, relative to the workspace file, using forward slashes. */
  path: string;
  /** Short project names (basename of .ewp without extension) this project depends on. */
  dependencies?: string[];
}

export interface IarEwwInput {
  projects: IarEwwProjectRef[];
}

export function renderEww(input: IarEwwInput): string {
  const projects = input.projects
    .map((p) => {
      const lines = [
        `  <project>`,
        `    <path>$WS_DIR$/${xmlEscape(p.path)}</path>`,
        ...(p.dependencies ?? []).map((d) => `    <dependency>${xmlEscape(d)}</dependency>`),
        `  </project>`,
      ];
      return lines.join("\n");
    })
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<workspace>`,
    projects,
    `  <batchBuild/>`,
    `</workspace>`,
    "",
  ].join("\n");
}
