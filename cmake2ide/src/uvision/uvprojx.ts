/**
 * Generates a Keil µVision project file (.uvprojx) from a flattened view of
 * one executable target's sources / defines / includes / link info.
 *
 * The generated file targets ARM Compiler 6 (ARMCLANG / AC6) and is
 * intentionally minimal: it provides enough structure for µVision to load,
 * show all source files, and pick up include paths and preprocessor defines
 * so an initial build can be attempted.  Many fine-grained settings are left
 * at µVision defaults and may require project-specific tuning afterwards.
 */
import path from "node:path";
import { xmlEscape } from "./xml.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Keil file-type codes used in <FileType>. */
export const enum UVisionFileType {
  C        = 1,
  Assembly = 2,
  Object   = 3,
  Library  = 4,
  Document = 5,
  Linker   = 7,
  Generic  = 8,
  CppSrc   = 9,
}

export interface UVisionFileEntry {
  /** Basename of the file (e.g. "main.c"). */
  fileName: string;
  /** Keil file-type code. */
  fileType: UVisionFileType;
  /** Path relative to the .uvprojx file, forward slashes (e.g. "./src/main.c"). */
  filePath: string;
  /** Optional logical group name (e.g. "Source Files/app"). */
  group?: string;
}

export interface UVisionProjectInput {
  /** Project name (used as target name and output filename). */
  projectName: string;
  /**
   * CPU variant string, e.g. "Cortex-M33", "Cortex-M4", "Cortex-M0+".
   * Controls the <Device>, DLL arguments, and CPU descriptor.
   */
  cpuVariant: string;
  /** Preprocessor defines (each a plain string, no -D prefix). */
  defines: string[];
  /**
   * Include paths, already expressed relative to the .uvprojx file or
   * as absolute paths, using forward slashes.
   */
  includePaths: string[];
  files: UVisionFileEntry[];
  /**
   * Scatter file path (relative to .uvprojx or absolute).
   * When provided, <useFile> is set to 1 and <ScatterFile> is populated.
   */
  scatterFile?: string;
  /** Extra misc linker flags that cannot be translated natively. */
  miscLinker?: string;
  /** Extra misc compiler flags that cannot be translated natively. */
  miscCompiler?: string;
}

// ---------------------------------------------------------------------------
// CPU tables
// ---------------------------------------------------------------------------

interface CpuProfile {
  /** Generic CMSIS device name used as the fallback <Device> value. */
  device: string;
  /** Vendor string. */
  vendor: string;
  /** Full CPU descriptor for the <Cpu> element (memory regions are generic). */
  cpuDesc: string;
  /** Argument to the simulator DLL dialog DLL (e.g. "-pCM33"). */
  simDlgArg: string;
  /** Argument to the target DLL dialog DLL. */
  tgtDlgArg: string;
}

