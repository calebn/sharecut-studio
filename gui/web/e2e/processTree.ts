import { spawn, spawnSync } from "node:child_process";

const GRACEFUL_WAIT_MS = 5_000;
const FORCE_WAIT_MS = 2_000;
const POLL_INTERVAL_MS = 25;

export interface ProcessTreeTerminator {
  terminate(pid: number, signal: NodeJS.Signals): Promise<void>;
}

export type Taskkill = (
  command: string,
  args: string[],
) => Promise<void> | void;
export type ProcessKill = (pid: number, signal: NodeJS.Signals | 0) => void;
export type ProcessTableReader = () => ReadonlyMap<number, number>;
export type Pause = (milliseconds: number) => Promise<void>;

interface ProcessTreeDependencies {
  kill?: ProcessKill;
  pause?: Pause;
  readProcessTable?: ProcessTableReader;
  taskkill?: Taskkill;
}

function taskkill(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with status ${String(code)}`));
      }
    });
  });
}

export function parseProcessTable(output: string): ReadonlyMap<number, number> {
  const table = new Map<number, number>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) {
      table.set(Number(match[1]), Number(match[2]));
    }
  }
  return table;
}

function readProcessTable(): ReadonlyMap<number, number> {
  const result = spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`ps exited with status ${String(result.status)}`);
  }
  return parseProcessTable(result.stdout);
}

export function descendantPids(
  rootPid: number,
  table: ReadonlyMap<number, number>,
): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const [pid, parentPid] of table) {
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }

  const descendants: number[] = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pid === undefined) {
      break;
    }
    descendants.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

function isMissingProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

function signalIfPresent(
  kill: ProcessKill,
  pid: number,
  signal: NodeJS.Signals | 0,
): boolean {
  try {
    kill(pid, signal);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) {
      return false;
    }
    throw error;
  }
}

async function waitForExit(
  pids: ReadonlySet<number>,
  timeoutMs: number,
  kill: ProcessKill,
  pause: Pause,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let remaining = [...pids].filter((pid) => signalIfPresent(kill, pid, 0));
  while (remaining.length > 0 && Date.now() < deadline) {
    await pause(POLL_INTERVAL_MS);
    remaining = remaining.filter((pid) => signalIfPresent(kill, pid, 0));
  }
  if (remaining.length > 0) {
    throw new Error(
      `process tree did not exit after ${String(timeoutMs)}ms: ${remaining.join(", ")}`,
    );
  }
}

export function processTreeTerminator(
  platform: NodeJS.Platform = process.platform,
  dependencies: ProcessTreeDependencies = {},
): ProcessTreeTerminator {
  const runTaskkill = dependencies.taskkill ?? taskkill;
  const kill =
    dependencies.kill ?? ((pid, signal) => process.kill(pid, signal));
  const readTable = dependencies.readProcessTable ?? readProcessTable;
  const pause =
    dependencies.pause ??
    ((milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const tracked = new Set<number>();

  return {
    terminate: async (pid, signal) => {
      if (platform === "win32") {
        const args = ["/pid", String(pid), "/t"];
        if (signal === "SIGKILL") {
          args.push("/f");
        }
        await runTaskkill("taskkill", args);
        return;
      }

      tracked.add(pid);
      for (const descendant of descendantPids(pid, readTable())) {
        tracked.add(descendant);
      }

      const deepestFirst = [...tracked].reverse();
      for (const targetPid of deepestFirst) {
        signalIfPresent(kill, -targetPid, signal);
        signalIfPresent(kill, targetPid, signal);
      }

      await waitForExit(
        tracked,
        signal === "SIGKILL" ? FORCE_WAIT_MS : GRACEFUL_WAIT_MS,
        kill,
        pause,
      );
    },
  };
}
