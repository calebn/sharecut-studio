import { SHARE_DEFAULTS, type ShareOptions } from "./shareLogic";

const noop = () => undefined;

/** What the Invite sheet and the Listen link get from the host's flow, with every action a no-op. Stories and tests pass their own spies. */
export function shareOptionsFixture(
  over: Partial<ShareOptions> = {},
): ShareOptions {
  return {
    rows: [],
    loaded: true,
    choices: SHARE_DEFAULTS,
    onChoices: noop,
    busy: false,
    recovery: { kind: "idle" },
    refreshFor: null,
    error: null,
    status: null,
    copiedKey: null,
    blockedKey: null,
    onCreate: noop,
    onRefreshMix: noop,
    onCopy: noop,
    onStop: noop,
    onCreateRecord: noop,
    onReplaceInvite: noop,
    onEndRoom: noop,
    ...over,
  };
}
