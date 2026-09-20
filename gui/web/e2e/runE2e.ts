import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupE2eManifest,
  createE2eCleanupManifest,
  type E2eCleanupManifest,
} from "./cleanupManifest";
import { acquireE2ePortLease, type E2ePortLease } from "./port";
import { processTreeTerminator } from "./processTree";

const TERMINATION_GRACE_MS = 5_000;

export interface PlaywrightProcess {
  exited: Promise<number>;
  forceKill(): Promise<void> | void;
  signal(signal: NodeJS.Signals): Promise<void> | void;
}

export type PlaywrightRunner = (
  args: string[],
  env: NodeJS.ProcessEnv,
) => PlaywrightProcess;

export interface SignalLifecycle {
  on(signal: NodeJS.Signals, listener: () => void): () => void;
  wait(milliseconds: number): Promise<void>;
}

const processLifecycle: SignalLifecycle = {
  on: (signal, listener) => {
    process.on(signal, listener);
    return () => process.off(signal, listener);
  },
  wait: (milliseconds) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref();
    }),
};

export function exitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (signal) {
    return { SIGINT: 130, SIGTERM: 143, SIGKILL: 137 }[signal] ?? 1;
  }
  return code ?? 1;
}

async function terminateTree(
  child: ChildProcess,
  terminator: ReturnType<typeof processTreeTerminator>,
  signal: NodeJS.Signals,
): Promise<void> {
  if (!child.pid) {
    return;
  }
  try {
    await terminator.terminate(child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function runPlaywright(
  args: string[],
  env: NodeJS.ProcessEnv,
): PlaywrightProcess {
  const webRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const cli = path.join(webRoot, "node_modules/@playwright/test/cli.js");
  const child = spawn(process.execPath, [cli, "test", ...args], {
    cwd: webRoot,
    detached: process.platform !== "win32",
    env,
    stdio: "inherit",
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(exitCode(code, signal)));
  });
  const terminator = processTreeTerminator();
  return {
    exited,
    forceKill: () => terminateTree(child, terminator, "SIGKILL"),
    signal: (signal) => terminateTree(child, terminator, signal),
  };
}

interface SignalForwarding {
  dispose(): void;
  waitForShutdown(): Promise<void>;
}

function invokeProcessAction(
  action: () => Promise<void> | void,
): Promise<void> {
  try {
    return Promise.resolve(action());
  } catch (error) {
    return Promise.reject(error);
  }
}

function installSignalForwarding(
  child: PlaywrightProcess,
  lifecycle: SignalLifecycle,
): SignalForwarding {
  let terminating = false;
  let shutdown = Promise.resolve();
  const forward = (signal: NodeJS.Signals) => {
    if (terminating) {
      return;
    }
    terminating = true;
    const gracefulTreeExit = invokeProcessAction(() => child.signal(signal));
    shutdown = (async () => {
      const exited = await Promise.race<boolean>([
        Promise.all([child.exited, gracefulTreeExit]).then(
          () => true,
          () => false,
        ),
        lifecycle.wait(TERMINATION_GRACE_MS).then(() => false),
      ]);
      if (!exited) {
        await child.forceKill();
      }
    })();
    void shutdown.catch(() => undefined);
  };
  const remove = (["SIGINT", "SIGTERM"] as const).map((signal) =>
    lifecycle.on(signal, () => forward(signal)),
  );
  return {
    dispose: () => {
      for (const dispose of remove) {
        dispose();
      }
    },
    waitForShutdown: () => shutdown,
  };
}

export async function runE2e(
  args: string[],
  runner: PlaywrightRunner = runPlaywright,
  createManifest: () => E2eCleanupManifest = createE2eCleanupManifest,
  acquireLease: () => Promise<E2ePortLease> = () => acquireE2ePortLease(),
  lifecycle: SignalLifecycle = processLifecycle,
): Promise<number> {
  const manifest = createManifest();
  let lease: E2ePortLease | undefined;
  let signalForwarding: SignalForwarding = {
    dispose: () => undefined,
    waitForShutdown: async () => undefined,
  };
  let cleanupAllowed = true;
  try {
    lease = await acquireLease();
    const env = {
      ...process.env,
      DAW_E2E_CLEANUP_MANIFEST: manifest.manifestPath,
      DAW_E2E_PORT: String(lease.port),
    };
    const child = runner(args, env);
    signalForwarding = installSignalForwarding(child, lifecycle);
    const code = await child.exited;
    try {
      await signalForwarding.waitForShutdown();
    } catch (error) {
      cleanupAllowed = false;
      throw error;
    }
    return code;
  } finally {
    signalForwarding.dispose();
    if (cleanupAllowed) {
      try {
        await cleanupE2eManifest(manifest);
      } finally {
        lease?.release();
      }
    }
  }
}
