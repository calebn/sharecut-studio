/**
 * Live host sends started by this tab, per project.
 *
 * A live command is persisted to the host queue before it is POSTed and leaves
 * it only after the response. A second live command therefore sees the first
 * as a queue predecessor even though nothing is offline. This registry lets it
 * tell its own tab's in-flight send apart from real leftovers.
 * Per tab only: another tab's in-flight record looks like an offline leftover, and the caller requests a drain.
 */
interface Send {
  commandId: string;
  done: Promise<void>;
}

const sends = new Map<string, Send[]>();
const finishedCount = new Map<string, number>();

/**
 * How many live sends this tab has finished for the project. It changes only
 * after a send's own queue cleanup, so the drain re-reads the queue only then.
 */
export function hostSendsFinished(projectPath: string): number {
  return finishedCount.get(projectPath) ?? 0;
}

/** How long a live host command waits behind this tab's earlier sends before it stays queued for the drain. */
export const HOST_SEND_WAIT_MS = 5_000;

export interface HostSend {
  /**
   * Settles once every send begun earlier for this project has finished (all of
   * them, not only queue records ahead; the host queue is a single FIFO).
   */
  earlier: Promise<void>;
  /** True once every earlier send finished, false if `ms` passes first. */
  earlierWithin: (ms: number) => Promise<boolean>;
  /** Mark this send finished (call from a finally block). */
  finish: () => void;
}

export function beginHostSend(
  projectPath: string,
  commandId: string,
): HostSend {
  const list = sends.get(projectPath) ?? [];
  const earlier = Promise.all(list.map((s) => s.done)).then(() => undefined);
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const entry: Send = { commandId, done };
  sends.set(projectPath, [...list, entry]);
  return {
    earlier,
    earlierWithin: (ms) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      });
      return Promise.race([earlier.then(() => true), timedOut]).finally(() =>
        clearTimeout(timer),
      );
    },
    finish: () => {
      const rest = (sends.get(projectPath) ?? []).filter((s) => s !== entry);
      if (rest.length > 0) sends.set(projectPath, rest);
      else sends.delete(projectPath);
      finishedCount.set(projectPath, hostSendsFinished(projectPath) + 1);
      resolveDone();
    },
  };
}

/** This tab's in-flight live send of `commandId`, settling when it finishes; null if none. */
export function hostSendDone(
  projectPath: string,
  commandId: string,
): Promise<void> | null {
  return (
    (sends.get(projectPath) ?? []).find((s) => s.commandId === commandId)
      ?.done ?? null
  );
}
