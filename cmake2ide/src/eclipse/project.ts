import { xmlEscape } from '../iar/xml.js';

/**
 * Renders a `.project` file for an Eclipse cmake4eclipse project.
 *
 * cmake4eclipse drives all build activity; Eclipse CDT provides
 * indexing and tooling only.
 *
 * @param name  Eclipse project name (must match the directory name in the workspace)
 */
export function renderProject(name: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<projectDescription>',
    `\t<name>${xmlEscape(name)}</name>`,
    '\t<comment></comment>',
    '\t<projects>',
    '\t</projects>',
    '\t<buildSpec>',
    '\t\t<buildCommand>',
    '\t\t\t<name>de.marw.cmake4eclipse.mbs.genscriptbuilder</name>',
    '\t\t\t<arguments>',
    '\t\t\t</arguments>',
    '\t\t</buildCommand>',
    '\t</buildSpec>',
    '\t<natures>',
    '\t\t<nature>de.marw.cmake4eclipse.mbs.cmake4eclipsenature</nature>',
    '\t\t<nature>org.eclipse.cdt.core.cnature</nature>',
    '\t\t<nature>org.eclipse.cdt.core.ccnature</nature>',
    '\t</natures>',
    '</projectDescription>',
    '',
  ].join('\n');
}
