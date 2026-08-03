import type { DatabaseSync } from "node:sqlite";
import type { GraphEdge, GraphNode, ImpactNode } from "../domain/model.js";
import { type DbRow, json, nullable, text } from "./platform-db.js";

export function graphNode(db: DatabaseSync, id: string): GraphNode | null {
  const row = db.prepare("SELECT * FROM graph_nodes WHERE id = ? AND active = 1").get(id) as DbRow | undefined;
  return row ? {
    id: text(row.id), type: text(row.type) as GraphNode["type"], label: text(row.label),
    path: nullable(row.path), symbol: nullable(row.symbol), contentHash: nullable(row.content_hash),
    metadata: json<Record<string, unknown>>(row.metadata_json)
  } : null;
}

export function impact(db: DatabaseSync, start: string, maxDepth = 3, limit = 100): ImpactNode[] {
  const direct = graphNode(db, start);
  const starts = direct ? [start] : (db.prepare(
    "SELECT id FROM graph_nodes WHERE active = 1 AND (path = ? OR symbol = ? OR label = ?) LIMIT 20"
  ).all(start.replace(/\\/g, "/"), start, start) as DbRow[]).map((row) => text(row.id));
  const seen = new Set(starts);
  let frontier = starts.map((id) => ({ id, distance: 0, via: null as GraphEdge["type"] | null }));
  const result: ImpactNode[] = [];
  while (frontier.length > 0 && result.length < limit) {
    const next: typeof frontier = [];
    for (const item of frontier) {
      const node = graphNode(db, item.id);
      if (node) result.push({ node, distance: item.distance, via: item.via });
      if (item.distance >= maxDepth) continue;
      const rows = db.prepare(
        "SELECT source_id, target_id, type FROM graph_edges WHERE source_id = ? OR target_id = ?"
      ).all(item.id, item.id) as DbRow[];
      for (const row of rows) {
        const source = text(row.source_id);
        const target = text(row.target_id);
        const neighbor = source === item.id ? target : source;
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        next.push({ id: neighbor, distance: item.distance + 1, via: text(row.type) as GraphEdge["type"] });
      }
    }
    frontier = next;
  }
  return result;
}

export function impactedTests(db: DatabaseSync, files: string[]): string[] {
  const queue = files.map((file) => `file:${file}`);
  const seen = new Set(queue);
  const tests = new Set<string>();
  for (let index = 0; index < queue.length && index < 2_000; index += 1) {
    const id = queue[index]!;
    const rows = db.prepare(
      "SELECT source_id, target_id, type FROM graph_edges WHERE target_id = ? OR source_id = ?"
    ).all(id, id) as DbRow[];
    for (const row of rows) {
      const source = text(row.source_id);
      const target = text(row.target_id);
      const candidate = source === id ? target : source;
      const node = graphNode(db, candidate);
      if (node?.type === "test" && node.path) tests.add(node.path);
      if (["imports", "tested_by"].includes(text(row.type)) && !seen.has(candidate)) {
        seen.add(candidate);
        queue.push(candidate);
      }
    }
  }
  return [...tests].sort();
}
