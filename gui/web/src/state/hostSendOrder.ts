/**
 * Live host sends started by this tab, per project.
 *
 * A live command is persisted to the host queue before it is POSTed and leaves
 * it only after the response. A second live command therefore sees the first
 * as a queue predecessor even though nothing is offline. This registry lets it
 * tell its own tab's in-flight send apart from real leftovers.
 */
interface Send {
  commandId: string;
  done: Promise<void>;
}

const sends = new Map<string, Send[]>();

export interface HostSend {
  /** Settles once every send begun earlier for this project has finished. */
  earlier: Promise<void>;
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
    finish: () => {
      const rest = (sends.get(projectPath) ?? []).filter((s) => s !== entry);
      if (rest.length > 0) sends.set(projectPath, rest);
      else sends.delete(projectPath);
      resolveDone();
    },
  };
}

export function isHostSendInFlight(
  projectPath: string,
  commandId: string,
): boolean {
  return (sends.get(projectPath) ?? []).some((s) => s.commandId === commandId);
}
