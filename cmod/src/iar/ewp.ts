/**
 * Generates an IAR Embedded Workbench project file (.ewp) from a flattened
 * view of one executable target's sources / defines / includes / link info.
 *
 * The generated file is intentionally minimal — it provides enough structure
 * for IAR EWB to load it, show all source files, and pick up the include
 * paths and preprocessor defines so an initial build can be attempted. Many
 * fine-grained tool options are left at IAR defaults and may need
 * project-specific tuning afterwards.
 */
import { renderOption, xmlEscape, type IarOption } from "./xml.js";

export interface IarFileEntry {
  /** Path relative to project dir, using forward slashes. Will be prefixed with $PROJ_DIR$. */
  projectRelPath: string;
  /** Optional logical group name (e.g. "Source Files"). */
  group?: string;
}

export interface IarEwpInput {
  projectName: string;
  /** "Cortex-M33", "Cortex-M55", etc. */
  cpuVariant: string;
  /** Final output ELF/HEX filename. */
  outputFile: string;
  defines: string[];
  includePaths: string[]; // already in $PROJ_DIR$-relative or absolute form
  files: IarFileEntry[];
  /**
   * Full IAR chip-selector entry for device-based target selection, e.g.
   * "PSE846GPS2DBZC4AM33\tInfineon PSE846GPS2DBZC4AM33".
   * When present the project uses device mode (OGCoreOrChip=0);
   * when absent it falls back to core mode (OGCoreOrChip=1).
   */
  chipMenuEntry?: string;
  /** Optional extra compiler flag fragments (e.g. -mfpu, -ffunction-sections). Best-effort only. */
  extraCFlags?: string[];
  /** Optional linker flag fragments. Best-effort only. */
  extraLinkFlags?: string[];
  /**
   * When true, sets Library Configuration to Full and enables thread support.
   * Set this when the project includes the clib-support asset.
   */
  useClibSupport?: boolean;
  /** Pre-build command to run before the build step (e.g. a sign/combine tool). */
  buildActionCommand?: string;
  /**
   * When true, enables the OutputConverter to produce an Intel Extended hex
   * file alongside the ELF. The hex filename is derived from outputFile with
   * the .elf extension replaced by .hex.
   */
  generateHex?: boolean;
  /** Absolute path to the linker configuration file (ICF). When set, overrides
   * the device-default ICF used by the IAR IDE. */
  icfFile?: string;
  /** Resolved path for the CMSE import library output (--import_cmse_lib_out).
   * When set, configures IlinkTrustzoneImportLibraryOut instead of placing
   * the flag in extra options (which would conflict with IAR's native setting). */
  cmseLibOut?: string;
}

interface FileTree {
  files: string[];
  groups: Map<string, FileTree>;
}

function newTree(): FileTree {
  return { files: [], groups: new Map() };
}

function insertFile(tree: FileTree, groupPath: string[], file: string): void {
  if (groupPath.length === 0) {
    tree.files.push(file);
    return;
  }
  const [head, ...rest] = groupPath;
  let child = tree.groups.get(head);
  if (!child) {
    child = newTree();
    tree.groups.set(head, child);
  }
  insertFile(child, rest, file);
}

