/**
 * Renderer for Eclipse cmake4eclipse `.cproject` files.
 *
 * cmake4eclipse drives CMake configure and build; Eclipse CDT provides
 * indexing, code navigation, and debug/launch configuration only.
 * No compiler/linker settings are stored here — they come from CMake.
 *
 * Generates Debug, Default, and Release configurations that all use
 * cmake4eclipse's "CMake driven" toolchain.
 */

import { xmlEscape } from '../iar/xml.js';

const rid = (): number => Math.floor(Math.random() * 2_000_000_000);

/** Generates a fresh cmake4eclipse Debug configuration ID. */
export function generateDebugConfigId(): string {
  return `cmake4eclipse.mbs.config.debug.${rid()}`;
}

export interface Cmake4EclipseInput {
  /** Eclipse project name. Must match the directory name in the workspace. */
  projectName: string;
  /**
   * CMake toolchain file path relative to the project root,
   * e.g. `'toolchains/gcc.cmake'`.
   */
  toolchainFile: string;
  /** Additional cmake configure arguments appended after the toolchain flag. */
  extraCmakeArgs?: string;
  /**
   * Pre-generated Debug config ID to use in the `.cproject`.
   * If omitted, a new random ID is generated.
   * Pass the same ID to the launch config so `PROJECT_BUILD_CONFIG_ID_ATTR` matches.
   */
  debugConfigId?: string;
}

/** Shared set of binary-parser and error-parser extensions used in every configuration. */
function extensionLines(indent: string): string {
  return [
    '<extension id="org.eclipse.cdt.core.PE64" point="org.eclipse.cdt.core.BinaryParser"/>',
    '<extension id="org.eclipse.cdt.core.GNU_ELF" point="org.eclipse.cdt.core.BinaryParser"/>',
    '<extension id="org.eclipse.cdt.core.ELF" point="org.eclipse.cdt.core.BinaryParser"/>',
    '<extension id="org.eclipse.cdt.core.GmakeErrorParser" point="org.eclipse.cdt.core.ErrorParser"/>',
    '<extension id="org.eclipse.cdt.core.GLDErrorParser" point="org.eclipse.cdt.core.ErrorParser"/>',
    '<extension id="org.eclipse.cdt.core.GCCErrorParser" point="org.eclipse.cdt.core.ErrorParser"/>',
  ]
    .map((l) => indent + l)
    .join('\n');
}

function renderDebugConfig(inp: Cmake4EclipseInput): string {
  const cfgId = inp.debugConfigId ?? generateDebugConfigId();
  const otherArgs = `-G Ninja --toolchain=${inp.toolchainFile}${inp.extraCmakeArgs ? ' ' + inp.extraCmakeArgs : ''}`;
  return [
    `\t\t<cconfiguration id="${cfgId}">`,
    `\t\t\t<storageModule buildSystemId="de.marw.cmake4eclipse.mbs.cmake4eclipse" id="${cfgId}" moduleId="org.eclipse.cdt.core.settings" name="Debug">`,
    `\t\t\t\t<externalSettings/>`,
    `\t\t\t\t<extensions>`,
    extensionLines('\t\t\t\t\t'),
    `\t\t\t\t</extensions>`,
    `\t\t\t</storageModule>`,
    `\t\t\t<storageModule moduleId="cdtBuildSystem" version="4.0.0">`,
    `\t\t\t\t<configuration buildProperties="org.eclipse.cdt.build.core.buildType=org.eclipse.cdt.build.core.buildType.debug" description="" id="${cfgId}" name="Debug" optionalBuildProperties="org.eclipse.cdt.docker.launcher.containerbuild.property.volumes=,org.eclipse.cdt.docker.launcher.containerbuild.property.selectedvolumes=" parent="cmake4eclipse.mbs.config.debug">`,
    `\t\t\t\t\t<folderInfo id="${cfgId}." name="/" resourcePath="">`,
    `\t\t\t\t\t\t<toolChain id="cmake4eclipse.mbs.config.debug.toolChain.${rid()}" name="CMake driven" superClass="cmake4eclipse.mbs.config.debug.toolChain">`,
    `\t\t\t\t\t\t\t<targetPlatform id="cmake4eclipse.mbs.targetPlatform.cmake.${rid()}" name="Any Platform" superClass="cmake4eclipse.mbs.targetPlatform.cmake"/>`,
    `\t\t\t\t\t\t\t<builder buildPath="/${xmlEscape(inp.projectName)}/_build/Debug" id="cmake4eclipse.mbs.builder.${rid()}" keepEnvironmentInBuildfile="false" managedBuildOn="true" name="CMake Builder" superClass="cmake4eclipse.mbs.builder"/>`,
    `\t\t\t\t\t\t\t<tool id="cmake4eclipse.mbs.toolchain.tool.dummy.${rid()}" name="CMake" superClass="cmake4eclipse.mbs.toolchain.tool.dummy">`,
    `\t\t\t\t\t\t\t\t<inputType id="cmake4eclipse.mbs.inputType.c.${rid()}" superClass="cmake4eclipse.mbs.inputType.c"/>`,
    `\t\t\t\t\t\t\t\t<inputType id="cmake4eclipse.mbs.inputType.cpp.${rid()}" superClass="cmake4eclipse.mbs.inputType.cpp"/>`,
    `\t\t\t\t\t\t\t</tool>`,
    `\t\t\t\t\t\t</toolChain>`,
    `\t\t\t\t\t</folderInfo>`,
    `\t\t\t\t</configuration>`,
    `\t\t\t</storageModule>`,
    `\t\t\t<storageModule moduleId="org.eclipse.cdt.core.externalSettings"/>`,
    `\t\t\t<storageModule buildDir="_build/\${ConfigName}" moduleId="de.marw.cmake4eclipse.mbs.settings">`,
    `\t\t\t\t<options otherArguments="${xmlEscape(otherArgs)}"/>`,
    `\t\t\t</storageModule>`,
    `\t\t</cconfiguration>`,
  ].join('\n');
}

