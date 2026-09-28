import { readdir } from "node:fs/promises";
import path from "node:path";

/** Where BounceService writes (`services/bounce.py`: `project.export_dir() / "bounces"`). */
export function bounceDir(projectPath: string): string {
  return path.join(path.dirname(projectPath), "export", "bounces");
}

/**
 * Finished bounce WAVs for `projectPath`: absolute paths, sorted. Hidden
 * scratch entries (`.<label>.stems/`, `.<label>.mix.wav`, `.<label>.trim.wav`)
 * are skipped. A missing directory yields [], any other read error throws.
 */
export async function bouncedWavs(projectPath: string): Promise<string[]> {
  const dir = bounceDir(projectPath);
  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter(
      (e) => e.isFile() && !e.name.startsWith(".") && e.name.endsWith(".wav"),
    )
    .map((e) => e.name)
    .sort()
    .map((name) => path.join(dir, name));
}
