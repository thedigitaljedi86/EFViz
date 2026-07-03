/**
 * Orchestration: scan a workspace and produce the complete diagram payload —
 * every DbContext, its model per migration, diffs between migrations, and a
 * current model (from the snapshot, the last migration, or source fallback).
 */

import { relative, sep } from 'path';
import { scanWorkspace } from './scan.js';
import {
  parseSnapshotModel,
  parseMigrationMeta,
  detectProvider,
} from './snapshotParser.js';
import { buildModelFromSource } from './sourceParser.js';
import { diffModels } from './diff.js';

export function buildDiagramData(root, options = {}) {
  const scan = scanWorkspace(root);
  const warnings = [];
  const contexts = [];

  // Contexts discovered from user code; migrations may also reference a
  // context we couldn't find the source of (e.g. only migrations checked in).
  const contextNames = new Set(scan.contexts.map((c) => c.name));
  for (const name of scan.migrationSets.keys()) contextNames.add(name);
  for (const name of scan.snapshots.keys()) contextNames.add(name);

  for (const name of [...contextNames].sort()) {
    if (options.context && name !== options.context) continue;
    const source = scan.contexts.find((c) => c.name === name);
    const designerFiles = scan.migrationSets.get(name) ?? [];
    const snapshot = scan.snapshots.get(name);

    const ctx = {
      name,
      namespace: source?.namespace ?? null,
      filePath: source ? source.relativePath : null,
      provider: null,
      dbSetCount: source?.dbSets.length ?? null,
      modelSource: null,
      migrations: [],
      currentModel: null,
    };

    let prevModel = null;
    for (const designer of designerFiles) {
      const meta = parseMigrationMeta(designer.code);
      if (!meta) continue;
      let model;
      try {
        model = parseSnapshotModel(designer.code);
      } catch (err) {
        warnings.push(`Failed to parse ${rel(root, designer.filePath)}: ${err.message}`);
        continue;
      }
      if (!ctx.provider) ctx.provider = detectProvider(designer.code);
      ctx.migrations.push({
        id: meta.id,
        name: meta.name,
        timestamp: meta.timestamp,
        filePath: rel(root, designer.filePath),
        model,
        diff: diffModels(prevModel, model),
      });
      prevModel = model;
    }

    if (snapshot) {
      try {
        const model = parseSnapshotModel(snapshot.code);
        ctx.currentModel = model;
        ctx.modelSource = 'snapshot';
        if (!ctx.provider) ctx.provider = detectProvider(snapshot.code);
        // If the snapshot differs from the last migration, surface pending changes.
        if (prevModel) {
          const pending = diffModels(prevModel, model);
          if (pending.changeCount > 0) ctx.pendingChanges = pending;
        }
      } catch (err) {
        warnings.push(`Failed to parse ${rel(root, snapshot.filePath)}: ${err.message}`);
      }
    }
    if (!ctx.currentModel && ctx.migrations.length > 0) {
      ctx.currentModel = ctx.migrations[ctx.migrations.length - 1].model;
      ctx.modelSource = 'migrations';
    }
    if (!ctx.currentModel && source) {
      try {
        const model = buildModelFromSource(source, scan.csFiles);
        if (model.entities.length > 0) {
          ctx.currentModel = model;
          ctx.modelSource = 'source';
        }
      } catch (err) {
        warnings.push(`Failed to build model from source for ${name}: ${err.message}`);
      }
    }

    if (!ctx.currentModel) {
      warnings.push(`Skipped context '${name}': no migrations, snapshot, or parsable entities found.`);
      continue;
    }
    contexts.push(ctx);
  }

  return {
    tool: 'AutoEntityDiagram',
    generatedAt: new Date().toISOString(),
    root: root,
    contexts,
    warnings,
  };
}

function rel(root, p) {
  return relative(root, p).split(sep).join('/');
}