function renderDefaultConfig(inp: Cmake4EclipseInput): string {
  const cfgId = `cmake4eclipse.mbs.config.cmake.${rid()}`;
  return [
    `\t\t<cconfiguration id="${cfgId}">`,
    `\t\t\t<storageModule buildSystemId="de.marw.cmake4eclipse.mbs.cmake4eclipse" id="${cfgId}" moduleId="org.eclipse.cdt.core.settings" name="Default">`,
    `\t\t\t\t<externalSettings/>`,
    `\t\t\t\t<extensions>`,
    extensionLines('\t\t\t\t\t'),
    `\t\t\t\t</extensions>`,
    `\t\t\t</storageModule>`,
    `\t\t\t<storageModule moduleId="cdtBuildSystem" version="4.0.0">`,
    `\t\t\t\t<configuration buildProperties="" description="Default coming from cmake" id="${cfgId}" name="Default" parent="cmake4eclipse.mbs.config.cmake">`,
    `\t\t\t\t\t<folderInfo id="${cfgId}." name="/" resourcePath="">`,
    `\t\t\t\t\t\t<toolChain id="cmake4eclipse.mbs.config.cmake.toolChain.${rid()}" name="CMake driven" superClass="cmake4eclipse.mbs.config.cmake.toolChain">`,
    `\t\t\t\t\t\t\t<targetPlatform id="cmake4eclipse.mbs.targetPlatform.cmake.${rid()}" name="Any Platform" superClass="cmake4eclipse.mbs.targetPlatform.cmake"/>`,
    `\t\t\t\t\t\t\t<builder buildPath="/${xmlEscape(inp.projectName)}/_build/Default" id="cmake4eclipse.mbs.builder.${rid()}" managedBuildOn="true" name="CMake Builder.Default" superClass="cmake4eclipse.mbs.builder"/>`,
    `\t\t\t\t\t\t\t<tool id="cmake4eclipse.mbs.toolchain.tool.dummy.${rid()}" name="CMake" superClass="cmake4eclipse.mbs.toolchain.tool.dummy">`,
    `\t\t\t\t\t\t\t\t<inputType id="cmake4eclipse.mbs.inputType.c.${rid()}" superClass="cmake4eclipse.mbs.inputType.c"/>`,
    `\t\t\t\t\t\t\t\t<inputType id="cmake4eclipse.mbs.inputType.cpp.${rid()}" superClass="cmake4eclipse.mbs.inputType.cpp"/>`,
    `\t\t\t\t\t\t\t</tool>`,
    `\t\t\t\t\t\t</toolChain>`,
    `\t\t\t\t\t</folderInfo>`,
    `\t\t\t\t</configuration>`,
    `\t\t\t</storageModule>`,
    `\t\t\t<storageModule moduleId="org.eclipse.cdt.core.externalSettings"/>`,
    `\t\t</cconfiguration>`,
  ].join('\n');
}

