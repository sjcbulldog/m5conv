/**
 * Minimal XML helpers for emitting IAR project files.
 */

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;");
}

export interface IarOption {
  name: string;
  version?: number;
  /** Omit entirely to produce an option element with no <state> child. */
  states?: string[];
}

export function renderOption(opt: IarOption, indent: string): string {
  const ver = opt.version !== undefined ? `\n${indent}  <version>${opt.version}</version>` : "";
  if (opt.states === undefined) {
    return `${indent}<option>\n${indent}  <name>${opt.name}</name>${ver}\n${indent}</option>`;
  }
  const states = opt.states
    .map((s) => `${indent}  <state>${xmlEscape(s)}</state>`)
    .join("\n");
  return [
    `${indent}<option>`,
    `${indent}  <name>${opt.name}</name>${ver}`,
    states,
    `${indent}</option>`,
  ].join("\n");
}
