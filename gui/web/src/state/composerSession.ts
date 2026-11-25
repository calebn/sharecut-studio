import type { CommentDraft } from "./types";

export type Surface =
  | "none"
  | "composer"
  | "wideComposer"
  | "comments"
  | "thread"
  | "chapters";

export function isComposerSurface(surface: Surface): boolean {
  return surface === "composer" || surface === "wideComposer";
}

/**
 * The comment being written. `anchor` is the pin: it is set when a draft
 * starts, and again when an empty one is opened; a draft with text keeps it.
 * `resume` means the composer paused playback and nothing has touched the
 * transport since. `typed` marks a draft the first keystroke made, which goes
 * away when the field is emptied again.
 */
export type ComposerDraft = {
  text: string;
  /** Null while text was typed with a selection whose words are refreshing: the next keystroke that resolves pins it. */
  anchor: CommentDraft | null;
  resume: boolean;
  typed: boolean;
};

export type ComposerSession = {
  surface: Surface;
  /** The comment a `thread` surface shows. */
  threadId: string | null;
  draft: ComposerDraft | null;
  dropped: {
    surface: "composer" | "wideComposer";
    anchor: CommentDraft | null;
  } | null;
  /** The one Post in flight. */
  post: { id: number; sentText: string } | null;
  /** The composer paused playback and the pause has not reached the transport yet. */
  pausing: boolean;
};

export type ComposerEvent =
  /**
   * Any way to start a comment. `replacePin`: the anchor was chosen (a range,
   * a time), not "here". `listen`: the phone Listen layout hosts the composer,
   * so it pauses playback and keeps the pin with the text; elsewhere it does neither.
   */
  | { type: "open"; anchor: CommentDraft; replacePin: boolean; listen: boolean }
  | { type: "restore"; text: string; anchor: CommentDraft }
  | {
      type: "type";
      text: string;
      /** The anchor a draft made now would take; null while it cannot be known. */
      fresh: CommentDraft | null;
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
  | { type: "layout"; listen: boolean }
  | { type: "postStart"; id: number }
  | { type: "postDone"; id: number }
  | { type: "postFailed"; id: number }
  /** The guest may no longer comment: leaves like discard, and drops a Post in flight. */
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
        draft && keepText && draft.text.trim()
          ? { ...draft, resume: false }
          : null,
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
      const keepPin =
        e.listen && held !== null && held.text !== "" && !e.replacePin;
      const pause = e.listen && ctx.playing;
      return {
        state: {
          ...s,
          surface: "composer",
          threadId: null,
          draft: {
            text: held?.text ?? "",
            anchor: keepPin ? (held.anchor ?? e.anchor) : e.anchor,
            resume: pause || held?.resume === true,
            typed: false,
          },
          dropped: null,
          pausing: pause || s.pausing,
        },
        effects: pause ? ["pause"] : [],
      };
    }
    case "restore":
      if (s.post || s.draft?.text || !e.text) return same(s);
      return same({
        ...s,
        surface: "composer",
        threadId: null,
        draft: {
          text: e.text,
          anchor: e.anchor,
          resume: s.draft?.resume ?? false,
          typed: true,
        },
        dropped: null,
      });
    case "type": {
      const { draft, dropped } = s;
      if (!draft) {
        if (!e.text) return same(s);
        return same({
          ...s,
          surface: dropped?.surface ?? "composer",
          threadId: null,
          draft: {
            text: e.text,
            anchor: e.undo ? (dropped?.anchor ?? e.fresh) : e.fresh,
            resume: false,
            typed: true,
          },
          dropped: null,
        });
      }
      const wide = s.surface === "wideComposer";
      if (!e.text && !e.composing && (draft.typed || wide))
        return same({
          ...s,
          surface: "none",
          draft: null,
          dropped: {
            surface: wide ? "wideComposer" : "composer",
            anchor: draft.anchor,
          },
        });
      return same({
        ...s,
        draft: {
          ...draft,
          text: e.text,
          anchor: draft.anchor ?? e.fresh,
        },
      });
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
      if (isComposerSurface(s.surface))
        return leave(s, ctx, true, e.surface, threadId);
      return same({ ...s, surface: e.surface, threadId });
    }
    case "layout": {
      if (e.listen) {
        return s.surface === "wideComposer"
          ? same({
              ...s,
              surface: "none",
              draft: s.draft?.text.trim() ? s.draft : null,
            })
          : same(s);
      }
      if (s.draft?.text && !isComposerSurface(s.surface))
        return same({ ...s, surface: "wideComposer", threadId: null });
      return SHEETS.includes(s.surface)
        ? same({ ...s, surface: "none", threadId: null })
        : same(s);
    }
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
          surface: isComposerSurface(s.surface) ? "none" : s.surface,
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
      return { ...leave(s, ctx, false), state: initialSession };
  }
}

function withoutResume(s: ComposerSession): ComposerSession {
  return s.draft?.resume ? { ...s, draft: { ...s.draft, resume: false } } : s;
}

/** The anchor the comment would post at while the composer is open. */
export function commentDraftOf(s: ComposerSession): CommentDraft | null {
  return isComposerSurface(s.surface) && s.draft ? s.draft.anchor : null;
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

/** An explicit Stop cancels resumption even if the composer already paused playback. */
export function afterStop(s: { composer: ComposerSession }) {
  const composer = withoutResume(s.composer);
  if (composer.pausing) return composerPatch({ ...composer, pausing: false });
  return composer === s.composer ? {} : composerPatch(composer);
}
