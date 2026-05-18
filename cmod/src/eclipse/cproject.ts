/**
 * Renderer for Eclipse CDT Managed Build `.cproject` files.
 *
 * Targets the "Eclipse Embedded CDT" plug-in (formerly GNU ARM Eclipse / GNU MCU Eclipse).
 * Plugin ID prefix: ilg.gnuarmeclipse.managedbuild.cross
 *
 * Generates a single "Debug" configuration.
 */

import { xmlEscape } from '../iar/xml.js';

/** Plugin ID prefix shared by all Embedded CDT managed-build elements. */
const X = 'ilg.gnuarmeclipse.managedbuild.cross';

/** Random integer suffix for element IDs (as Eclipse uses). */
const rid = (): number => Math.floor(Math.random() * 2_000_000_000);

export interface EclipseCprojectInput {
  /** Eclipse project name — used in the builder buildPath. */
  projectName: string;
  /** ARM CPU identifier as it appears after `-mcpu=`, e.g. `"cortex-m33"`. */
  mcpu: string;
  /** Absolute include paths collected from all compile groups. */
  includes: string[];
  /** Preprocessor defines collected from all compile groups, e.g. `"FOO=1"` or `"BAR"`. */
  defines: string[];
  /** Linker script paths as they appear in the link command (-T ...). */
  linkerScripts: string[];
}

// ---------------------------------------------------------------------------
// Formatting helpers – all take an explicit `ind` (indent prefix) string
// ---------------------------------------------------------------------------

function optBool(
  ind: string,
  key: string,
  name: string,
  value: boolean,
  usd = false,
): string {
  return [
    `${ind}<option`,
    `${ind}    id="${X}.${key}.${rid()}" name="${name}"`,
    `${ind}    superClass="${X}.${key}" useByScannerDiscovery="${usd}"`,
    `${ind}    value="${value}" valueType="boolean"/>`,
  ].join('\n');
}

function optEnum(
  ind: string,
  key: string,
  name: string,
  value: string,
  usd = false,
): string {
  return [
    `${ind}<option`,
    `${ind}    id="${X}.${key}.${rid()}" name="${name}"`,
    `${ind}    superClass="${X}.${key}" useByScannerDiscovery="${usd}"`,
    `${ind}    value="${X}.${value}" valueType="enumerated"/>`,
  ].join('\n');
}

function optStr(ind: string, key: string, name: string, value: string): string {
  return [
    `${ind}<option`,
    `${ind}    id="${X}.${key}.${rid()}" name="${name}"`,
    `${ind}    superClass="${X}.${key}" useByScannerDiscovery="false"`,
    `${ind}    value="${xmlEscape(value)}" valueType="string"/>`,
  ].join('\n');
}

