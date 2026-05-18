import { xmlEscape } from '../iar/xml.js';

export interface LinkedResource {
  /** Workspace-relative name shown in the Eclipse Project Explorer. */
  name: string;
  /** Absolute filesystem path (forward slashes). */
  absPath: string;
}

/**
 * Renders a `.project` file for an Eclipse CDT managed-build project.
 *
 * @param name    Eclipse project name
 * @param links   Linked virtual folders pointing at source directories
 */
export function renderProject(name: string, links: LinkedResource[]): string {
  const linkedResourcesXml =
    links.length === 0
      ? ''
      : [
          '\t<linkedResources>',
          ...links.map((l) =>
            [
              '\t\t<link>',
              `\t\t\t<name>${xmlEscape(l.name)}</name>`,
              '\t\t\t<type>2</type>',
              `\t\t\t<location>${xmlEscape(l.absPath.replace(/\\/g, '/'))}</location>`,
              '\t\t</link>',
            ].join('\n'),
          ),
          '\t</linkedResources>',
        ].join('\n');

  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<projectDescription>',
    `\t<name>${xmlEscape(name)}</name>`,
    '\t<comment></comment>',
    '\t<projects>',
    '\t</projects>',
    '\t<buildSpec>',
    '\t\t<buildCommand>',
    '\t\t\t<name>org.eclipse.cdt.managedbuilder.core.genmakebuilder</name>',
    '\t\t\t<triggers>clean,full,incremental,</triggers>',
    '\t\t\t<arguments>',
    '\t\t\t</arguments>',
    '\t\t</buildCommand>',
    '\t\t<buildCommand>',
    '\t\t\t<name>org.eclipse.cdt.managedbuilder.core.ScannerConfigBuilder</name>',
    '\t\t\t<triggers>full,incremental,</triggers>',
    '\t\t\t<arguments>',
    '\t\t\t</arguments>',
    '\t\t</buildCommand>',
    '\t</buildSpec>',
    '\t<natures>',
    '\t\t<nature>org.eclipse.cdt.core.cnature</nature>',
    '\t\t<nature>org.eclipse.cdt.core.ccnature</nature>',
    '\t\t<nature>org.eclipse.cdt.managedbuilder.core.managedBuildNature</nature>',
    '\t\t<nature>org.eclipse.cdt.managedbuilder.core.ScannerConfigNature</nature>',
    '\t</natures>',
  ];

  if (linkedResourcesXml) parts.push(linkedResourcesXml);
  parts.push('</projectDescription>', '');

  return parts.join('\n');
}
