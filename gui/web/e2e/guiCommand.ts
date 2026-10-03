export interface GuiCommandOptions {
  ci: boolean;
  host: string;
  pinProject: boolean;
  port: number;
  projectPath: string;
}

export function podcastCommand({
  ci,
}: Pick<GuiCommandOptions, "ci">): string[] {
  return ci ? ["podcast"] : ["uv", "run", "--extra", "gui", "podcast"];
}

/** Build the E2E GUI command without pinning ordinary loopback test projects. */
export function guiCommand({
  ci,
  host,
  pinProject,
  port,
  projectPath,
}: GuiCommandOptions): string[] {
  return [
    ...podcastCommand({ ci }),
    "gui",
    ...(pinProject ? ["--project", projectPath] : []),
    "--host",
    host,
    "--port",
    String(port),
    "--no-open",
  ];
}
