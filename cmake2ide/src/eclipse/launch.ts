/**
 * Generates Eclipse launch configuration XML files (.launch) for
 * Infineon Cortex-M embedded projects built with cmake4eclipse.
 *
 * Adapted from the ModusToolbox 3.8 launch configuration templates.
 * Key differences from the MTB originals:
 *  - ${cy_prj_path:UUID} → absolute project directory path
 *  - build/last_config/<target>.elf → _build/Debug/<target>/<target>.elf
 *  - build/app_combined.hex → _build/Debug/app_combined.hex
 *  - MTB-specific tool variables → standard PATH-based tool names
 *
 * Launch configs produced:
 *  - <projectName>.<primaryTarget> Debug (KitProg3_MiniProg4).launch  (OpenOCD GDB debug)
 *  - <projectName> Debug MultiCore (KitProg3_MiniProg4).launch        (group launch, if >1 core)
 *  - Advanced KitProg3 Programming.launch                             (mtb-programmer flash)
 */

import { xmlEscape } from '../iar/xml.js';

export interface LaunchTarget {
  /** Target name as it appears in CMake, e.g. `'proj_cm33_s.elf'`. */
  targetName: string;
  /**
   * Base name without the `.elf` extension, e.g. `'proj_cm33_s'`.
   * Also used as the subdirectory name in the cmake build output.
   */
  baseName: string;
  /** Whether this target is compiled with -mcmse (TrustZone Secure state). */
  hasMcmse: boolean;
}

