import type { CommentDraft } from "./types";

/** What the phone Listen layout shows above the dock, one at a time. */
export type Surface = "none" | "composer" | "comments" | "thread" | "chapters";

/**
 * The comment being written. `anchor` is the pin: it is set when a draft
 * starts, and again when an empty one is opened; a draft with text keeps it.
 * `resume` means the composer paused playback and nothing has touched the
 * transport since. `typed` marks a draft the first keystroke made, which goes
 * away when the field is emptied again.
 */
export type ComposerDraft = {
  text: string;
  anchor: CommentDraft;
  resume: boolean;
  typed: boolean;
};

export type ComposerSession = {
  surface: Surface;
  /** The comment a `thread` surface shows. */
  threadId: string | null;
  draft: ComposerDraft | null;
  /** The anchor of a typed draft that was just emptied, for Undo. */
  dropped: CommentDraft | null;
  /** The one Post in flight. */
  post: { id: number; sentText: string } | null;
  /** The composer paused playback and the pause has not reached the transport yet. */
  pausing: boolean;
};

export type ComposerEvent =
  /** Any way to start a comment. `replacePin`: the anchor was chosen (a range, a time), not "here". */
  | { type: "open"; anchor: CommentDraft; replacePin: boolean }
  | {
      type: "type";
      text: string;
      /** The anchor a draft made now would take. */
      fresh: CommentDraft;
      composing?: boolean;
      undo?: boolean;
    }
  /** Play, Pause or the end of the episode, from the listener or the engine. */
  | { type: "transport"; playing: boolean }
  | { type: "close" }
  | { type: "discard" }
  | {
      type: "show";
      surface: "none" | "comments" | "thread" | "chapters";
      threadId?: string;
    }
  /** The layout that hosted the sheets is gone. */
  | { type: "sheetsGone" }
  | { type: "postStart"; id: number }
  | { type: "postDone"; id: number }
  | { type: "postFailed"; id: number }
  | { type: "reset" };

export type ComposerEffect = "pause" | "play";

export const initialSession: ComposerSession = {
  surface: "none",
  threadId: null,
  draft: null,
  dropped: null,
  post: null,
  pausing: false,
};

type Context = { playing: boolean };
type Result = { state: ComposerSession; effects: ComposerEffect[] };

const same = (state: ComposerSession): Result => ({ state, effects: [] });

/** Leaves the composer: plays on what it paused, keeps what was typed (or not). */
function leave(
  s: ComposerSession,
  ctx: Context,
  keepText: boolean,
  surface: Surface = "none",
  threadId: string | null = null,
): Result {
  const draft = s.draft;
  return {
    state: {
      ...s,
      surface,
      threadId,
      draft:
        draft && keepText && draft.text ? { ...draft, resume: false } : null,
      dropped: null,
      pausing: false,
    },
    effects: draft?.resume && !ctx.playing ? ["play"] : [],
  };
}

const SHEETS: readonly Surface[] = ["comments", "thread", "chapters"];

/** The composer session: every event from every state, no React and no store. */
export function reduceComposer(
  s: ComposerSession,
  e: ComposerEvent,
  ctx: Context,
): Result {
  switch (e.type) {
    case "open": {
      const held = s.draft;
      const keepPin = held !== null && held.text !== "" && !e.replacePin;
      return {
        state: {
          ...s,
          surface: "composer",
          threadId: null,
          draft: {
            text: held?.text ?? "",
            anchor: keepPin ? held.anchor : e.anchor,
            resume: ctx.playing || held?.resume === true,
            typed: false,
          },
          dropped: null,
          pausing: ctx.playing || s.pausing,
        },
        effects: ctx.playing ? ["pause"] : [],
      };
    }
    case "type": {
      const draft = s.draft;
      if (!draft) {
        if (!e.text) return same(s);
        return same({
          ...s,
          surface: "composer",
          threadId: null,
          draft: {
            text: e.text,
            anchor: e.undo && s.dropped ? s.dropped : e.fresh,
            resume: false,
            typed: true,
          },
          dropped: null,
        });
      }
      if (!e.text && !e.composing && draft.typed)
        return same({
          ...s,
          surface: "none",
          draft: null,
          dropped: draft.anchor,
        });
      return same({ ...s, draft: { ...draft, text: e.text } });
    }
    case "transport": {
      if (s.pausing) {
        const settled = { ...s, pausing: false };
        if (!e.playing) return same(settled);
        return same(withoutResume(settled));
      }
      return same(withoutResume(s));
    }
    case "close":
      return leave(s, ctx, true);
    case "discard":
      return leave(s, ctx, false);
    case "show": {
      const threadId = e.surface === "thread" ? (e.threadId ?? null) : null;
      if (s.surface === "composer")
        return leave(s, ctx, true, e.surface, threadId);
      return same({ ...s, surface: e.surface, threadId });
    }
    case "sheetsGone":
      return SHEETS.includes(s.surface)
        ? same({ ...s, surface: "none", threadId: null })
        : same(s);
    case "postStart":
      if (s.post || !s.draft) return same(s);
      return same({ ...s, post: { id: e.id, sentText: s.draft.text } });
    case "postDone": {
      if (s.post?.id !== e.id) return same(s);
      const { sentText } = s.post;
      const draft = s.draft;
      if (draft?.text !== sentText) return same({ ...s, post: null });
      return {
        state: {
          ...s,
          surface: s.surface === "composer" ? "none" : s.surface,
          draft: null,
          dropped: null,
          post: null,
          pausing: false,
        },
        effects: draft.resume && !ctx.playing ? ["play"] : [],
      };
    }
    case "postFailed":
      return s.post?.id === e.id ? same({ ...s, post: null }) : same(s);
    case "reset":
      return same(initialSession);
  }
}

function withoutResume(s: ComposerSession): ComposerSession {
  return s.draft?.resume ? { ...s, draft: { ...s.draft, resume: false } } : s;
}

/** The anchor the comment would post at while the composer is open. */
export function commentDraftOf(s: ComposerSession): CommentDraft | null {
  return s.surface === "composer" && s.draft ? s.draft.anchor : null;
}

/** The store fields one session value fills in. */
export function composerPatch(composer: ComposerSession) {
  return { composer, commentDraft: commentDraftOf(composer) };
}

/** The listener touched the transport. */
export function afterTransport(
  s: { composer: ComposerSession },
  playing: boolean,
) {
  const { state } = reduceComposer(
    s.composer,
    { type: "transport", playing },
    {
      playing,
    },
  );
  return state === s.composer ? {} : composerPatch(state);
}
