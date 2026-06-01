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

/** Returns the short project name (basename of .ewp without extension). */
function projectName(p: IarEwwProjectRef): string {
  return p.path.split("/").pop()!.replace(/\.ewp$/i, "");
}

/**
 * Returns projects sorted so that dependencies come before their dependents
 * (topological order), which is the order IAR uses for a batch build.
 */
function topoSort(projects: IarEwwProjectRef[]): IarEwwProjectRef[] {
  const byName = new Map(projects.map((p) => [projectName(p), p]));
  const result: IarEwwProjectRef[] = [];
  const visited = new Set<string>();
  const visit = (p: IarEwwProjectRef): void => {
    const n = projectName(p);
    if (visited.has(n)) return;
    visited.add(n);
    for (const dep of p.dependencies ?? []) {
      const d = byName.get(dep);
      if (d) visit(d);
    }
    result.push(p);
  };
  for (const p of projects) visit(p);
  return result;
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

  const sortedForBatch = topoSort(input.projects);

  const makeBatchDefinition = (name: string, configuration: string): string => {
    const members = sortedForBatch
      .map((p) =>
        [
          `      <member>`,
          `        <project>${xmlEscape(projectName(p))}</project>`,
          `        <configuration>${xmlEscape(configuration)}</configuration>`,
          `      </member>`,
        ].join("\n"),
      )
      .join("\n");
    return [
      `    <batchDefinition>`,
      `      <name>${xmlEscape(name)}</name>`,
      members,
      `    </batchDefinition>`,
    ].join("\n");
  };

  const batchBuild = [
    `  <batchBuild>`,
    makeBatchDefinition("FullBuild-Debug", "Debug"),
    makeBatchDefinition("FullBuild-Release", "Release"),
    `  </batchBuild>`,
  ].join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<workspace>`,
    projects,
    batchBuild,
    `</workspace>`,
    "",
  ].join("\n");
}