export interface LaunchConfigInput {
  /** Eclipse project name. */
  projectName: string;
  /** Absolute path to the project directory on disk. Used instead of workspace macros. */
  projectDir: string;
  /** Ordered list of EXECUTABLE targets from the CMake model. */
  targets: LaunchTarget[];
  /**
   * Relative path to the BSP directory within the project source tree,
   * e.g. `'bsps/TARGET_APP_KIT_PSE84_EVAL_EPC2'`.
   */
  bspRelPath: string;
  /**
   * OpenOCD target config file name as passed to `source [find ...]`,
   * e.g. `'target/infineon/pse84xgxs2.cfg'`.
   */
  openocdTargetCfg: string;
  /**
   * Relative path to the QSPI FLM file within the project source tree,
   * e.g. `'bsps/TARGET_APP_KIT_PSE84_EVAL_EPC2/config/GeneratedSource/PSE84_SMIF.FLM'`.
   * `undefined` if not found / not applicable.
   */
  flmRelPath: string | undefined;
  /**
   * Relative path to the SVD file within the project source tree,
   * e.g. `'assets/mtb-dsl-pse8xxgp/pdl/svd/pse84.svd'`.
   * `undefined` if not found.
   */
  svdRelPath: string | undefined;
  /**
   * Relative path to the debug token/certificate within the project source tree,
   * e.g. `'packets/debug_token.bin'`.
   * `undefined` if not present.
   */
  debugCertRelPath: string | undefined;
  /**
   * Whether multiple CPU cores should be enabled simultaneously (e.g. CM33 + CM55).
   * Reserved for future multi-core launch config generation; not used in standalone configs.
   */
  multiCore: boolean;
  /**
   * cmake4eclipse Debug config ID from the `.cproject` file.
   * Written to `PROJECT_BUILD_CONFIG_ID_ATTR` so Eclipse links the launch to the correct build config.
   * Must match the `cconfiguration id` of the Debug entry in `.cproject`.
   */
  debugConfigId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Absolute project directory path, with forward slashes for cross-platform compatibility. */
function projectLoc(inp: LaunchConfigInput): string {
  return inp.projectDir.replace(/\\/g, '/');
}

/** Build output dir for a given target (cmake places each executable in its own subdir). */
function elfPath(inp: LaunchConfigInput, baseName: string, config = 'Debug'): string {
  return `${projectLoc(inp)}/_build/${config}/${baseName}/${baseName}.elf`;
}

function combinedHexPath(inp: LaunchConfigInput, config = 'Debug'): string {
  return `${projectLoc(inp)}/_build/${config}/app_combined.hex`;
}

function xmlAttr(key: string, value: string): string {
  return `<stringAttribute key="${xmlEscape(key)}" value="${xmlEscape(value)}"/>`;
}

function boolAttr(key: string, value: boolean): string {
  return `<booleanAttribute key="${xmlEscape(key)}" value="${value}"/>`;
}

function intAttr(key: string, value: number): string {
  return `<intAttribute key="${xmlEscape(key)}" value="${value}"/>`;
}

function mappedResources(projectName: string): string {
  return [
    `<listAttribute key="org.eclipse.debug.core.MAPPED_RESOURCE_PATHS">`,
    `\t<listEntry value="/${xmlEscape(projectName)}"/>`,
    `</listAttribute>`,
    `<listAttribute key="org.eclipse.debug.core.MAPPED_RESOURCE_TYPES">`,
    `\t<listEntry value="4"/>`,
    `</listAttribute>`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// OpenOCD GDB debug launch
// ---------------------------------------------------------------------------

/**
 * Builds the `-c "..." ` OpenOCD server arguments string for a debug session.
 * Flash-write is performed by OpenOCD at debug session start.
 * Always generates a standalone (single-core) configuration.
 */
function buildOpenocdServerOther(inp: LaunchConfigInput, target: LaunchTarget): string {
  const proj = projectLoc(inp);
  const bspGenSrc = `${proj}/${inp.bspRelPath}/config/GeneratedSource`;
  const flmArg = inp.flmRelPath
    ? `${proj}/${inp.flmRelPath}`
    : `${bspGenSrc}/PSE84_SMIF.FLM`;
  const certArg = inp.debugCertRelPath
    ? `${proj}/${inp.debugCertRelPath}`
    : `${proj}/packets/debug_token.bin`;

  const isCm55 = coreNameForTarget(target) === 'cm55';

  const lines: string[] = [
    `-s "${bspGenSrc}"`,
    `-c "set QSPI_FLASHLOADER ${flmArg}"`,
    `-c "set DEBUG_CERTIFICATE ${certArg}"`,
    `-c "source [find interface/kitprog3.cfg]"`,
    `-c "transport select swd"`,
    `-c "puts stderr {Started by GNU MCU Eclipse}"`,
  ];

  if (isCm55) {
    lines.push(`-c "set ENABLE_CM55 1"`);
    lines.push(`-c "gdb_port 3332"`);
  }

  lines.push(`-c "source [find ${inp.openocdTargetCfg}]"`);

  if (isCm55) {
    lines.push(`-c "cat1d.cm55 configure -rtos auto -rtos-wipe-on-reset-halt 0"`);
  } else {
    lines.push(`-c "cat1d.cm33 configure -rtos auto -rtos-wipe-on-reset-halt 1"`);
  }

  lines.push(
    `-c "gdb_breakpoint_override hard"`,
    `-c "init; reset init;adapter speed 12000; flash write_image erase ${combinedHexPath(inp)}"`,
    `-c "reset init;"`,
  );

  return lines.join('\r\n');
}

/**
 * Renders an OpenOCD GDB debug `.launch` file for the given primary target.
 * The launch config programs the combined hex via OpenOCD before attaching GDB.
 * Attributes are written in alphabetical key order to match the Eclipse-saved format.
 */
export function renderDebugLaunch(inp: LaunchConfigInput, primary: LaunchTarget): string {
  const I = '    ';   // 4-space attribute indent (matches Eclipse-saved format)
  const II = '        '; // 8-space inner list indent

  const programPath = elfPath(inp, primary.baseName);
  const svdArg = inp.svdRelPath
    ? `${projectLoc(inp)}/${inp.svdRelPath}`
    : '';

  const isCm55 = coreNameForTarget(primary) === 'cm55';
  const gdbPort = isCm55 ? 3332 : 3333;
  const coreName = coreNameForTarget(primary);
  const initCmd = isCm55 ? `monitor reset_halt ${coreName}` : '';
  const runCmd = `monitor reset_halt ${coreName}`;

  const memoryBlocksXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\r\n' +
    '<memoryBlockExpressionList context="Context string"/>\r\n';

  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>`,
    `<launchConfiguration type="ilg.gnumcueclipse.debug.gdbjtag.openocd.launchConfigurationType">`,
    // ilg.gnumcueclipse.debug.gdbjtag.openocd.* — booleans then strings, alphabetical
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.doContinue', true),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.doDebugInRam', false),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.doFirstReset', false),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.doGdbServerAllocateConsole', true),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.doGdbServerAllocateTelnetConsole', false),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.doSecondReset', false),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.doStartGdbCLient', true),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.doStartGdbServer', true),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.enableSemihosting', true),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.firstResetType', 'init'),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbClientOtherCommands',
      'set mem inaccessible-by-default off\r\nset remotetimeout 500'),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbClientOtherOptions', ''),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerConnectionAddress', ''),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerExecutable', 'openocd'),
    I + intAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerGdbPortNumber', gdbPort),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerLog', ''),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerOther',
      buildOpenocdServerOther(inp, primary)),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerTclPortNumber', '6666'),
    I + intAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerTelnetPortNumber', 4444),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.otherInitCommands', initCmd),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.otherRunCommands', runCmd),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.secondResetType', 'init'),
    // ilg.gnumcueclipse.debug.gdbjtag.svdPath (conditional)
    ...(svdArg ? [I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.svdPath', svdArg)] : []),
    // org.eclipse.cdt.debug.gdbjtag.core.*
    I + xmlAttr('org.eclipse.cdt.debug.gdbjtag.core.imageFileName', ''),
    I + xmlAttr('org.eclipse.cdt.debug.gdbjtag.core.imageOffset', ''),
    I + xmlAttr('org.eclipse.cdt.debug.gdbjtag.core.ipAddress', 'localhost'),
    I + xmlAttr('org.eclipse.cdt.debug.gdbjtag.core.jtagDevice', 'GNU MCU OpenOCD'),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.loadImage', false),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.loadSymbols', true),
    I + xmlAttr('org.eclipse.cdt.debug.gdbjtag.core.pcRegister', ''),
    I + intAttr('org.eclipse.cdt.debug.gdbjtag.core.portNumber', gdbPort),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.setPcRegister', false),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.setResume', false),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.setStopAt', true),
    I + xmlAttr('org.eclipse.cdt.debug.gdbjtag.core.stopAt', 'main'),
    I + xmlAttr('org.eclipse.cdt.debug.gdbjtag.core.symbolsFileName', programPath),
    I + xmlAttr('org.eclipse.cdt.debug.gdbjtag.core.symbolsOffset', ''),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.useFileForImage', true),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.useFileForSymbols', true),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.useProjBinaryForImage', false),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.useProjBinaryForSymbols', false),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.useRemoteTarget', true),
    // org.eclipse.cdt.dsf.gdb.*
    I + xmlAttr('org.eclipse.cdt.dsf.gdb.DEBUG_NAME', 'arm-none-eabi-gdb'),
    I + boolAttr('org.eclipse.cdt.dsf.gdb.UPDATE_THREADLIST_ON_SUSPEND', false),
    // org.eclipse.cdt.launch.*
    I + intAttr('org.eclipse.cdt.launch.ATTR_BUILD_BEFORE_LAUNCH_ATTR', 2),
    I + xmlAttr('org.eclipse.cdt.launch.COREFILE_PATH', ''),
    I + xmlAttr('org.eclipse.cdt.launch.PROGRAM_NAME', programPath),
    I + xmlAttr('org.eclipse.cdt.launch.PROJECT_ATTR', inp.projectName),
    I + boolAttr('org.eclipse.cdt.launch.PROJECT_BUILD_CONFIG_AUTO_ATTR', false),
    I + xmlAttr('org.eclipse.cdt.launch.PROJECT_BUILD_CONFIG_ID_ATTR', inp.debugConfigId),
    // org.eclipse.debug.core.*
    I + boolAttr('org.eclipse.debug.core.ATTR_FORCE_SYSTEM_CONSOLE_ENCODING', false),
    `${I}<listAttribute key="org.eclipse.debug.core.MAPPED_RESOURCE_PATHS">`,
    `${II}<listEntry value="/${xmlEscape(inp.projectName)}"/>`,
    `${I}</listAttribute>`,
    `${I}<listAttribute key="org.eclipse.debug.core.MAPPED_RESOURCE_TYPES">`,
    `${II}<listEntry value="4"/>`,
    `${I}</listAttribute>`,
    // org.eclipse.debug.ui.*
    `${I}<listAttribute key="org.eclipse.debug.ui.favoriteGroups">`,
    `${II}<listEntry value="org.eclipse.debug.ui.launchGroup.debug"/>`,
    `${I}</listAttribute>`,
    // org.eclipse.dsf.launch.*
    I + xmlAttr('org.eclipse.dsf.launch.MEMORY_BLOCKS', memoryBlocksXml),
    // process_factory_id
    I + xmlAttr('process_factory_id', 'org.eclipse.cdt.dsf.gdb.GdbProcessFactory'),
    `</launchConfiguration>`,
    '',
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Group (multicore) debug launch
// ---------------------------------------------------------------------------

/**
 * Renders a group launch config that launches all per-core debug sessions together.
 * Only generated when there are multiple executable targets.
 */
export function renderGroupDebugLaunch(inp: LaunchConfigInput): string {
  const groupName = `${inp.projectName} Debug MultiCore (KitProg3_MiniProg4)`;
  const memberLines: string[] = [];
  inp.targets.forEach((t, i) => {
    const memberName = `${inp.projectName}.${t.baseName} Debug (KitProg3_MiniProg4)`;
    memberLines.push(
      xmlAttr(`org.eclipse.debug.core.launchGroup.${i}.action`, 'NONE'),
      boolAttr(`org.eclipse.debug.core.launchGroup.${i}.adoptIfRunning`, false),
      boolAttr(`org.eclipse.debug.core.launchGroup.${i}.enabled`, true),
      xmlAttr(`org.eclipse.debug.core.launchGroup.${i}.mode`, 'inherit'),
      xmlAttr(`org.eclipse.debug.core.launchGroup.${i}.name`, memberName),
    );
  });

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>`,
    `<launchConfiguration type="org.eclipse.debug.core.groups.GroupLaunchConfigurationType">`,
    boolAttr('org.eclipse.debug.core.launchGroup.hide', false),
    ...memberLines,
    mappedResources(inp.projectName),
    `</launchConfiguration>`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Advanced KitProg3 Programming launch (mtb-programmer)
// ---------------------------------------------------------------------------

/**
 * Renders a "Program Application" external-tools launch that invokes
 * `mtb-programmer` to flash the cmake-built combined hex file.
 *
 * `mtb-programmer` must be on PATH or its full path substituted for the
 * `${mtb_programmer}` variable in Eclipse string substitution variables.
 */
export function renderProgramLaunch(inp: LaunchConfigInput): string {
  const proj = projectLoc(inp);
  const flmArg = inp.flmRelPath
    ? `${proj}/${inp.flmRelPath}`
    : `${proj}/${inp.bspRelPath}/config/GeneratedSource/PSE84_SMIF.FLM`;
  const certArg = inp.debugCertRelPath
    ? `${proj}/${inp.debugCertRelPath}`
    : `${proj}/packets/debug_token.bin`;

  const toolArgs = [
    `--serial ""`,
    `--hexfile ${combinedHexPath(inp)}`,
    `--debug-cert="${certArg}"`,
    `--qspi-flm "${flmArg}"`,
  ].join(' ');

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>`,
    `<launchConfiguration type="org.eclipse.ui.externaltools.ProgramLaunchConfigurationType">`,
    xmlAttr('org.eclipse.debug.core.ATTR_REFRESH_SCOPE', '${project}'),
    xmlAttr('org.eclipse.ui.externaltools.ATTR_LAUNCH_CONFIGURATION_BUILD_SCOPE', '${none}'),
    xmlAttr('org.eclipse.ui.externaltools.ATTR_LOCATION', 'mtb-programmer'),
    xmlAttr('org.eclipse.ui.externaltools.ATTR_TOOL_ARGUMENTS', toolArgs),
    xmlAttr('org.eclipse.ui.externaltools.ATTR_WORKING_DIRECTORY', proj),
    mappedResources(inp.projectName),
    `</launchConfiguration>`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Attach launch
// ---------------------------------------------------------------------------

/**
 * Derives the OpenOCD core name used in `monitor reset_halt <core>` commands.
 *  - CM55 targets            → 'cm55'
 *  - CM33 non-secure targets → 'cm33_ns'
 *  - CM33 secure / other     → 'cm33'
 */
function coreNameForTarget(target: LaunchTarget): string {
  const n = target.baseName.toLowerCase();
  if (n.includes('cm55')) return 'cm55';
  if (n.includes('_ns')) return 'cm33_ns';
  return 'cm33';
}

/** Hex output path for a target (written by POST_BUILD objcopy). */
function hexPath(inp: LaunchConfigInput, baseName: string, config = 'Debug'): string {
  return `${projectLoc(inp)}/_build/${config}/${baseName}/${baseName}.hex`;
}

/**
 * Builds the OpenOCD server arguments for an attach session.
 * Differences from debug: no BSP scripts path, no QSPI_FLASHLOADER,
 * no flash-write commands; adds `set ENABLE_ACQUIRE 0`.
 */
function buildOpenocdAttachServerOther(inp: LaunchConfigInput): string {
  const proj = projectLoc(inp);
  const certArg = inp.debugCertRelPath
    ? `${proj}/${inp.debugCertRelPath}`
    : `${proj}/packets/debug_token.bin`;

  return [
    `-c "set DEBUG_CERTIFICATE ${certArg}"`,
    `-c "source [find interface/kitprog3.cfg]"`,
    `-c "transport select swd"`,
    `-c "set ENABLE_ACQUIRE 0"`,
    `-c "puts stderr {Started by GNU MCU Eclipse}"`,
    `-c "source [find ${inp.openocdTargetCfg}]"`,
    `-c "cat1d.cm33 configure -rtos auto -rtos-wipe-on-reset-halt 1"`,
    `-c "gdb_breakpoint_override hard"`,
  ].join('\r\n');
}

/**
 * Renders an OpenOCD GDB attach `.launch` file for the given target.
 * Attaches to an already-running target without flashing.
 */
export function renderAttachLaunch(inp: LaunchConfigInput, primary: LaunchTarget): string {
  const I = '    ';
  const II = '        ';

  const programPath = elfPath(inp, primary.baseName);
  const imgPath = hexPath(inp, primary.baseName);
  const svdArg = inp.svdRelPath ? `${projectLoc(inp)}/${inp.svdRelPath}` : '';
  const core = coreNameForTarget(primary);
  const runCmds = `monitor reset_halt ${core} attach\r\nflushregs\r\nmon gdb_sync\r\nthread apply all stepi`;

  const memoryBlocksXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\r\n' +
    '<memoryBlockExpressionList context="Context string"/>\r\n';

  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>`,
    `<launchConfiguration type="ilg.gnumcueclipse.debug.gdbjtag.openocd.launchConfigurationType">`,
    I + boolAttr('com.cypress.studio.launch.hide', true),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.doContinue', false),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.doDebugInRam', false),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.doFirstReset', false),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.doGdbServerAllocateConsole', true),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.doGdbServerAllocateTelnetConsole', false),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.doSecondReset', false),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.doStartGdbCLient', true),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.doStartGdbServer', true),
    I + boolAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.enableSemihosting', true),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.firstResetType', 'init'),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbClientOtherCommands',
      'set mem inaccessible-by-default off\r\nset remotetimeout 60'),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbClientOtherOptions', ''),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerConnectionAddress', ''),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerExecutable', 'openocd'),
    I + intAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerGdbPortNumber', 3333),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerLog', ''),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerOther',
      buildOpenocdAttachServerOther(inp)),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerTclPortNumber', '6666'),
    I + intAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerTelnetPortNumber', 4444),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.otherInitCommands', ''),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.otherRunCommands', runCmds),
    I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.openocd.secondResetType', 'run'),
    ...(svdArg ? [I + xmlAttr('ilg.gnumcueclipse.debug.gdbjtag.svdPath', svdArg)] : []),
    I + xmlAttr('org.eclipse.cdt.debug.gdbjtag.core.imageFileName', imgPath),
    I + xmlAttr('org.eclipse.cdt.debug.gdbjtag.core.imageOffset', ''),
    I + xmlAttr('org.eclipse.cdt.debug.gdbjtag.core.ipAddress', 'localhost'),
    I + xmlAttr('org.eclipse.cdt.debug.gdbjtag.core.jtagDevice', 'GNU MCU OpenOCD'),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.loadImage', false),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.loadSymbols', true),
    I + xmlAttr('org.eclipse.cdt.debug.gdbjtag.core.pcRegister', ''),
    I + intAttr('org.eclipse.cdt.debug.gdbjtag.core.portNumber', 3333),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.setPcRegister', false),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.setResume', false),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.setStopAt', true),
    I + xmlAttr('org.eclipse.cdt.debug.gdbjtag.core.stopAt', 'main'),
    I + xmlAttr('org.eclipse.cdt.debug.gdbjtag.core.symbolsFileName', programPath),
    I + xmlAttr('org.eclipse.cdt.debug.gdbjtag.core.symbolsOffset', ''),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.useFileForImage', true),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.useFileForSymbols', true),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.useProjBinaryForImage', false),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.useProjBinaryForSymbols', false),
    I + boolAttr('org.eclipse.cdt.debug.gdbjtag.core.useRemoteTarget', true),
    I + xmlAttr('org.eclipse.cdt.dsf.gdb.DEBUG_NAME', 'arm-none-eabi-gdb'),
    I + boolAttr('org.eclipse.cdt.dsf.gdb.UPDATE_THREADLIST_ON_SUSPEND', false),
    I + intAttr('org.eclipse.cdt.launch.ATTR_BUILD_BEFORE_LAUNCH_ATTR', 0),
    I + xmlAttr('org.eclipse.cdt.launch.COREFILE_PATH', ''),
    I + xmlAttr('org.eclipse.cdt.launch.PROGRAM_NAME', programPath),
    I + xmlAttr('org.eclipse.cdt.launch.PROJECT_ATTR', inp.projectName),
    I + boolAttr('org.eclipse.cdt.launch.PROJECT_BUILD_CONFIG_AUTO_ATTR', false),
    // PROJECT_BUILD_CONFIG_ID_ATTR is intentionally absent in attach configs
    I + boolAttr('org.eclipse.debug.core.ATTR_FORCE_SYSTEM_CONSOLE_ENCODING', false),
    `${I}<listAttribute key="org.eclipse.debug.core.MAPPED_RESOURCE_PATHS">`,
    `${II}<listEntry value="/${xmlEscape(inp.projectName)}"/>`,
    `${I}</listAttribute>`,
    `${I}<listAttribute key="org.eclipse.debug.core.MAPPED_RESOURCE_TYPES">`,
    `${II}<listEntry value="4"/>`,
    `${I}</listAttribute>`,
    // favoriteGroups is intentionally absent in attach configs
    I + xmlAttr('org.eclipse.dsf.launch.MEMORY_BLOCKS', memoryBlocksXml),
    I + xmlAttr('process_factory_id', 'org.eclipse.cdt.dsf.gdb.GdbProcessFactory'),
    `</launchConfiguration>`,
    '',
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// File-name helpers
// ---------------------------------------------------------------------------

export function debugLaunchFileName(projectName: string, baseName: string): string {
  return `${projectName}.${baseName} Debug (KitProg3_MiniProg4).launch`;
}

export function attachLaunchFileName(projectName: string, baseName: string): string {
  return `${projectName}.${baseName} Attach (KitProg3_MiniProg4).launch`;
}

export function groupDebugLaunchFileName(projectName: string): string {
  return `${projectName} Debug MultiCore (KitProg3_MiniProg4).launch`;
}

export const programLaunchFileName = 'Advanced KitProg3 Programming.launch';