function renderTree(tree: FileTree, indent: string): string {
  const lines: string[] = [];
  for (const f of tree.files.sort()) {
    lines.push(`${indent}<file>`);
    lines.push(`${indent}  <name>${xmlEscape(f)}</name>`);
    lines.push(`${indent}</file>`);
  }
  for (const [name, child] of [...tree.groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${indent}<group>`);
    lines.push(`${indent}  <name>${xmlEscape(name)}</name>`);
    lines.push(renderTree(child, indent + "  "));
    lines.push(`${indent}</group>`);
  }
  return lines.join("\n");
}

/** Mapping from IAR CPU name to CoreVariant state index (11 + visible_index). */
const CORE_VARIANT: Record<string, number> = {
  "Cortex-M0":   11,
  "Cortex-M0+":  12,
  "Cortex-M1":   13,
  "Cortex-MS1":  14,
  "Cortex-M3":   15,
  "Cortex-M4":   16,
  "Cortex-M4F":  17,
  "Cortex-M7":   18,
  "Cortex-M23":  37,
  "Cortex-M33":  38,
  "Cortex-M35P": 39,
  "Cortex-M52":  40,
  "Cortex-M55":  41,
  "Cortex-M85":  42,
};

function generalSettings(input: IarEwpInput): string {
  const { cpuVariant: cpu, chipMenuEntry, useClibSupport } = input;
  const cvState = String(CORE_VARIANT[cpu] ?? CORE_VARIANT["Cortex-M33"]);
  const libSelect = useClibSupport ? "2" : "1";
  const opts: IarOption[] = [
    { name: "FPU64", states: ["1"] },
    { name: "BrowseInfoPath", states: ["Debug/BrowseInfo"] },
    { name: "OGProductVersion", states: ["9.70.2.0"] },
    { name: "ExePath", states: ["Debug/Exe"] },
    { name: "ObjPath", states: ["Debug/Obj"] },
    { name: "ListPath", states: ["Debug/List"] },
    { name: "GEndianMode", states: ["0"] },
    { name: "Input description", states: [""] },
    { name: "Output description", states: [""] },
    { name: "GOutputBinary", states: ["0"] },
    { name: "OGCoreOrChip", states: [chipMenuEntry ? "1" : "0"] },
    { name: "GRuntimeLibSelect", version: 0, states: [libSelect] },
    { name: "GRuntimeLibSelectSlave", version: 0, states: [libSelect] },
    { name: "RTDescription", states: ["Use the normal configuration of the C/C++ runtime library."] },
    { name: "OGLastSavedByProductVersion", states: ["9.70.2.500"] },
    { name: "OGChipSelectEditMenu", states: [chipMenuEntry ?? `${cpu}\tNone`] },
    { name: "GenLowLevelInterface", states: ["1"] },
    { name: "GEndianModeBE", states: ["1"] },
    { name: "OGBufferedTerminalOutput", states: ["0"] },
    { name: "GenStdoutInterface", states: ["0"] },
    { name: "RTConfigPath2", states: [""] },
    { name: "GBECoreSlave", version: 35, states: [cvState] },
    { name: "OGUseCmsis", states: ["0"] },
    { name: "OGUseCmsisDspLib", states: ["0"] },
    { name: "GRuntimeLibThreads", states: [useClibSupport ? "1" : "0"] },
    { name: "CoreVariant", version: 35, states: [cvState] },
    { name: "GFPUDeviceSlave", states: [""] },
    { name: "FPU2", version: 0, states: ["0"] },
    { name: "NrRegs", version: 0, states: ["0"] },
    { name: "NEON", states: ["0"] },
    { name: "GFPUCoreSlave2", version: 35, states: [cvState] },
    { name: "OGCMSISPackSelectDevice" },
    { name: "OgLibHeap", states: ["0"] },
    { name: "OGLibAdditionalLocale", states: ["0"] },
    { name: "OGPrintfVariant", version: 0, states: ["1"] },
    { name: "OGPrintfMultibyteSupport", states: ["0"] },
    { name: "OGScanfVariant", version: 0, states: ["1"] },
    { name: "OGScanfMultibyteSupport", states: ["0"] },
    { name: "GenLocaleTags", states: [""] },
    { name: "GenLocaleDisplayOnly", states: [""] },
    { name: "DSPExtension", states: ["0"] },
    { name: "TrustZone", states: ["0"] },
    { name: "TrustZoneModes", version: 0, states: ["0"] },
    { name: "OGAarch64Abi", states: ["0"] },
    { name: "OG_32_64Device", states: ["0"] },
    { name: "BuildFilesPath", states: ["Debug"] },
    { name: "PointerAuthentication", states: ["0"] },
    { name: "OG_32_64DeviceCoreSlave", version: 35, states: ["38"] },
    { name: "GOutputSo", states: ["0"] },
  ];
  return [
    "    <settings>",
    "      <name>General</name>",
    "      <archiveVersion>3</archiveVersion>",
    "      <data>",
    "        <version>37</version>",
    "        <wantNonLocal>1</wantNonLocal>",
    "        <debug>1</debug>",
    opts.map((o) => renderOption(o, "        ")).join("\n"),
    "      </data>",
    "    </settings>",
  ].join("\n");
}

function iccarmSettings(defines: string[], includes: string[]): string {
  const opts: IarOption[] = [
    { name: "CCOptimizationNoSizeConstraints", states: ["0"] },
    { name: "CCDefines", states: defines },
    { name: "CCPreprocFile", states: ["0"] },
    { name: "CCPreprocComments", states: ["0"] },
    { name: "CCPreprocLine", states: ["0"] },
    { name: "CCListCFile", states: ["0"] },
    { name: "CCListCMnemonics", states: ["0"] },
    { name: "CCListCMessages", states: ["0"] },
    { name: "CCListAssFile", states: ["0"] },
    { name: "CCListAssSource", states: ["0"] },
    { name: "CCEnableRemarks", states: ["0"] },
    { name: "CCDiagSuppress", states: [""] },
    { name: "CCDiagRemark", states: [""] },
    { name: "CCDiagWarning", states: [""] },
    { name: "CCDiagError", states: [""] },
    { name: "CCObjPrefix", states: ["1"] },
    { name: "CCAllowList", version: 1, states: ["11111110"] },
    { name: "CCDebugInfo", states: ["1"] },
    { name: "IEndianMode", states: ["1"] },
    { name: "IProcessor", states: ["1"] },
    { name: "IExtraOptionsCheck", states: ["0"] },
    { name: "IExtraOptions", states: [""] },
    { name: "CCLangConformance", states: ["0"] },
    { name: "CCSignedPlainChar", states: ["1"] },
    { name: "CCRequirePrototypes", states: ["0"] },
    { name: "CCDiagWarnAreErr", states: ["0"] },
    { name: "CCCompilerRuntimeInfo", states: ["0"] },
    { name: "IFpuProcessor", states: ["1"] },
    { name: "OutputFile", states: [""] },
    { name: "CCLibConfigHeader", states: ["1"] },
    { name: "PreInclude", states: [""] },
    { name: "CCIncludePath2", states: includes },
    { name: "CCStdIncCheck", states: ["0"] },
    { name: "CCCodeSection", states: [".text"] },
    { name: "IProcessorMode2", states: ["1"] },
    { name: "CCOptLevel", states: ["1"] },
    { name: "CCOptStrategy", version: 0, states: ["0"] },
    { name: "CCOptLevelSlave", states: ["1"] },
    { name: "CCPosIndRopi", states: ["0"] },
    { name: "CCPosIndRwpi", states: ["0"] },
    { name: "CCPosIndNoDynInit", states: ["0"] },
    { name: "IccLang", states: ["0"] },
    { name: "IccCDialect", states: ["1"] },
    { name: "IccAllowVLA", states: ["0"] },
    { name: "IccStaticDestr", states: ["1"] },
    { name: "IccCppInlineSemantics", states: ["0"] },
    { name: "IccCmsis", states: ["1"] },
    { name: "IccFloatSemantics", states: ["0"] },
    { name: "CCNoLiteralPool", states: ["0"] },
    { name: "CCOptStrategySlave", version: 0, states: ["0"] },
    { name: "CCGuardCalls", states: ["1"] },
    { name: "CCEncSource", states: ["0"] },
    { name: "CCEncOutput", states: ["0"] },
    { name: "CCEncOutputBom", states: ["1"] },
    { name: "CCEncInput", states: ["0"] },
    { name: "IccExceptions2", states: ["0"] },
    { name: "IccRTTI2", states: ["0"] },
    { name: "OICompilerExtraOption", states: ["1"] },
    { name: "CCStackProtection", states: ["0"] },
    { name: "CCPointerAutentiction", states: ["0"] },
    { name: "CCBranchTargetIdentification", states: ["0"] },
    { name: "CCPosRadRwpi", states: ["0"] },
    { name: "CCPosSharedSlave", states: ["0"] },
    { name: "CCUseIarExtensions", states: ["1"] },
    { name: "CCUseGnuExtensions", states: ["0"] },
  ];
  return [
    "    <settings>",
    "      <name>ICCARM</name>",
    "      <archiveVersion>2</archiveVersion>",
    "      <data>",
    "        <version>40</version>",
    "        <wantNonLocal>1</wantNonLocal>",
    "        <debug>1</debug>",
    opts.map((o) => renderOption(o, "        ")).join("\n"),
    "      </data>",
    "    </settings>",
  ].join("\n");
}

function aarmSettings(defines: string[], includes: string[]): string {
  const opts: IarOption[] = [
    { name: "AObjPrefix", states: ["1"] },
    { name: "AEndian", states: ["1"] },
    { name: "ACaseSensitivity", states: ["1"] },
    { name: "MacroChars", version: 0, states: ["0"] },
    { name: "AWarnEnable", states: ["0"] },
    { name: "AWarnWhat", states: ["0"] },
    { name: "AWarnOne", states: [""] },
    { name: "AWarnRange1", states: [""] },
    { name: "AWarnRange2", states: [""] },
    { name: "ADebug", states: ["1"] },
    { name: "AltRegisterNames", states: ["0"] },
    { name: "ADefines", states: defines },
    { name: "AList", states: ["0"] },
    { name: "AListHeader", states: ["1"] },
    { name: "AListing", states: ["1"] },
    { name: "Includes", states: ["0"] },
    { name: "MacDefs", states: ["0"] },
    { name: "MacExps", states: ["1"] },
    { name: "MacExec", states: ["0"] },
    { name: "OnlyAssed", states: ["0"] },
    { name: "MultiLine", states: ["0"] },
    { name: "PageLengthCheck", states: ["0"] },
    { name: "PageLength", states: ["80"] },
    { name: "TabSpacing", states: ["8"] },
    { name: "AXRef", states: ["0"] },
    { name: "AXRefDefines", states: ["0"] },
    { name: "AXRefInternal", states: ["0"] },
    { name: "AXRefDual", states: ["0"] },
    { name: "AProcessor", states: ["1"] },
    { name: "AFpuProcessor", states: ["1"] },
    { name: "AOutputFile", states: [""] },
    { name: "ALimitErrorsCheck", states: ["0"] },
    { name: "ALimitErrorsEdit", states: ["100"] },
    { name: "AIgnoreStdInclude", states: ["0"] },
    { name: "AUserIncludes", states: includes },
    { name: "AExtraOptionsCheckV2", states: ["0"] },
    { name: "AExtraOptionsV2", states: [""] },
    { name: "AsmNoLiteralPool", states: ["0"] },
    { name: "PreInclude", states: [""] },
    { name: "A_32_64Device", states: ["1"] },
  ];
  return [
    "    <settings>",
    "      <name>AARM</name>",
    "      <archiveVersion>2</archiveVersion>",
    "      <data>",
    "        <version>12</version>",
    "        <wantNonLocal>1</wantNonLocal>",
    "        <debug>1</debug>",
    opts.map((o) => renderOption(o, "        ")).join("\n"),
    "      </data>",
    "    </settings>",
  ].join("\n");
}

function ilinkSettings(outputFile: string, extraLinkFlags: string[] = [], icfFile?: string, cmseLibOut?: string): string {
  const opts: IarOption[] = [
    { name: "IlinkOutputFile", states: [outputFile] },
    { name: "IlinkLibIOConfig", states: ["1"] },
    { name: "IlinkInputFileSlave", states: ["0"] },
    { name: "IlinkDebugInfoEnable", states: ["1"] },
    { name: "IlinkKeepSymbols", states: [""] },
    { name: "IlinkRawBinaryFile", states: [""] },
    { name: "IlinkRawBinarySymbol", states: [""] },
    { name: "IlinkRawBinarySegment", states: [""] },
    { name: "IlinkRawBinaryAlign", states: [""] },
    { name: "IlinkDefines", states: [""] },
    { name: "IlinkConfigDefines", states: [""] },
    { name: "IlinkMapFile", states: ["1"] },
    { name: "IlinkLogFile", states: ["0"] },
    { name: "IlinkLogInitialization", states: ["0"] },
    { name: "IlinkLogModule", states: ["0"] },
    { name: "IlinkLogSection", states: ["0"] },
    { name: "IlinkLogVeneer", states: ["0"] },
    { name: "IlinkIcfOverride", states: [icfFile ? "1" : "0"] },
    { name: "IlinkIcfFile", states: [icfFile ?? ""] },
    { name: "IlinkIcfFileSlave", states: [""] },
    { name: "IlinkEnableRemarks", states: ["0"] },
    { name: "IlinkSuppressDiags", states: [""] },
    { name: "IlinkTreatAsRem", states: [""] },
    { name: "IlinkTreatAsWarn", states: [""] },
    { name: "IlinkTreatAsErr", states: [""] },
    { name: "IlinkWarningsAreErrors", states: ["0"] },
    { name: "IlinkUseExtraOptions", states: [extraLinkFlags.length > 0 ? "1" : "0"] },
    { name: "IlinkExtraOptions", states: extraLinkFlags.length > 0 ? extraLinkFlags : [""] },
    { name: "IlinkLowLevelInterfaceSlave", states: ["1"] },
    { name: "IlinkAutoLibEnable", states: ["1"] },
    { name: "IlinkAdditionalLibs", states: [""] },
    { name: "IlinkOverrideProgramEntryLabel", states: ["0"] },
    { name: "IlinkProgramEntryLabelSelect", states: ["0"] },
    { name: "IlinkProgramEntryLabel", states: ["__iar_program_start"] },
    { name: "DoFill", states: ["0"] },
    { name: "FillerByte", states: ["0xFF"] },
    { name: "FillerStart", states: ["0x0"] },
    { name: "FillerEnd", states: ["0x0"] },
    { name: "CrcSize", version: 0, states: ["1"] },
    { name: "CrcAlign", states: ["1"] },
    { name: "CrcPoly", states: ["0x11021"] },
    { name: "CrcCompl", version: 0, states: ["0"] },
    { name: "CrcBitOrder", version: 0, states: ["0"] },
    { name: "CrcInitialValue", states: ["0x0"] },
    { name: "DoCrc", states: ["0"] },
    { name: "IlinkBE8Slave", states: ["1"] },
    { name: "IlinkBufferedTerminalOutput", states: ["1"] },
    { name: "IlinkStdoutInterfaceSlave", states: ["1"] },
    { name: "CrcFullSize", states: ["0"] },
    { name: "IlinkIElfToolPostProcess", states: ["0"] },
    { name: "IlinkLogAutoLibSelect", states: ["0"] },
    { name: "IlinkLogRedirSymbols", states: ["0"] },
    { name: "IlinkLogUnusedFragments", states: ["0"] },
    { name: "IlinkCrcReverseByteOrder", states: ["0"] },
    { name: "IlinkCrcUseAsInput", states: ["1"] },
    { name: "IlinkOptInline", states: ["0"] },
    { name: "IlinkOptExceptionsAllow", states: ["1"] },
    { name: "IlinkOptExceptionsForce", states: ["0"] },
    { name: "IlinkCmsis", states: ["1"] },
    { name: "IlinkOptMergeDuplSections", states: ["0"] },
    { name: "IlinkOptUseVfe", states: ["1"] },
    { name: "IlinkOptForceVfe", states: ["0"] },
    { name: "IlinkStackAnalysisEnable", states: ["0"] },
    { name: "IlinkStackControlFile", states: [""] },
    { name: "IlinkStackCallGraphFile", states: [""] },
    { name: "CrcAlgorithm", version: 1, states: ["1"] },
    { name: "CrcUnitSize", version: 0, states: ["0"] },
    { name: "IlinkThreadsSlave", states: ["1"] },
    { name: "IlinkLogCallGraph", states: ["0"] },
    { name: "IlinkIcfFile_AltDefault", states: [""] },
    { name: "IlinkEncInput", states: ["0"] },
    { name: "IlinkEncOutput", states: ["0"] },
    { name: "IlinkEncOutputBom", states: ["1"] },
    { name: "IlinkHeapSelect", states: ["1"] },
    { name: "IlinkLocaleSelect", states: ["1"] },
    { name: "IlinkTrustzoneImportLibraryOut", states: [cmseLibOut ?? "###Unitialized###"] },
    { name: "OILinkExtraOption", states: ["1"] },
    { name: "IlinkRawBinaryFile2", states: [""] },
    { name: "IlinkRawBinarySymbol2", states: [""] },
    { name: "IlinkRawBinarySegment2", states: [""] },
    { name: "IlinkRawBinaryAlign2", states: [""] },
    { name: "IlinkLogCrtRoutineSelection", states: ["0"] },
    { name: "IlinkLogFragmentInfo", states: ["0"] },
    { name: "IlinkLogInlining", states: ["0"] },
    { name: "IlinkLogMerging", states: ["0"] },
    { name: "IlinkDemangle", states: ["0"] },
    { name: "IlinkWrapperFileEnable", states: ["0"] },
    { name: "IlinkWrapperFile", states: [""] },
    { name: "IlinkProcessor", states: ["1"] },
    { name: "IlinkFpuProcessor", states: ["1"] },
    { name: "IlinkSharedSlave", states: ["0"] },
  ];
  return [
    "    <settings>",
    "      <name>ILINK</name>",
    "      <archiveVersion>0</archiveVersion>",
    "      <data>",
    "        <version>28</version>",
    "        <wantNonLocal>1</wantNonLocal>",
    "        <debug>1</debug>",
    opts.map((o) => renderOption(o, "        ")).join("\n"),
    "      </data>",
    "    </settings>",
  ].join("\n");
}

function objcopySettings(hexFile?: string): string {
  const enabled = hexFile !== undefined;
  const opts: IarOption[] = [
    { name: "OOCOutputFormat", version: 3, states: [enabled ? "1" : "0"] }, // 1 = Intel Extended
    { name: "OCOutputOverride", states: [enabled ? "1" : "0"] },
    { name: "OOCOutputFile", states: [hexFile ?? ""] },
    { name: "OOCCommandLineProducer", states: ["1"] },
    { name: "OOCObjCopyEnable", states: [enabled ? "1" : "0"] },
  ];
  return [
    "    <settings>",
    "      <name>OBJCOPY</name>",
    "      <archiveVersion>0</archiveVersion>",
    "      <data>",
    "        <version>1</version>",
    "        <wantNonLocal>1</wantNonLocal>",
    "        <debug>1</debug>",
    opts.map((o) => renderOption(o, "        ")).join("\n"),
    "      </data>",
    "    </settings>",
  ].join("\n");
}

function customSettings(): string {
  return [
    "    <settings>",
    "      <name>CUSTOM</name>",
    "      <archiveVersion>4</archiveVersion>",
    "      <data>",
    "        <extensions/>",
    "        <cmdline/>",
    "        <buildSequence>inputOutputBased</buildSequence>",
    "      </data>",
    "    </settings>",
  ].join("\n");
}

function buildactionSettings(command?: string): string {
  if (!command) {
    return [
      "    <settings>",
      "      <name>BUILDACTION</name>",
      "      <archiveVersion>2</archiveVersion>",
      "      <data/>",
      "    </settings>",
    ].join("\n");
  }
  return [
    "    <settings>",
    "      <name>BUILDACTION</name>",
    "      <archiveVersion>2</archiveVersion>",
    "      <data>",
    `        <prebuild>${xmlEscape(command)}</prebuild>`,
    "        <postbuild></postbuild>",
    "      </data>",
    "    </settings>",
  ].join("\n");
}

function iarchiveSettings(): string {
  const opts: IarOption[] = [
    { name: "IarchiveInputs", states: [""] },
    { name: "IarchiveOverride", states: ["0"] },
    { name: "IarchiveOutput", states: ["###Unitialized###"] },
    { name: "IarchiveExtraOptionsCheck", states: ["0"] },
    { name: "IarchiveExtraOptions", states: [""] },
  ];
  return [
    "    <settings>",
    "      <name>IARCHIVE</name>",
    "      <archiveVersion>0</archiveVersion>",
    "      <data>",
    "        <version>1</version>",
    "        <wantNonLocal>1</wantNonLocal>",
    "        <debug>1</debug>",
    opts.map((o) => renderOption(o, "        ")).join("\n"),
    "      </data>",
    "    </settings>",
  ].join("\n");
}

export function renderEwp(input: IarEwpInput): string {
  const tree = newTree();
  for (const f of input.files) {
    const groupPath = (f.group ?? "Source Files").split("/").filter(Boolean);
    insertFile(tree, groupPath, `$PROJ_DIR$/${f.projectRelPath}`);
  }

  const config = [
    "  <configuration>",
    "    <name>Debug</name>",
    "    <toolchain><name>ARM</name></toolchain>",
    "    <debug>1</debug>",
    generalSettings(input),
    iccarmSettings(input.defines, input.includePaths),
    aarmSettings(input.defines, input.includePaths),
    objcopySettings(input.generateHex ? `${input.projectName}.hex` : undefined),
    customSettings(),
    ilinkSettings(input.outputFile, input.extraLinkFlags ?? [], input.icfFile, input.cmseLibOut),
    iarchiveSettings(),
    buildactionSettings(input.buildActionCommand),
    "  </configuration>",
  ].join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<project>`,
    `  <fileVersion>4</fileVersion>`,
    config,
    renderTree(tree, "  "),
    `</project>`,
    "",
  ].join("\n");
}
