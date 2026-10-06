/** Best-effort WebMCP tool registration for agentic browsing (Chrome). */

import { execute } from "../commands/execute";
import { seekTransport } from "../commands/seek";

type ToolHandler = (args: Record<string, unknown>) => unknown;

interface RegisterToolInput {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute: ToolHandler;
}

type ModelContext = {
  registerTool?: (tool: RegisterToolInput) => void | Promise<void>;
};

function modelContext(): ModelContext | null {
  const nav = navigator as Navigator & { modelContext?: ModelContext };
  return nav.modelContext ?? null;
}

/** Sharecut Studio: play/seek go through the command bus. */
export function registerDawWebMcpTools(): () => void {
  const mc = modelContext();
  if (!mc?.registerTool) {
    return () => undefined;
  }

  const tools: RegisterToolInput[] = [
    {
      name: "play_pause",
      description: "Toggle Sharecut Studio playback.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        await execute("transport.togglePlay", {}, { skipWhen: true });
        return { ok: true };
      },
    },
    {
      name: "seek_timeline",
      description:
        "Seek the Sharecut Studio playhead to a timeline position in seconds.",
      inputSchema: {
        type: "object",
        properties: {
          seconds: { type: "number", description: "Timeline seconds" },
        },
        required: ["seconds"],
      },
      execute: async (args) => {
        const seconds = Number(args.seconds);
        if (!Number.isFinite(seconds)) {
          throw new Error("seconds must be a number");
        }
        await seekTransport(seconds);
        return { ok: true, seconds };
      },
    },
  ];

  for (const tool of tools) {
    try {
      void mc.registerTool?.(tool);
    } catch {
      /* WebMCP optional */
    }
  }

  return () => undefined;
}
