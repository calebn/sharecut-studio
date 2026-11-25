import { apiFetch } from "./http";

export async function getEditorCutTotal(
  projectPath: string,
  signal: AbortSignal,
): Promise<number> {
  const response = await apiFetch(
    projectPath,
    { guest: "/daw/edit-impact" },
    { signal },
  );
  const { total_removed_sec: seconds } = (await response.json()) as {
    total_removed_sec: unknown;
  };
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error("The edit impact report did not have a cut total.");
  }
  return seconds;
}
