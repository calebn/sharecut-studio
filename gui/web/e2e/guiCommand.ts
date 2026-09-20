export interface GuiCommandOptions {
  ci: boolean;
  host: string;
  pinProject: boolean;
  port: number;
  projectPath: string;
}

/** Build the E2E GUI command without pinning ordinary loopback test projects. */
export function guiCommand({
  ci,
  host,
  pinProject,
  port,
  projectPath,
}: GuiCommandOptions): string[] {
  const runner = ci ? ["podcast"] : ["uv", "run", "--extra", "gui", "podcast"];
  return [
    ...runner,
    "gui",
    ...(pinProject ? ["--project", projectPath] : []),
    "--host",
    host,
    "--port",
    String(port),
    "--no-open",
  ];
}