function renderReleaseConfig(inp: Cmake4EclipseInput): string {
  const cfgId = `cmake4eclipse.mbs.config.release.${rid()}`;
  return [
    `\t\t<cconfiguration id="${cfgId}">`,
    `\t\t\t<storageModule buildSystemId="de.marw.cmake4eclipse.mbs.cmake4eclipse" id="${cfgId}" moduleId="org.eclipse.cdt.core.settings" name="Release">`,
    `\t\t\t\t<externalSettings/>`,
    `\t\t\t\t<extensions>`,
    extensionLines('\t\t\t\t\t'),
    `\t\t\t\t</extensions>`,
    `\t\t\t</storageModule>`,
    `\t\t\t<storageModule moduleId="cdtBuildSystem" version="4.0.0">`,
    `\t\t\t\t<configuration buildProperties="org.eclipse.cdt.build.core.buildType=org.eclipse.cdt.build.core.buildType.release" description="" id="${cfgId}" name="Release" optionalBuildProperties="org.eclipse.cdt.docker.launcher.containerbuild.property.volumes=,org.eclipse.cdt.docker.launcher.containerbuild.property.selectedvolumes=" parent="cmake4eclipse.mbs.config.release">`,
    `\t\t\t\t\t<folderInfo id="${cfgId}." name="/" resourcePath="">`,
    `\t\t\t\t\t\t<toolChain id="cmake4eclipse.mbs.config.release.toolChain.${rid()}" name="CMake driven" superClass="cmake4eclipse.mbs.config.release.toolChain">`,
    `\t\t\t\t\t\t\t<targetPlatform id="cmake4eclipse.mbs.targetPlatform.cmake.${rid()}" name="Any Platform" superClass="cmake4eclipse.mbs.targetPlatform.cmake"/>`,
    `\t\t\t\t\t\t\t<builder buildPath="/${xmlEscape(inp.projectName)}/_build/Release" id="cmake4eclipse.mbs.builder.${rid()}" managedBuildOn="true" name="CMake Builder.Release" superClass="cmake4eclipse.mbs.builder"/>`,
    `\t\t\t\t\t\t\t<tool id="cmake4eclipse.mbs.toolchain.tool.dummy.${rid()}" name="CMake" superClass="cmake4eclipse.mbs.toolchain.tool.dummy">`,
    `\t\t\t\t\t\t\t\t<inputType id="cmake4eclipse.mbs.inputType.c.${rid()}" superClass="cmake4eclipse.mbs.inputType.c"/>`,
    `\t\t\t\t\t\t\t\t<inputType id="cmake4eclipse.mbs.inputType.cpp.${rid()}" superClass="cmake4eclipse.mbs.inputType.cpp"/>`,
    `\t\t\t\t\t\t\t</tool>`,
    `\t\t\t\t\t\t</toolChain>`,
    `\t\t\t\t\t</folderInfo>`,
    `\t\t\t\t</configuration>`,
    `\t\t\t</storageModule>`,
    `\t\t\t<storageModule moduleId="org.eclipse.cdt.core.externalSettings"/>`,
    `\t\t</cconfiguration>`,
  ].join('\n');
}

export function renderCproject(inp: Cmake4EclipseInput): string {
  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>`,
    `<?fileVersion 4.0.0?><cproject storage_type_id="org.eclipse.cdt.core.XmlProjectDescriptionStorage">`,
    `\t<storageModule cmakelistsFolder="" moduleId="de.marw.cmake4eclipse.mbs.settings">`,
    `\t\t<targets>`,
    `\t\t\t<target name="SignedImage"/>`,
    `\t\t\t<target name="clean"/>`,
    `\t\t</targets>`,
    `\t</storageModule>`,
    `\t<storageModule moduleId="org.eclipse.cdt.core.settings">`,
    renderDebugConfig(inp),
    renderDefaultConfig(inp),
    renderReleaseConfig(inp),
    `\t</storageModule>`,
    `\t<storageModule moduleId="cdtBuildSystem" version="4.0.0">`,
    `\t\t<project id="${xmlEscape(inp.projectName)}.cmake4eclipse.mbs.projectType.${rid()}" name="" projectType="cmake4eclipse.mbs.projectType"/>`,
    `\t</storageModule>`,
    `\t<storageModule moduleId="scannerConfiguration">`,
    `\t\t<autodiscovery enabled="true" problemReportingEnabled="true" selectedProfileId=""/>`,
    `\t</storageModule>`,
    `\t<storageModule moduleId="org.eclipse.cdt.core.LanguageSettingsProviders"/>`,
    `\t<storageModule moduleId="refreshScope" versionNumber="2">`,
    `\t\t<configuration configurationName="Default">`,
    `\t\t\t<resource resourceType="PROJECT" workspacePath="/${xmlEscape(inp.projectName)}"/>`,
    `\t\t</configuration>`,
    `\t\t<configuration configurationName="Debug">`,
    `\t\t\t<resource resourceType="PROJECT" workspacePath="/${xmlEscape(inp.projectName)}"/>`,
    `\t\t</configuration>`,
    `\t\t<configuration configurationName="Release">`,
    `\t\t\t<resource resourceType="PROJECT" workspacePath="/${xmlEscape(inp.projectName)}"/>`,
    `\t\t</configuration>`,
    `\t</storageModule>`,
    `\t<storageModule moduleId="org.eclipse.cdt.make.core.buildtargets"/>`,
    `\t<storageModule moduleId="org.eclipse.cdt.internal.ui.text.commentOwnerProjectMappings"/>`,
    `</cproject>`,
    '',
  ].join('\n');
}

/** Plugin ID prefix shared by all Embedded CDT managed-build elements. */
const X = 'ilg.gnuarmeclipse.managedbuild.cross';