function optList(
  ind: string,
  key: string,
  name: string,
  vtype: string,
  values: string[],
  usd = true,
): string {
  if (values.length === 0) return '';
  const items = values
    .map((v) => `${ind}    <listOptionValue builtIn="false" value="${xmlEscape(v)}"/>`)
    .join('\n');
  return [
    `${ind}<option IS_BUILTIN_EMPTY="false" IS_VALUE_EMPTY="false"`,
    `${ind}    id="${X}.${key}.${rid()}"`,
    `${ind}    name="${name}"`,
    `${ind}    superClass="${X}.${key}"`,
    `${ind}    useByScannerDiscovery="${usd}" valueType="${vtype}">`,
    items,
    `${ind}</option>`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/** Options that live directly inside the <toolChain> element (7 tabs deep). */
function toolChainOptions(ind: string, inp: EclipseCprojectInput): string {
  const mcpuVal = `option.arm.target.mcpu.${inp.mcpu}`;
  return [
    optBool(ind, 'option.addtools.createflash', 'Create flash image', true, false),
    optBool(ind, 'option.addtools.createlisting', 'Create extended listing', true, false),
    optBool(ind, 'option.addtools.printsize', 'Print size', true, false),
    optEnum(ind, 'option.optimization.level', 'Optimization Level',
      'option.optimization.level.debug', true),
    optBool(ind, 'option.optimization.messagelength', 'Message length (-fmessage-length=0)', true, true),
    optBool(ind, 'option.optimization.signedchar', "'char' is signed (-fsigned-char)", true, true),
    optBool(ind, 'option.optimization.functionsections', 'Function sections (-ffunction-sections)', true, true),
    optBool(ind, 'option.optimization.datasections', 'Data sections (-fdata-sections)', true, true),
    optEnum(ind, 'option.debugging.level', 'Debug level',
      'option.debugging.level.max', true),
    optEnum(ind, 'option.arm.target.family', 'Arm family (-mcpu)', mcpuVal, false),
    optEnum(ind, 'option.arm.target.fpu.abi', 'Float ABI',
      'option.arm.target.fpu.abi.soft', true),
    optBool(ind, 'option.warnings.allwarn', 'Enable all common warnings (-Wall)', true, true),
    optBool(ind, 'option.warnings.extrawarn', 'Enable extra warnings (-Wextra)', true, true),
    optEnum(ind, 'option.architecture', 'Architecture',
      'option.architecture.arm', false),
    optEnum(ind, 'option.arm.target.instructionset', 'Instruction set',
      'option.arm.target.instructionset.thumb', false),
    optStr(ind, 'option.command.prefix', 'Prefix', 'arm-none-eabi-'),
    optStr(ind, 'option.command.c', 'C compiler', 'gcc'),
    optStr(ind, 'option.command.cpp', 'C++ compiler', 'g++'),
    optStr(ind, 'option.command.ar', 'Archiver', 'ar'),
    optStr(ind, 'option.command.objcopy', 'Hex/Bin converter', 'objcopy'),
    optStr(ind, 'option.command.objdump', 'Listing generator', 'objdump'),
    optStr(ind, 'option.command.size', 'Size command', 'size'),
    optStr(ind, 'option.command.make', 'Build command', 'make'),
    optStr(ind, 'option.command.rm', 'Remove command', 'rm'),
  ]
    .filter((s) => s.length > 0)
    .join('\n');
}

function assemblerTool(ind: string, toolId: string, inp: EclipseCprojectInput): string {
  const optInd = ind + '\t';
  const inclOpt = optList(
    optInd, 'option.assembler.include.paths', 'Include paths (-I)', 'includePath',
    inp.includes.map((p) => `"${p.replace(/\\/g, '/')}"`),
  );
  const defOpt = optList(
    optInd, 'option.assembler.defs', 'Defined symbols (-D)', 'definedSymbols',
    inp.defines,
  );
  const inputType = `${optInd}<inputType id="${X}.tool.assembler.input.${rid()}" superClass="${X}.tool.assembler.input"/>`;
  return [
    `${ind}<tool id="${toolId}" name="GNU ARM Cross Assembler" superClass="${X}.tool.assembler">`,
    inclOpt,
    defOpt,
    inputType,
    `${ind}</tool>`,
  ]
    .filter((s) => s.length > 0)
    .join('\n');
}

function cCompilerTool(ind: string, toolId: string, inp: EclipseCprojectInput): string {
  const optInd = ind + '\t';
  const inclOpt = optList(
    optInd, 'option.c.compiler.include.paths', 'Include paths (-I)', 'includePath',
    inp.includes.map((p) => `"${p.replace(/\\/g, '/')}"`),
  );
  const defOpt = optList(
    optInd, 'option.c.compiler.defs', 'Defined symbols (-D)', 'definedSymbols',
    inp.defines,
  );
  const inputType = `${optInd}<inputType id="${X}.tool.c.compiler.input.${rid()}" superClass="${X}.tool.c.compiler.input"/>`;
  return [
    `${ind}<tool id="${toolId}" name="GNU ARM Cross C Compiler" superClass="${X}.tool.c.compiler">`,
    inclOpt,
    defOpt,
    inputType,
    `${ind}</tool>`,
  ]
    .filter((s) => s.length > 0)
    .join('\n');
}

function cppCompilerTool(ind: string, toolId: string, inp: EclipseCprojectInput): string {
  const optInd = ind + '\t';
  const inclOpt = optList(
    optInd, 'option.cpp.compiler.include.paths', 'Include paths (-I)', 'includePath',
    inp.includes.map((p) => `"${p.replace(/\\/g, '/')}"`),
  );
  const defOpt = optList(
    optInd, 'option.cpp.compiler.defs', 'Defined symbols (-D)', 'definedSymbols',
    inp.defines,
  );
  const noExcept = optBool(optInd, 'option.cpp.compiler.noexceptions',
    'Do not use exceptions (-fno-exceptions)', true, true);
  const noRtti = optBool(optInd, 'option.cpp.compiler.nortti',
    'Do not use RTTI (-fno-rtti)', true, true);
  const noUseAt = optBool(optInd, 'option.cpp.compiler.nousecxaatexit',
    'Do not use _cxa_atexit() (-fno-use-cxa-atexit)', true, true);
  const noTss = optBool(optInd, 'option.cpp.compiler.nothreadsafestatics',
    'Do not use thread-safe statics (-fno-threadsafe-statics)', true, true);
  const inputType = `${optInd}<inputType id="${X}.tool.cpp.compiler.input.${rid()}" superClass="${X}.tool.cpp.compiler.input"/>`;
  return [
    `${ind}<tool id="${toolId}" name="GNU ARM Cross C++ Compiler" superClass="${X}.tool.cpp.compiler">`,
    inclOpt,
    defOpt,
    noExcept, noRtti, noUseAt, noTss,
    inputType,
    `${ind}</tool>`,
  ]
    .filter((s) => s.length > 0)
    .join('\n');
}

function cLinkerTool(ind: string, toolId: string, inp: EclipseCprojectInput): string {
  const optInd = ind + '\t';
  const gcSect = optBool(optInd, 'option.c.linker.gcsections',
    'Remove unused sections (-Xlinker --gc-sections)', true);
  const scriptOpt = optList(
    optInd, 'option.c.linker.scriptfile', 'Script files (-T)', 'stringList',
    inp.linkerScripts, false,
  );
  const inputType = [
    `${optInd}<inputType id="${X}.tool.c.linker.input.${rid()}" superClass="${X}.tool.c.linker.input">`,
    `${optInd}\t<additionalInput kind="additionalinputdependency" paths="$(USER_OBJS)"/>`,
    `${optInd}\t<additionalInput kind="additionalinput" paths="$(LIBS)"/>`,
    `${optInd}</inputType>`,
  ].join('\n');
  return [
    `${ind}<tool id="${toolId}" name="GNU ARM Cross C Linker" superClass="${X}.tool.c.linker">`,
    gcSect,
    scriptOpt,
    inputType,
    `${ind}</tool>`,
  ]
    .filter((s) => s.length > 0)
    .join('\n');
}

function cppLinkerTool(ind: string, toolId: string, inp: EclipseCprojectInput): string {
  const optInd = ind + '\t';
  const gcSect = optBool(optInd, 'option.cpp.linker.gcsections',
    'Remove unused sections (-Xlinker --gc-sections)', true, false);
  const scriptOpt = optList(
    optInd, 'option.cpp.linker.scriptfile', 'Script files (-T)', 'stringList',
    inp.linkerScripts, false,
  );
  const inputType = [
    `${optInd}<inputType id="${X}.tool.cpp.linker.input.${rid()}" superClass="${X}.tool.cpp.linker.input">`,
    `${optInd}\t<additionalInput kind="additionalinputdependency" paths="$(USER_OBJS)"/>`,
    `${optInd}\t<additionalInput kind="additionalinput" paths="$(LIBS)"/>`,
    `${optInd}</inputType>`,
  ].join('\n');
  return [
    `${ind}<tool id="${toolId}" name="GNU ARM Cross C++ Linker" superClass="${X}.tool.cpp.linker">`,
    gcSect,
    scriptOpt,
    inputType,
    `${ind}</tool>`,
  ]
    .filter((s) => s.length > 0)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Main renderer
// ---------------------------------------------------------------------------

export function renderCproject(inp: EclipseCprojectInput): string {
  const cfgId = `${X}.config.elf.debug.${rid()}`;
  const tcId = `${X}.toolchain.elf.debug.${rid()}`;
  const tpId = `${X}.targetPlatform.${rid()}`;
  const bldrId = `${X}.builder.${rid()}`;
  const asmToolId = `${X}.tool.assembler.${rid()}`;
  const ccToolId = `${X}.tool.c.compiler.${rid()}`;
  const cppToolId = `${X}.tool.cpp.compiler.${rid()}`;
  const clToolId = `${X}.tool.c.linker.${rid()}`;
  const cpplToolId = `${X}.tool.cpp.linker.${rid()}`;
  const arToolId = `${X}.tool.archiver.${rid()}`;
  const flashToolId = `${X}.tool.createflash.${rid()}`;
  const listingToolId = `${X}.tool.createlisting.${rid()}`;
  const sizeToolId = `${X}.tool.printsize.${rid()}`;

  // Indent strings for each nesting level
  const i1 = '\t';
  const i2 = '\t\t';
  const i3 = '\t\t\t';
  const i4 = '\t\t\t\t';
  const i5 = '\t\t\t\t\t';
  const i6 = '\t\t\t\t\t\t';
  const i7 = '\t\t\t\t\t\t\t';

  // Empty name="" means "the entire project", which causes Eclipse CDT Managed
  // Build to walk all project resources — including linked virtual folders —
  // when generating the Makefile.  Using individual folder names here is NOT
  // reliable for linked folders in all CDT versions.
  const sourceEntries =
    `${i6}<entry flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name=""/>`;

  const tcOpts = toolChainOptions(i7, inp);

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?><?fileVersion 4.0.0?><cproject`,
    `storage_type_id="org.eclipse.cdt.core.XmlProjectDescriptionStorage">`,
    `${i1}<storageModule moduleId="org.eclipse.cdt.core.settings">`,
    `${i2}<cconfiguration id="${cfgId}">`,
    // --- inner settings storageModule ---
    `${i3}<storageModule`,
    `${i3}    buildSystemId="org.eclipse.cdt.managedbuilder.core.configurationDataProvider"`,
    `${i3}    id="${cfgId}" moduleId="org.eclipse.cdt.core.settings" name="Debug">`,
    `${i4}<externalSettings/>`,
    `${i4}<extensions>`,
    `${i5}<extension id="org.eclipse.cdt.core.ELF" point="org.eclipse.cdt.core.BinaryParser"/>`,
    `${i5}<extension id="org.eclipse.cdt.core.GASErrorParser" point="org.eclipse.cdt.core.ErrorParser"/>`,
    `${i5}<extension id="org.eclipse.cdt.core.GmakeErrorParser" point="org.eclipse.cdt.core.ErrorParser"/>`,
    `${i5}<extension id="org.eclipse.cdt.core.GLDErrorParser" point="org.eclipse.cdt.core.ErrorParser"/>`,
    `${i5}<extension id="org.eclipse.cdt.core.CWDLocator" point="org.eclipse.cdt.core.ErrorParser"/>`,
    `${i5}<extension id="org.eclipse.cdt.core.GCCErrorParser" point="org.eclipse.cdt.core.ErrorParser"/>`,
    `${i4}</extensions>`,
    `${i3}</storageModule>`,
    // --- cdtBuildSystem storageModule ---
    `${i3}<storageModule moduleId="cdtBuildSystem" version="4.0.0">`,
    `${i4}<configuration artifactName="\${ProjName}"`,
    `${i4}    buildArtefactType="org.eclipse.cdt.build.core.buildArtefactType.exe"`,
    `${i4}    buildProperties="org.eclipse.cdt.build.core.buildArtefactType=org.eclipse.cdt.build.core.buildArtefactType.exe,org.eclipse.cdt.build.core.buildType=org.eclipse.cdt.build.core.buildType.debug"`,
    `${i4}    cleanCommand="\${cross_rm} -rf" description=""`,
    `${i4}    id="${cfgId}" name="Debug"`,
    `${i4}    parent="${X}.config.elf.debug">`,
    `${i5}<folderInfo id="${cfgId}." name="/" resourcePath="">`,
    `${i6}<toolChain id="${tcId}" name="ARM Cross GCC"`,
    `${i6}    superClass="${X}.toolchain.elf.debug">`,
    tcOpts,
    `${i7}<targetPlatform archList="all" binaryParser="org.eclipse.cdt.core.ELF"`,
    `${i7}    id="${tpId}" isAbstract="false" osList="all"`,
    `${i7}    superClass="${X}.targetPlatform"/>`,
    `${i7}<builder buildPath="\${workspace_loc:/${xmlEscape(inp.projectName)}}/Debug"`,
    `${i7}    id="${bldrId}" keepEnvironmentInBuildfile="false"`,
    `${i7}    managedBuildOn="true" name="Gnu Make Builder"`,
    `${i7}    superClass="${X}.builder"/>`,
    assemblerTool(i7, asmToolId, inp),
    cCompilerTool(i7, ccToolId, inp),
    cppCompilerTool(i7, cppToolId, inp),
    cLinkerTool(i7, clToolId, inp),
    cppLinkerTool(i7, cpplToolId, inp),
    `${i7}<tool id="${arToolId}" name="GNU ARM Cross Archiver" superClass="${X}.tool.archiver"/>`,
    `${i7}<tool id="${flashToolId}" name="GNU ARM Cross Create Flash Image" superClass="${X}.tool.createflash"/>`,
    `${i7}<tool id="${listingToolId}" name="GNU ARM Cross Create Listing" superClass="${X}.tool.createlisting"/>`,
    `${i7}<tool id="${sizeToolId}" name="GNU ARM Cross Print Size" superClass="${X}.tool.printsize"/>`,
    `${i6}</toolChain>`,
    `${i5}</folderInfo>`,
    `${i5}<sourceEntries>`,
    sourceEntries,
    `${i5}</sourceEntries>`,
    `${i4}</configuration>`,
    `${i3}</storageModule>`,
    `${i3}<storageModule moduleId="org.eclipse.cdt.core.externalSettings"/>`,
    `${i2}</cconfiguration>`,
    `${i1}</storageModule>`,
    `${i1}<storageModule moduleId="cdtBuildSystem" version="4.0.0">`,
    `${i2}<project id="${xmlEscape(inp.projectName)}.${X}.target.elf.${rid()}" name="Executable"`,
    `${i2}    projectType="${X}.target.elf"/>`,
    `${i1}</storageModule>`,
    `${i1}<storageModule moduleId="org.eclipse.cdt.core.LanguageSettingsProviders"/>`,
    `${i1}<storageModule moduleId="scannerConfiguration">`,
    `${i2}<autodiscovery enabled="true" problemReportingEnabled="true" selectedProfileId=""/>`,
    `${i1}</storageModule>`,
    `</cproject>`,
    '',
  ].join('\n');
}
