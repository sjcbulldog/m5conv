import fs from "node:fs/promises";
import path from "node:path";
import { BspAssetContext, BspAssetPlan } from "./types";

export class BspAssetApplicator {
  createPlan(context: BspAssetContext): BspAssetPlan {
    const bspSourceDir = path.join(context.sdkDir, "bsps", context.bsp);
    const bspDestinationDir = path.join(context.destinationDir, "bsps", context.bsp);

    const assetCopyOperations = context.architecture.projectAssetDirs.map((assetDir) => ({
      sourceDir: path.join(context.sdkDir, assetDir),
      destinationDir: path.join(context.destinationDir, assetDir),
    }));

    return {
      bspSourceDir,
      bspDestinationDir,
      assetCopyOperations,
    };
  }

  async apply(context: BspAssetContext): Promise<void> {
    const plan = this.createPlan(context);

    await this.ensureExists(plan.bspSourceDir, "BSP source directory not found");
    await this.copyDirectoryRecursive(plan.bspSourceDir, plan.bspDestinationDir);

    for (const operation of plan.assetCopyOperations) {
      const exists = await this.pathExists(operation.sourceDir);
      if (exists) {
        await this.copyDirectoryRecursive(operation.sourceDir, operation.destinationDir);
      }
    }

    await this.writeBspMetadata(context);
  }

  private async writeBspMetadata(context: BspAssetContext): Promise<void> {
    const metadataPath = path.join(context.destinationDir, "project.bsp.json");
    const payload = {
      bsp: context.bsp,
      sdkDir: context.sdkDir,
      mtb4ArchPath: context.architecture.mtb4ArchPath,
      generatedAt: new Date().toISOString(),
    };

    await fs.mkdir(context.destinationDir, { recursive: true });
    await fs.writeFile(metadataPath, JSON.stringify(payload, null, 2), "utf8");
  }

  private async ensureExists(targetPath: string, message: string): Promise<void> {
    const exists = await this.pathExists(targetPath);
    if (!exists) {
      throw new Error(`${message}: ${targetPath}`);
    }
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async copyDirectoryRecursive(sourceDir: string, destinationDir: string): Promise<void> {
    await fs.mkdir(path.dirname(destinationDir), { recursive: true });
    await fs.cp(sourceDir, destinationDir, { recursive: true, force: true });
  }
}
