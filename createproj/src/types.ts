export interface CliArgs {
  sdkDir: string;
  bsp: string;
  destDir: string;
}

export interface ModusToolboxArchitecture {
  mtb4ArchPath: string;
  projectAssetDirs: string[];
}

export interface BspAssetContext {
  sdkDir: string;
  bsp: string;
  destinationDir: string;
  architecture: ModusToolboxArchitecture;
}

export interface BspAssetPlan {
  bspSourceDir: string;
  bspDestinationDir: string;
  assetCopyOperations: AssetCopyOperation[];
}

export interface AssetCopyOperation {
  sourceDir: string;
  destinationDir: string;
}
