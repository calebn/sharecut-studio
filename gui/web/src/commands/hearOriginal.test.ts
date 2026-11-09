import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

const mode = () => useDawStore.getState().auditionMode;
const hold = (on: boolean) =>
  execute("transport.hearOriginal", { on }, { skipWhen: true });

describe("transport.hearOriginal", () => {
  beforeEach(async () => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ tracks: [sampleTrack()] }));
    useDawStore.setState({ guestMode: null, auditionMode: "mix" });
    await hold(false);
  });

  it("plays the original while held and goes back to the mode it found", async () => {
    useDawStore.setState({ auditionMode: "fx" });
    await hold(true);
    expect(mode()).toBe("raw");
    await hold(false);
    expect(mode()).toBe("fx");
  });

  it("a release with no hold changes nothing", async () => {
    useDawStore.setState({ auditionMode: "fx" });
    await hold(false);
    expect(mode()).toBe("fx");
  });

  it("a second press while held keeps the first mode", async () => {
    await hold(true);
    await hold(true);
    await hold(false);
    expect(mode()).toBe("mix");
  });

  it("keeps a mode the user picked during the hold", async () => {
    await hold(true);
    useDawStore.setState({ auditionMode: "fx" });
    await hold(false);
    expect(mode()).toBe("fx");
  });

  it("does not take over an Original the user already chose", async () => {
    useDawStore.setState({ auditionMode: "raw" });
    await hold(true);
    await hold(false);
    expect(mode()).toBe("raw");
  });

  it("refuses silently for a guest", async () => {
    useDawStore.setState({ guestMode: "view" });
    expect(await hold(true)).toEqual({ status: "ok" });
    expect(mode()).toBe("mix");
  });

  it("is gated to the Edit stage", async () => {
    try {
      useDawStore.setState({ stage: "review" });
      expect(
        await execute("transport.hearOriginal", { on: true }),
      ).toMatchObject({ status: "disabled" });
    } finally {
      useDawStore.setState({ stage: "edit" });
    }
  });

  it("clears the hold when released as a guest, so the next press works", async () => {
    await hold(true);
    expect(mode()).toBe("raw");
    useDawStore.setState({ guestMode: "view" });
    await hold(false);
    useDawStore.setState({ guestMode: null, auditionMode: "mix" });
    await hold(true);
    expect(mode()).toBe("raw");
  });
});