const CPU_PROFILES: Record<string, CpuProfile> = {
  "Cortex-M0": {
    device: "ARMCM0",
    vendor: "ARM",
    cpuDesc: 'IROM(0x00000000,0x20000) IRAM(0x20000000,0x4000) CPUTYPE("Cortex-M0") CLOCK(12000000) ELITTLE',
    simDlgArg: "-pCM0",
    tgtDlgArg: "-pCM0",
  },
  "Cortex-M0+": {
    device: "ARMCM0P",
    vendor: "ARM",
    cpuDesc: 'IROM(0x00000000,0x20000) IRAM(0x20000000,0x4000) CPUTYPE("Cortex-M0+") CLOCK(12000000) ELITTLE',
    simDlgArg: "-pCM0P",
    tgtDlgArg: "-pCM0P",
  },
  "Cortex-M1": {
    device: "ARMCM1",
    vendor: "ARM",
    cpuDesc: 'IROM(0x00000000,0x20000) IRAM(0x20000000,0x4000) CPUTYPE("Cortex-M1") CLOCK(12000000) ELITTLE',
    simDlgArg: "-pCM1",
    tgtDlgArg: "-pCM1",
  },
  "Cortex-M3": {
    device: "ARMCM3",
    vendor: "ARM",
    cpuDesc: 'IROM(0x00000000,0x40000) IRAM(0x20000000,0x8000) CPUTYPE("Cortex-M3") CLOCK(12000000) ELITTLE',
    simDlgArg: "-pCM3",
    tgtDlgArg: "-pCM3",
  },
  "Cortex-M4": {
    device: "ARMCM4",
    vendor: "ARM",
    cpuDesc: 'IROM(0x00000000,0x80000) IRAM(0x20000000,0x10000) CPUTYPE("Cortex-M4") CLOCK(12000000) ELITTLE',
    simDlgArg: "-pCM4",
    tgtDlgArg: "-pCM4",
  },
  "Cortex-M4F": {
    device: "ARMCM4FP",
    vendor: "ARM",
    cpuDesc: 'IROM(0x00000000,0x80000) IRAM(0x20000000,0x10000) CPUTYPE("Cortex-M4") FPU2 CLOCK(12000000) ELITTLE',
    simDlgArg: "-pCM4FP",
    tgtDlgArg: "-pCM4FP",
  },
  "Cortex-M7": {
    device: "ARMCM7",
    vendor: "ARM",
    cpuDesc: 'IROM(0x00000000,0x100000) IRAM(0x20000000,0x20000) CPUTYPE("Cortex-M7") CLOCK(12000000) ELITTLE',
    simDlgArg: "-pCM7",
    tgtDlgArg: "-pCM7",
  },
  "Cortex-M7F": {
    device: "ARMCM7FP",
    vendor: "ARM",
    cpuDesc: 'IROM(0x00000000,0x100000) IRAM(0x20000000,0x20000) CPUTYPE("Cortex-M7") FPU2 CLOCK(12000000) ELITTLE',
    simDlgArg: "-pCM7DP",
    tgtDlgArg: "-pCM7DP",
  },
  "Cortex-M23": {
    device: "ARMCM23",
    vendor: "ARM",
    cpuDesc: 'IROM(0x00000000,0x40000) IRAM(0x20000000,0x8000) CPUTYPE("Cortex-M23") CLOCK(12000000) ELITTLE',
    simDlgArg: "-pCM23",
    tgtDlgArg: "-pCM23",
  },
  "Cortex-M33": {
    device: "ARMCM33",
    vendor: "ARM",
    cpuDesc: 'IROM(0x00000000,0x80000) IRAM(0x20000000,0x40000) CPUTYPE("Cortex-M33") FPU2 DSP CLOCK(12000000) ELITTLE',
    simDlgArg: "-pCM33",
    tgtDlgArg: "-pCM33",
  },
  "Cortex-M35P": {
    device: "ARMCM35P",
    vendor: "ARM",
    cpuDesc: 'IROM(0x00000000,0x80000) IRAM(0x20000000,0x40000) CPUTYPE("Cortex-M35P") FPU2 DSP CLOCK(12000000) ELITTLE',
    simDlgArg: "-pCM35P",
    tgtDlgArg: "-pCM35P",
  },
  "Cortex-M55": {
    device: "ARMCM55",
    vendor: "ARM",
    cpuDesc: 'IROM(0x00000000,0x100000) IRAM(0x20000000,0x80000) CPUTYPE("Cortex-M55") FPU2 DSP MVE CLOCK(12000000) ELITTLE',
    simDlgArg: "-pCM55",
    tgtDlgArg: "-pCM55",
  },
  "Cortex-M85": {
    device: "ARMCM85",
    vendor: "ARM",
    cpuDesc: 'IROM(0x00000000,0x100000) IRAM(0x20000000,0x80000) CPUTYPE("Cortex-M85") FPU2 DSP MVE CLOCK(12000000) ELITTLE',
    simDlgArg: "-pCM85",
    tgtDlgArg: "-pCM85",
  },
};

const DEFAULT_CPU_PROFILE = CPU_PROFILES["Cortex-M33"];

function cpuProfile(cpuVariant: string): CpuProfile {
  return CPU_PROFILES[cpuVariant] ?? DEFAULT_CPU_PROFILE;
}

// ---------------------------------------------------------------------------
// File tree (for building <Groups> with nested sub-groups)
// ---------------------------------------------------------------------------

interface FileNode {
  files: UVisionFileEntry[];
  groups: Map<string, FileNode>;
}

function newNode(): FileNode {
  return { files: [], groups: new Map() };
}

