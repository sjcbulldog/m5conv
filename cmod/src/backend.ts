/**
 * Common interface shared by all IDE project-file backends.
 * A backend receives a CMakeModel (already produced by the frontend)
 * and writes IDE project files to `options.destDir`.
 */

export interface BackendOptions {
  sourceDir: string;
  destDir: string;
  workspaceName?: string;
}

/**
 * Implemented by each backend (IAR, Eclipse, …).
 * `generate()` returns the list of files written, for logging.
 */
export interface IBackend {
  generate(): Promise<string[]>;
}
