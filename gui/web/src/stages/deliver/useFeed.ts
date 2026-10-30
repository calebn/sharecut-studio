import { useCallback, useEffect, useRef, useState } from "react";
import { loadFeed, sendFeedEdit, sendFeedWrite } from "../../api";
import { feedErrorText } from "./feedErrors";
import { type FeedAccess, fixBlock, previewEdit } from "./feedLogic";
import type {
  FeedEdit,
  Fix,
  PinAuthor,
  Served,
  WriteRequest,
} from "../../types/feedView";

export type FeedLoad = "loading" | "ready" | "error";

export type FeedData = {
  load: FeedLoad;
  served: Served | null;
  request: WriteRequest | undefined;
  /** The last thing that went wrong, in plain words. The next action clears it. */
  problem: string | null;
  /** Sends one edit or command in the vocabulary the CLI and MCP share. */
  act: (fix: Fix) => void;
  /** Reads the listing again without blanking it, such as after an export. */
  refresh: () => void;
  dismissProblem: () => void;
};

type Options = {
  /** Who is looking. A guest's values are marked as a guest's until the service answers, and a fix this link may not start is dropped here too. */
  access: FeedAccess;
  /** Reload when this changes, such as the project's history head or the finish of an export. */
  refreshKey?: string;
  /** A command only the host's app can run, such as exporting. */
  onCommand?: (fix: Fix) => void;
};

const SHOW_KEY = "show";

/** An edit the view shows ahead of the service, with the author its pin will carry. */
type Preview = { edit: FeedEdit; by: PinAuthor };

/** The edit a show command stands for; the service takes both as a set of `show`. */
function showEdit(fix: Fix): FeedEdit | null {
  if (fix.kind !== "command") return null;
  if (fix.command === "create_show" && fix.args?.title)
    return { op: "set", key: SHOW_KEY, value: fix.args.title };
  if (fix.command === "link_show" && fix.args?.id)
    return { op: "set", key: SHOW_KEY, value: fix.args.id, link: true };
  return null;
}

/**
 * The Podcast listing from the service for one project path, or one share key. A new path needs a new hook, so mount it with the path as its key. Edits and the
 * write go out one at a time. A set value shows at once as pinned, and each answer replaces
 * the view with the service's own, so the screen never keeps a guess.
 */
export function useFeed(
  projectPath: string | null,
  { access, refreshKey, onCommand }: Options,
): FeedData {
  const [load, setLoad] = useState<FeedLoad>("loading");
  const [served, setServed] = useState<Served | null>(null);
  const [request, setRequest] = useState<WriteRequest | undefined>();
  const [problem, setProblem] = useState<string | null>(null);
  const truth = useRef<Served | null>(null);
  const waiting = useRef<Preview[]>([]);
  /** Edits the command queue accepted but has not applied: they keep showing until the history head moves. */
  const parked = useRef<Preview[]>([]);
  const chain = useRef<Promise<void>>(Promise.resolve());
  /** Every enqueue and every answer bumps this, so a read that started earlier never lands over a newer view. */
  const latestRead = useRef(0);
  /** The history head moved since the last read, so queued edits have had their chance to land. */
  const moved = useRef(false);
  const path = useRef(projectPath);
  const by = access === "host" ? "person" : "guest";

  const show = useCallback((next: Served | null) => {
    truth.current = next;
    setServed(
      next && {
        ...next,
        view: [...parked.current, ...waiting.current].reduce(
          (view, one) => previewEdit(view, one.edit, one.by),
          next.view,
        ),
      },
    );
  }, []);

  const read = useCallback(
    async (quiet: boolean) => {
      if (projectPath === null) return;
      const mine = ++latestRead.current;
      try {
        const next = await loadFeed(projectPath);
        if (mine !== latestRead.current || path.current !== projectPath) return;
        if (quiet && moved.current) {
          moved.current = false;
          parked.current = [];
        }
        show(next);
        setLoad("ready");
      } catch (error) {
        if (mine !== latestRead.current || path.current !== projectPath) return;
        setProblem(feedErrorText(error));
        if (!quiet || !truth.current) setLoad("error");
      }
    },
    [projectPath, show],
  );

  useEffect(() => {
    path.current = projectPath;
    // oxlint-disable-next-line react/set-state-in-effect -- reading the service is the external system; state is set only after the awaited answer
    void read(false);
    return () => {
      latestRead.current += 1;
    };
  }, [projectPath, read]);

  const first = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === first.current) return;
    first.current = refreshKey;
    moved.current = true;
    void read(true);
  }, [refreshKey, read]);

  const enqueue = useCallback(
    (
      task: () => Promise<Served | null>,
      edit: Preview | null,
      writing: boolean,
    ) => {
      if (projectPath === null) return;
      setProblem(null);
      if (edit) {
        waiting.current = [...waiting.current, edit];
        show(truth.current);
      }
      if (writing) setRequest("writing");
      latestRead.current += 1;
      chain.current = chain.current.then(async () => {
        if (path.current !== projectPath) return;
        try {
          const next = await task();
          if (edit) waiting.current = waiting.current.slice(1);
          if (path.current !== projectPath) return;
          latestRead.current += 1;
          if (next === null && edit) parked.current = [...parked.current, edit];
          show(next ?? truth.current);
          if (writing) setRequest(undefined);
        } catch (error) {
          if (edit) waiting.current = waiting.current.slice(1);
          if (path.current !== projectPath) return;
          show(truth.current);
          setProblem(feedErrorText(error));
          if (writing) setRequest("failed");
        }
      });
    },
    [projectPath, show],
  );

  const act = useCallback(
    (fix: Fix) => {
      if (projectPath === null) return;
      const blocked = fixBlock(access, fix);
      if (blocked) {
        setProblem(blocked);
        return;
      }
      const edit = fix.kind === "edit" ? fix.edit : showEdit(fix);
      if (edit) {
        const author = fix.kind === "edit" && fix.by ? fix.by : by;
        enqueue(
          () => sendFeedEdit(projectPath, edit, author),
          { edit, by: author },
          false,
        );
        return;
      }
      if (fix.kind === "command" && fix.command === "write_feed")
        enqueue(() => sendFeedWrite(projectPath), null, true);
      else if (fix.kind === "command") onCommand?.(fix);
    },
    [projectPath, enqueue, onCommand, by, access],
  );

  return {
    load,
    served,
    request,
    problem,
    act,
    refresh: useCallback(() => {
      setLoad((now) => (now === "error" ? "loading" : now));
      void read(true);
    }, [read]),
    dismissProblem: useCallback(() => setProblem(null), []),
  };
}
