/**
 * Reader for a CMake File API "reply" directory. Loads the index file,
 * the codemodel-v2 object, every referenced directory-*.json and
 * target-*.json file, and assembles a fully cross-referenced CMakeModel.
 *
 * Usage:
 *     const model = await CMakeFileApiReader.read("./dmod");
 *     for (const t of model.defaultConfiguration!.targets) {
 *         console.log(t.name, t.type);
 *     }
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CMakeModel,
  Configuration,
  Directory,
  Project,
  Target,
} from "./model.js";
import type {
  RawCodemodel,
  RawDirectory,
  RawIndexFile,
  RawObjectRef,
  RawTarget,
} from "./types.js";

export class CMakeFileApiReader {
  private constructor(private readonly replyDir: string) {}

  static async read(replyDir: string): Promise<CMakeModel> {
    return new CMakeFileApiReader(replyDir).load();
  }

  private async readJson<T>(file: string): Promise<T> {
    const full = path.join(this.replyDir, file);
    const text = await fs.readFile(full, "utf8");
    return JSON.parse(text) as T;
  }

  private async findIndexFile(): Promise<string> {
    const entries = await fs.readdir(this.replyDir);
    const indices = entries
      .filter((e) => e.startsWith("index-") && e.endsWith(".json"))
      .sort();
    if (indices.length === 0) {
      throw new Error(`No index-*.json file found in ${this.replyDir}`);
    }
    return indices[indices.length - 1];
  }

  private async load(): Promise<CMakeModel> {
    const indexName = await this.findIndexFile();
    const index = await this.readJson<RawIndexFile>(indexName);

    const codemodelRef = this.findCodemodelRef(index);
    const codemodel = await this.readJson<RawCodemodel>(codemodelRef.jsonFile);

    const model = new CMakeModel(index, codemodel);

    for (const rawCfg of codemodel.configurations) {
      const cfg = new Configuration(rawCfg);

      for (const dRef of rawCfg.directories) {
        cfg.directories.push(new Directory(dRef));
      }
      rawCfg.directories.forEach((dRef, i) => {
        const dir = cfg.directories[i];
        if (dRef.parentIndex !== undefined) {
          dir.parent = cfg.directories[dRef.parentIndex];
        }
        for (const ci of dRef.childIndexes ?? []) {
          dir.children.push(cfg.directories[ci]);
        }
      });

      for (const pRef of rawCfg.projects) {
        cfg.projects.push(new Project(pRef));
      }
      rawCfg.projects.forEach((pRef, i) => {
        const proj = cfg.projects[i];
        if (pRef.parentIndex !== undefined) {
          proj.parent = cfg.projects[pRef.parentIndex];
        }
        for (const ci of pRef.childIndexes ?? []) {
          proj.children.push(cfg.projects[ci]);
        }
        for (const di of pRef.directoryIndexes) {
          const dir = cfg.directories[di];
          proj.directories.push(dir);
          dir.project = proj;
        }
      });

      for (const tRef of rawCfg.targets) {
        const rawTarget = await this.readJson<RawTarget>(tRef.jsonFile);
        const target = new Target(tRef, rawTarget);
        target.directory = cfg.directories[tRef.directoryIndex];
        target.project = cfg.projects[tRef.projectIndex];
        target.directory.targets.push(target);
        target.project.targets.push(target);
        cfg.targets.push(target);
      }

      for (const dir of cfg.directories) {
        const detail = await this.readJson<RawDirectory>(dir.jsonFile);
        dir.loadDetails(detail);
      }

      const byId = new Map(cfg.targets.map((t) => [t.id, t]));
      for (const t of cfg.targets) {
        for (const id of t.dependencyIds) {
          const ref = byId.get(id);
          if (ref) t.dependencies.push(ref);
        }
        for (const id of t.orderDependencyIds) {
          const ref = byId.get(id);
          if (ref) t.orderDependencies.push(ref);
        }
        for (const id of t.linkLibraryIds) {
          const ref = byId.get(id);
          if (ref) t.linkLibraries.push(ref);
        }
      }

      model.configurations.push(cfg);
    }

    return model;
  }

  private findCodemodelRef(index: RawIndexFile): RawObjectRef {
    for (const v of Object.values(index.reply)) {
      if (this.isObjectRef(v) && v.kind === "codemodel") return v;
      if (v && typeof v === "object") {
        for (const inner of Object.values(v)) {
          if (this.isObjectRef(inner) && inner.kind === "codemodel") return inner;
        }
      }
    }
    const obj = index.objects.find((o) => o.kind === "codemodel");
    if (obj) return obj;
    throw new Error("No codemodel object found in index file");
  }

  private isObjectRef(v: unknown): v is RawObjectRef {
    return (
      !!v &&
      typeof v === "object" &&
      typeof (v as RawObjectRef).kind === "string" &&
      typeof (v as RawObjectRef).jsonFile === "string"
    );
  }
}
