import { readdir } from "node:fs/promises";
import path from "node:path";
import type { DirectoryOption } from "./types.js";

export async function listProjectDirectories(root: string): Promise<DirectoryOption[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      path: path.join(root, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

export function filterProjectDirectories(items: DirectoryOption[], query: string): DirectoryOption[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return items;
  }
  return items.filter((item) => item.name.toLowerCase().includes(normalized) || item.path.toLowerCase().includes(normalized));
}
