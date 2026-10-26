import { fn } from "storybook/test";
import type { HitRouter } from "../timeline/hitRouting";

export function hitRouterStub(): HitRouter {
  return {
    dispose: fn(),
    defers: fn(() => false),
    claimsClick: fn(() => false),
    longPress: fn(),
    choose: fn(),
    nextPage: fn(),
    openCreate: fn(() => true),
    close: fn(),
    disarm: fn(),
    adopt: fn(() => () => undefined),
  };
}
