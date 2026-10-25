import type { ReactNode } from "react";
import { BrandLockup, Button, Field } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";

export type HomeMode = "idle" | "new" | "open";
export type HomeBusyAction = "create" | "open" | "browse" | null;

export type HomeScreenViewProps = {
  /** The first-run setup wizard; while set it replaces the home screen. */
  wizard: ReactNode;
  mode: HomeMode;
  name: string;
  dir: string;
  path: string;
  busyAction: HomeBusyAction;
  error: string | null;
  modelsIncomplete: boolean;
  /** Dialogs the screen opens, mounted beside the page. */
  dialogs: ReactNode;
  onNameChange: (value: string) => void;
  onDirChange: (value: string) => void;
  onPathChange: (value: string) => void;
  onNewMode: () => void;
  onOpenMode: () => void;
  onCancel: () => void;
  onCreate: () => void;
  onOpen: () => void;
  onBrowse: () => void;
  onConnectAgent: () => void;
  onModels: () => void;
  onHelp: () => void;
};

export function HomeScreenView({
  wizard,
  mode,
  name,
  dir,
  path,
  busyAction,
  error,
  modelsIncomplete,
  dialogs,
  onNameChange,
  onDirChange,
  onPathChange,
  onNewMode,
  onOpenMode,
  onCancel,
  onCreate,
  onOpen,
  onBrowse,
  onConnectAgent,
  onModels,
  onHelp,
}: HomeScreenViewProps) {
  const busy = busyAction !== null;
  if (wizard) {
    return (
      <main className="cover home-screen">
        <div className="cover-center center stack">{wizard}</div>
      </main>
    );
  }

  return (
    <main className="cover home-screen">
      <div className="cover-center center stack" data-daw-app-chrome>
        <header className="stack">
          <h1 className="wordmark">
            <BrandLockup name="ShareCut Studio" />
          </h1>
          <p className="lede">
            Create or open an episode project to start arranging.
          </p>
        </header>
        {error ? (
          <p className="home-screen-error" role="alert">
            {error}
          </p>
        ) : null}
        {mode === "idle" ? (
          <div className="cluster">
            <Button variant="primary" onClick={onNewMode}>
              New project…
            </Button>
            <Button onClick={onOpenMode}>Open project…</Button>
            <Button onClick={onConnectAgent}>Connect agent…</Button>
            <Button onClick={onModels}>
              {modelsIncomplete ? "Models · setup incomplete" : "Models"}
            </Button>
            <Button onClick={onHelp}>Help</Button>
          </div>
        ) : null}
        {mode === "new" ? (
          <form
            className="box elevated stack"
            onSubmit={(e) => {
              e.preventDefault();
              onCreate();
            }}
          >
            <Field label="Name">
              {(control) => (
                <input
                  {...control}
                  value={name}
                  onChange={(e) => onNameChange(e.target.value)}
                  autoComplete="off"
                  required
                />
              )}
            </Field>
            <Field label="Workspace directory">
              {(control) => (
                <input
                  {...control}
                  value={dir}
                  onChange={(e) => onDirChange(e.target.value)}
                  placeholder="/path/to/my_episode"
                  autoComplete="off"
                  required
                />
              )}
            </Field>
            <div className="cluster">
              <Button
                type="submit"
                variant="primary"
                disabledReason={
                  busy
                    ? BUSY_REASON
                    : !dir.trim()
                      ? "Enter a workspace directory to create."
                      : undefined
                }
              >
                {busyAction === "create" ? "Creating…" : "Create"}
              </Button>
              <Button
                type="button"
                disabledReason={busy ? BUSY_REASON : undefined}
                onClick={onCancel}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
        {mode === "open" ? (
          <form
            className="box elevated stack"
            aria-busy={busyAction === "browse" || undefined}
            onSubmit={(e) => {
              e.preventDefault();
              onOpen();
            }}
          >
            <Field label="episode.project.json">
              {(control) => (
                <input
                  {...control}
                  value={path}
                  onChange={(e) => onPathChange(e.target.value)}
                  placeholder="/path/to/episode.project.json"
                  autoComplete="off"
                  required
                />
              )}
            </Field>
            <div className="cluster">
              <Button
                type="button"
                disabledReason={busy ? BUSY_REASON : undefined}
                onClick={onBrowse}
              >
                {busyAction === "browse" ? "Browsing…" : "Browse…"}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabledReason={
                  busy
                    ? BUSY_REASON
                    : !path.trim()
                      ? "Enter a project file path to open."
                      : undefined
                }
              >
                {busyAction === "open" ? "Opening…" : "Open"}
              </Button>
              <Button
                type="button"
                disabledReason={busy ? BUSY_REASON : undefined}
                onClick={onCancel}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </div>
      {dialogs}
    </main>
  );
}
