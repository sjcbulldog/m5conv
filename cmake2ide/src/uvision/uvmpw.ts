/**
 * Generates a Keil µVision multi-project workspace file (.uvmpw).
 *
 * The workspace references one or more .uvprojx project files. The first
 * project listed is set as the active project.
 */
import { xmlEscape } from "./xml.js";

export interface UVisionProjectRef {
  /** Path to the .uvprojx file, relative to the .uvmpw file, forward slashes. */
  path: string;
}

export interface UVisionMpwInput {
  projects: UVisionProjectRef[];
}

export function renderUvmpw(input: UVisionMpwInput): string {
  const items = input.projects
    .map((p, i) =>
      [
        `  <ProjectItem>`,
        `    <PathAndName>${xmlEscape("./" + p.path)}</PathAndName>`,
        `    <NodeIsActive>${i === 0 ? 1 : 0}</NodeIsActive>`,
        `  </ProjectItem>`,
      ].join("\n"),
    )
    .join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>`,
    `<ProjectWorkspace xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="project_mpw.xsd">`,
    `  <SchemaVersion>1.0</SchemaVersion>`,
    `  <Header>### uVision Project, (C) Keil Software</Header>`,
    items,
    `</ProjectWorkspace>`,
    "",
  ].join("\n");
}