function insertFile(node: FileNode, groupPath: string[], entry: UVisionFileEntry): void {
  if (groupPath.length === 0) {
    node.files.push(entry);
    return;
  }
  const [head, ...rest] = groupPath;
  let child = node.groups.get(head);
  if (!child) {
    child = newNode();
    node.groups.set(head, child);
  }
  insertFile(child, rest, entry);
}

function renderGroups(node: FileNode, indent: string): string {
  const lines: string[] = [];

  // Render files at this level
  for (const f of node.files) {
    lines.push(`${indent}<File>`);
    lines.push(`${indent}  <FileName>${xmlEscape(f.fileName)}</FileName>`);
    lines.push(`${indent}  <FileType>${f.fileType}</FileType>`);
    lines.push(`${indent}  <FilePath>${xmlEscape(f.filePath)}</FilePath>`);
    lines.push(`${indent}</File>`);
  }

  // Render sub-groups (sorted for determinism)
  for (const [name, child] of [...node.groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${indent}<Group>`);
    lines.push(`${indent}  <GroupName>${xmlEscape(name)}</GroupName>`);
    lines.push(`${indent}  <Files>`);
    lines.push(renderGroups(child, indent + "    "));
    lines.push(`${indent}  </Files>`);
    lines.push(`${indent}</Group>`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Project rendering
// ---------------------------------------------------------------------------

export function renderUvprojx(input: UVisionProjectInput): string {
  const prof = cpuProfile(input.cpuVariant);
  const definesStr = xmlEscape(input.defines.join(","));
  const includeStr = xmlEscape(input.includePaths.join(";"));
  const scatterUse = input.scatterFile ? "1" : "0";
  const scatterPath = input.scatterFile ? xmlEscape(input.scatterFile) : "";
  const miscLinker = xmlEscape(input.miscLinker ?? "");
  const miscCompiler = xmlEscape(input.miscCompiler ?? "");

  // Build the file tree
  const root = newNode();
  for (const f of input.files) {
    const groupParts = f.group ? f.group.split("/") : [];
    insertFile(root, groupParts, f);
  }

  const groupsXml = renderGroups(root, "      ");

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>`,
    `<Project xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="project.xsd">`,
    `  <SchemaVersion>2.1</SchemaVersion>`,
    `  <Header>### uVision Project, (C) Keil Software</Header>`,
    `  <Targets>`,
    `    <Target>`,
    `      <TargetName>${xmlEscape(input.projectName)}</TargetName>`,
    `      <ToolsetNumber>0x4</ToolsetNumber>`,
    `      <ToolsetName>ARM-ADS</ToolsetName>`,
    `      <pCCUsed>6210000::V6.21::ARMCLANG</pCCUsed>`,
    `      <uAC6>1</uAC6>`,
    `      <TargetOption>`,
    `        <TargetCommonOption>`,
    `          <Device>${xmlEscape(prof.device)}</Device>`,
    `          <Vendor>${xmlEscape(prof.vendor)}</Vendor>`,
    `          <Cpu>${xmlEscape(prof.cpuDesc)}</Cpu>`,
    `          <FlashUtilSpec></FlashUtilSpec>`,
    `          <StartupFile></StartupFile>`,
    `          <FlashDriverDll></FlashDriverDll>`,
    `          <DeviceId>0</DeviceId>`,
    `          <RegisterFile></RegisterFile>`,
    `          <MemoryEnv></MemoryEnv>`,
    `          <Cmp></Cmp>`,
    `          <Asm></Asm>`,
    `          <Linker></Linker>`,
    `          <OHString></OHString>`,
    `          <InfinionOptionDll></InfinionOptionDll>`,
    `          <SLE66CMisc></SLE66CMisc>`,
    `          <SLE66AMisc></SLE66AMisc>`,
    `          <SLE66LinkerMisc></SLE66LinkerMisc>`,
    `          <SFDFile></SFDFile>`,
    `          <bCustSvd>0</bCustSvd>`,
    `          <UseEnv>0</UseEnv>`,
    `          <BinPath></BinPath>`,
    `          <IncludePath></IncludePath>`,
    `          <LibPath></LibPath>`,
    `          <RegisterFilePath></RegisterFilePath>`,
    `          <DBRegisterFilePath></DBRegisterFilePath>`,
    `          <TargetStatus>`,
    `            <Error>0</Error>`,
    `            <ExitCodeStop>0</ExitCodeStop>`,
    `            <ButtonStop>0</ButtonStop>`,
    `            <NotGenerated>0</NotGenerated>`,
    `            <InvalidFlash>1</InvalidFlash>`,
    `          </TargetStatus>`,
    `          <OutputDirectory>.\\Objects\\</OutputDirectory>`,
    `          <OutputName>${xmlEscape(input.projectName)}</OutputName>`,
    `          <CreateExecutable>1</CreateExecutable>`,
    `          <CreateLib>0</CreateLib>`,
    `          <CreateHexFile>1</CreateHexFile>`,
    `          <DebugInformation>1</DebugInformation>`,
    `          <BrowseInformation>0</BrowseInformation>`,
    `          <ListingPath>.\\Listings\\</ListingPath>`,
    `          <HexFormatSelection>1</HexFormatSelection>`,
    `          <Merge32K>0</Merge32K>`,
    `          <CreateBatchFile>0</CreateBatchFile>`,
    `          <BeforeCompile>`,
    `            <RunUserProg1>0</RunUserProg1>`,
    `            <RunUserProg2>0</RunUserProg2>`,
    `            <UserProg1Name></UserProg1Name>`,
    `            <UserProg2Name></UserProg2Name>`,
    `            <UserProg1Dos16Mode>0</UserProg1Dos16Mode>`,
    `            <UserProg2Dos16Mode>0</UserProg2Dos16Mode>`,
    `            <nStopU1X>0</nStopU1X>`,
    `            <nStopU2X>0</nStopU2X>`,
    `          </BeforeCompile>`,
    `          <BeforeMake>`,
    `            <RunUserProg1>0</RunUserProg1>`,
    `            <RunUserProg2>0</RunUserProg2>`,
    `            <UserProg1Name></UserProg1Name>`,
    `            <UserProg2Name></UserProg2Name>`,
    `            <UserProg1Dos16Mode>0</UserProg1Dos16Mode>`,
    `            <UserProg2Dos16Mode>0</UserProg2Dos16Mode>`,
    `            <nStopU1X>0</nStopU1X>`,
    `            <nStopU2X>0</nStopU2X>`,
    `          </BeforeMake>`,
    `          <AfterMake>`,
    `            <RunUserProg1>0</RunUserProg1>`,
    `            <RunUserProg2>0</RunUserProg2>`,
    `            <UserProg1Name></UserProg1Name>`,
    `            <UserProg2Name></UserProg2Name>`,
    `            <UserProg1Dos16Mode>0</UserProg1Dos16Mode>`,
    `            <UserProg2Dos16Mode>0</UserProg2Dos16Mode>`,
    `            <nStopU1X>0</nStopU1X>`,
    `            <nStopU2X>0</nStopU2X>`,
    `          </AfterMake>`,
    `          <SelectedForBatchBuild>0</SelectedForBatchBuild>`,
    `          <SVCSIdString></SVCSIdString>`,
    `        </TargetCommonOption>`,
    `        <CommonProperty>`,
    `          <UseCPPCompiler>0</UseCPPCompiler>`,
    `          <RVCTCodeConst>0</RVCTCodeConst>`,
    `          <RVCTZI>0</RVCTZI>`,
    `          <RVCTOtherData>0</RVCTOtherData>`,
    `          <ModuleSelection>0</ModuleSelection>`,
    `          <IncludeInBuild>1</IncludeInBuild>`,
    `          <AlwaysBuild>0</AlwaysBuild>`,
    `          <GenerateAssemblyFile>0</GenerateAssemblyFile>`,
    `          <AssembleAssemblyFile>0</AssembleAssemblyFile>`,
    `          <PublicsOnly>0</PublicsOnly>`,
    `          <StopOnExitCode>3</StopOnExitCode>`,
    `          <CustomArgument></CustomArgument>`,
    `          <IncludeLibraryModules></IncludeLibraryModules>`,
    `          <CompressionType>0</CompressionType>`,
    `        </CommonProperty>`,
    `        <DllOption>`,
    `          <SimDllName>SARMCM3.DLL</SimDllName>`,
    `          <SimDllArguments> -REMAP -MPU</SimDllArguments>`,
    `          <SimDlgDll>DCM.DLL</SimDlgDll>`,
    `          <SimDlgDllArguments>${xmlEscape(prof.simDlgArg)}</SimDlgDllArguments>`,
    `          <TargetDllName>SARMCM3.DLL</TargetDllName>`,
    `          <TargetDllArguments> -MPU</TargetDllArguments>`,
    `          <TargetDlgDll>TCM.DLL</TargetDlgDll>`,
    `          <TargetDlgDllArguments>${xmlEscape(prof.tgtDlgArg)}</TargetDlgDllArguments>`,
    `        </DllOption>`,
    `        <DebugOption>`,
    `          <OPTHX>`,
    `            <HexSelection>1</HexSelection>`,
    `            <HexRangeLowAddress>0</HexRangeLowAddress>`,
    `            <HexRangeHighAddress>0</HexRangeHighAddress>`,
    `            <HexOffset>0</HexOffset>`,
    `            <Oh166RecLen>16</Oh166RecLen>`,
    `          </OPTHX>`,
    `        </DebugOption>`,
    `        <Utilities>`,
    `          <Flash1>`,
    `            <UseTargetDll>1</UseTargetDll>`,
    `            <UseExternalTool>0</UseExternalTool>`,
    `            <RunIndependent>0</RunIndependent>`,
    `            <UpdateFlashBeforeDebugging>1</UpdateFlashBeforeDebugging>`,
    `            <Capability>1</Capability>`,
    `            <DriverSelection>4096</DriverSelection>`,
    `          </Flash1>`,
    `          <bUseTDR>1</bUseTDR>`,
    `          <Flash2>BIN\\UL2CM3.DLL</Flash2>`,
    `          <Flash3></Flash3>`,
    `          <Flash4></Flash4>`,
    `          <pFcarmOut>.\\Objects\\${xmlEscape(input.projectName)}.axf</pFcarmOut>`,
    `          <pFcarmGrp></pFcarmGrp>`,
    `          <pFcArmRoot></pFcArmRoot>`,
    `          <FcArmLst>0</FcArmLst>`,
    `        </Utilities>`,
    `        <TargetArmAds>`,
    `          <ArmAdsMisc>`,
    `            <GenerateListings>0</GenerateListings>`,
    `            <asHll>1</asHll>`,
    `            <asAsm>1</asAsm>`,
    `            <asMacX>0</asMacX>`,
    `            <asSyms>1</asSyms>`,
    `            <asFals>1</asFals>`,
    `            <asDbgD>1</asDbgD>`,
    `            <asForm>1</asForm>`,
    `            <ldLst>0</ldLst>`,
    `            <ldmm>1</ldmm>`,
    `            <ldXref>1</ldXref>`,
    `            <BigEnd>0</BigEnd>`,
    `            <AdsALst>1</AdsALst>`,
    `            <AdsACrf>1</AdsACrf>`,
    `            <AdsANop>0</AdsANop>`,
    `            <AdsANot>0</AdsANot>`,
    `            <AdsLLst>1</AdsLLst>`,
    `            <AdsLmap>1</AdsLmap>`,
    `            <AdsLcgr>1</AdsLcgr>`,
    `            <AdsLsym>1</AdsLsym>`,
    `            <AdsLszi>1</AdsLszi>`,
    `            <AdsLtoi>1</AdsLtoi>`,
    `            <AdsLpue>1</AdsLpue>`,
    `            <AdsLo1i>1</AdsLo1i>`,
    `            <AdsLleP>1</AdsLleP>`,
    `            <AdsLIew>1</AdsLIew>`,
    `            <AdsLLom>1</AdsLLom>`,
    `            <AdsLpot>1</AdsLpot>`,
    `            <AdsLs>1</AdsLs>`,
    `          </ArmAdsMisc>`,
    `          <Cads>`,
    `            <interw>1</interw>`,
    `            <Optim>1</Optim>`,
    `            <oTime>0</oTime>`,
    `            <SplitLS>0</SplitLS>`,
    `            <OneElfS>1</OneElfS>`,
    `            <Strict>0</Strict>`,
    `            <EnumInt>0</EnumInt>`,
    `            <PlainCh>0</PlainCh>`,
    `            <Ropi>0</Ropi>`,
    `            <Rwpi>0</Rwpi>`,
    `            <wLevel>2</wLevel>`,
    `            <uThumb>1</uThumb>`,
    `            <uSurpInc>0</uSurpInc>`,
    `            <uC99>1</uC99>`,
    `            <uGnu>0</uGnu>`,
    `            <useXO>0</useXO>`,
    `            <v6Lang>1</v6Lang>`,
    `            <v6LangP>1</v6LangP>`,
    `            <vShortEn>1</vShortEn>`,
    `            <vShortWch>1</vShortWch>`,
    `            <v6Lto>0</v6Lto>`,
    `            <v6WtE>0</v6WtE>`,
    `            <v6Rtti>0</v6Rtti>`,
    `            <VariousControls>`,
    `              <MiscControls>${miscCompiler}</MiscControls>`,
    `              <Define>${definesStr}</Define>`,
    `              <Undefine></Undefine>`,
    `              <IncludePath>${includeStr}</IncludePath>`,
    `            </VariousControls>`,
    `          </Cads>`,
    `          <Aads>`,
    `            <interw>1</interw>`,
    `            <Ropi>0</Ropi>`,
    `            <Rwpi>0</Rwpi>`,
    `            <thumb>1</thumb>`,
    `            <SwStkChk>0</SwStkChk>`,
    `            <NoWarn>0</NoWarn>`,
    `            <uSurpInc>0</uSurpInc>`,
    `            <useXO>0</useXO>`,
    `            <ClangAsOpt>1</ClangAsOpt>`,
    `            <VariousControls>`,
    `              <MiscControls></MiscControls>`,
    `              <Define></Define>`,
    `              <Undefine></Undefine>`,
    `              <IncludePath></IncludePath>`,
    `            </VariousControls>`,
    `          </Aads>`,
    `          <LDads>`,
    `            <umfTarg>1</umfTarg>`,
    `            <Ropi>0</Ropi>`,
    `            <Rwpi>0</Rwpi>`,
    `            <noStLib>0</noStLib>`,
    `            <RepFail>1</RepFail>`,
    `            <useFile>${scatterUse}</useFile>`,
    `            <TextAddressRange>0x00000000</TextAddressRange>`,
    `            <DataAddressRange>0x20000000</DataAddressRange>`,
    `            <pXoBase></pXoBase>`,
    `            <ScatterFile>${scatterPath}</ScatterFile>`,
    `            <IncludeLibs></IncludeLibs>`,
    `            <IncludeLibsPath></IncludeLibsPath>`,
    `            <Misc>${miscLinker}</Misc>`,
    `            <LinkerInputFile></LinkerInputFile>`,
    `            <DisabledWarnings></DisabledWarnings>`,
    `          </LDads>`,
    `        </TargetArmAds>`,
    `      </TargetOption>`,
    `      <Groups>`,
    groupsXml,
    `      </Groups>`,
    `    </Target>`,
    `  </Targets>`,
    `</Project>`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Utility: derive file type from extension
// ---------------------------------------------------------------------------

const C_EXTS    = new Set([".c"]);
const CPP_EXTS  = new Set([".cpp", ".cc", ".cxx", ".c++"]);
const ASM_EXTS  = new Set([".s", ".S", ".asm"]);
const HDR_EXTS  = new Set([".h", ".hh", ".hpp", ".hxx", ".inc"]);
const LNK_EXTS  = new Set([".sct", ".scf", ".ld", ".ldr"]);

export function fileTypeFromExtension(filePath: string): UVisionFileType {
  const ext = path.extname(filePath).toLowerCase();
  if (C_EXTS.has(ext))   return UVisionFileType.C;
  if (CPP_EXTS.has(ext)) return UVisionFileType.CppSrc;
  if (ASM_EXTS.has(ext)) return UVisionFileType.Assembly;
  if (HDR_EXTS.has(ext)) return UVisionFileType.Document;
  if (LNK_EXTS.has(ext)) return UVisionFileType.Linker;
  return UVisionFileType.Generic;
}
