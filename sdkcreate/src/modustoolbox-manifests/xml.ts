export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeWhitespace(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const text = getString(value.text) ?? getString(value.cdata);
  if (text) {
    return text;
  }

  return undefined;
}

export function splitCapabilities(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse a v2 requirement capability string into an AND-of-OR structure.
 *
 * Each `[a, b, c]` group is one OR clause — at least one member must be
 * satisfied. Multiple groups are AND'd: all groups must be satisfied.
 *
 * Strings without brackets are treated as flat space-separated tokens where
 * each token becomes its own single-item group (backward-compatible with v1).
 *
 * Examples:
 *   "[bsp_gen5] [kit_xmc72_evk,kit_xmc71_evk_lite_v1]"
 *     → [["bsp_gen5"], ["kit_xmc72_evk", "kit_xmc71_evk_lite_v1"]]
 *
 *   "mcu_gp mcu_xmc7xxx"  (v1 flat)
 *     → [["mcu_gp"], ["mcu_xmc7xxx"]]
 */
export function parseRequirements(value: string | undefined): string[][] {
  if (!value) {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.includes("[")) {
    const groups: string[][] = [];
    const bracketRe = /\[([^\]]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = bracketRe.exec(trimmed)) !== null) {
      const members = m[1]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (members.length > 0) {
        groups.push(members);
      }
    }
    return groups;
  }

  // No brackets — each whitespace-separated token is its own group.
  return trimmed
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => [s]);
}

export function splitCommaSeparated(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\r\n/g, "\n");
}
