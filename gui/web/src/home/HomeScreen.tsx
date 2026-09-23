import { useCallback, useEffect, useState } from "react";
import {
  closeEpisodeProject,
  createEpisodeProject,
  openEpisodeProject,
  pickEpisodeProject,
} from "../api";
import { desktopCloseGuardArmed } from "../desktop/useDesktopCloseGuard";
import { HostMcpDialog } from "../layout/HostMcpDialog";
import { Button, Field } from "../ui";
import { readLocal, writeLocal } from "../utils/storage";
import { BootstrapWizard } from "./BootstrapWizard";
import { HelpDialog } from "./HelpDialog";

const SKIP_KEY = "sharecut.bootstrap.skip";

function navigateToProject(path: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("project", path);
  window.location.assign(url.toString());
}

function bootstrapSkipped(): boolean {
  return readLocal(SKIP_KEY) === "1";
}

export function HomeScreen() {
  const [setupDone, setSetupDone] = useState(() => bootstrapSkipped() || false);
  const [mode, setMode] = useState<"idle" | "new" | "open">("idle");
  const [name, setName] = useState("episode");
  const [dir, setDir] = useState("");
  const [path, setPath] = useState("");
  const [busyAction, setBusyAction] = useState<
    "create" | "open" | "browse" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const busy = busyAction !== null;

  useEffect(() => {
    if (desktopCloseGuardArmed()) {
      return;
    }
    void closeEpisodeProject().catch(() => {
      /* home still works if unpin fails */
    });
  }, []);

  const markReady = useCallback(() => {
    setSetupDone(true);
  }, []);

  const onSkip = useCallback(() => {
    writeLocal(SKIP_KEY, "1");
    setSetupDone(true);
  }, []);

  const canSwitchProject = () => {
    if (desktopCloseGuardArmed()) {
      setError(
        "Return to the recording project and stop the room before switching projects.",
      );
      return false;
    }
    return true;
  };

  const onCreate = async () => {
    if (!canSwitchProject()) return;
    setBusyAction("create");
    setError(null);
    try {
      const out = await createEpisodeProject(
        dir.trim(),
        name.trim() || "episode",
      );
      navigateToProject(out.project_path);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusyAction(null);
    }
  };

  const onOpen = async () => {
    if (!canSwitchProject()) return;
    setBusyAction("open");
    setError(null);
    try {
      const out = await openEpisodeProject(path.trim());
      navigateToProject(out.project_path);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusyAction(null);
    }
  };

  const onBrowse = async () => {
    if (!canSwitchProject()) return;
    setBusyAction("browse");
    setError(null);
    try {
      const picked = await pickEpisodeProject();
      if ("cancelled" in picked && picked.cancelled) {
        if (picked.detail) {
          setError(picked.detail);
        }
        setBusyAction(null);
        return;
      }
      if ("unavailable" in picked && picked.unavailable) {
        setError(
          picked.detail ||
            "No OS file dialog available; paste the path to episode.project.json.",
        );
        setBusyAction(null);
        return;
      }
      if (!("project_path" in picked)) {
        setBusyAction(null);
        return;
      }
      setPath(picked.project_path);
      const out = await openEpisodeProject(picked.project_path);
      navigateToProject(out.project_path);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusyAction(null);
    }
  };

  if (!setupDone) {
    return (
      <main className="cover home-screen">
        <div className="cover-center center stack">
          <BootstrapWizard onReady={markReady} onSkip={onSkip} />
        </div>
      </main>
    );
  }

  return (
    <main className="cover home-screen">
      <div className="cover-center center stack">
        <header className="stack">
          <h1 className="wordmark">Sharecut Studio</h1>
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
            <Button variant="primary" onClick={() => setMode("new")}>
              New project…
            </Button>
            <Button onClick={() => setMode("open")}>Open project…</Button>
            <Button onClick={() => setMcpOpen(true)}>Connect agent…</Button>
            <Button onClick={() => setHelpOpen(true)}>Help</Button>
          </div>
        ) : null}
        {mode === "new" ? (
          <form
            className="box elevated stack"
            onSubmit={(e) => {
              e.preventDefault();
              void onCreate();
            }}
          >
            <Field label="Name" htmlFor="home-episode-name">
              <input
                id="home-episode-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
                required
              />
            </Field>
            <Field label="Workspace directory" htmlFor="home-workspace-dir">
              <input
                id="home-workspace-dir"
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                placeholder="/path/to/my_episode"
                autoComplete="off"
                required
              />
            </Field>
            <div className="cluster">
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !dir.trim()}
              >
                {busyAction === "create" ? "Creating…" : "Create"}
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() => setMode("idle")}
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
              void onOpen();
            }}
          >
            <Field label="episode.project.json" htmlFor="home-project-path">
              <input
                id="home-project-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/path/to/episode.project.json"
                autoComplete="off"
                required
              />
            </Field>
            <div className="cluster">
              <Button
                type="button"
                disabled={busy}
                onClick={() => void onBrowse()}
              >
                {busyAction === "browse" ? "Browsing…" : "Browse…"}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !path.trim()}
              >
                {busyAction === "open" ? "Opening…" : "Open"}
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() => setMode("idle")}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </div>
      <HostMcpDialog
        open={mcpOpen}
        onClose={() => setMcpOpen(false)}
        hasProject={false}
      />
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </main>
  );
}
