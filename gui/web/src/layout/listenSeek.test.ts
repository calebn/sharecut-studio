import { afterEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { skipListen } from "./listenSeek";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../commands/execute", () => ({ execute }));

describe("skipListen", () => {
  afterEach(() => {
    execute.mockClear();
    useDawStore.setState({ playheadSec: 0 });
  });

  it.each([
    [10, -15, 0],
    [40, -15, 25],
    [50, 15, 60],
    [20, 15, 35],
  ])("from %s s by %s s seeks to %s s", (from, delta, to) => {
    useDawStore.setState({ playheadSec: from });
    skipListen(delta, 60);
    expect(execute).toHaveBeenCalledWith(
      "transport.seek",
      { sec: to },
      { skipWhen: true },
    );
  });
});
