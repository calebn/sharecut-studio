import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { StatusLive } from "../stage/frame/StatusLive";
import { useDawStore } from "../state/dawStore";
import {
  PREFS_SENTENCE,
  reportStorageFailure,
  reportStorageOk,
  resetStorageHealth,
  storageSentence,
} from "../state/storageHealth";
import { DawProvider } from "../state/store";
import { minimalProject } from "../test/fixtures";
import { useStorageAnnouncement } from "./useStorageAnnouncement";

function Announcer() {
  useStorageAnnouncement();
  return null;
}

const full = () => new DOMException("full", "QuotaExceededError");
const blocked = () => new DOMException("no", "SecurityError");

const seq = () => useDawStore.getState().statusAnnouncementSeq;
const said = () => useDawStore.getState().statusAnnouncement;

describe("useStorageAnnouncement", () => {
  beforeEach(() => {
    resetStorageHealth();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({ statusAnnouncement: "", statusAnnouncementSeq: 0 });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <Announcer />
        <StatusLive />
      </DawProvider>,
    );
  });

  it("says nothing while storage works", () => {
    expect(seq()).toBe(0);
  });

  it("says a failure once, through the one status region and no toast, however many come", async () => {
    for (let i = 0; i < 5; i++)
      act(() => reportStorageFailure("snapshot", full()));
    act(() => reportStorageFailure("queue", full()));
    expect(seq()).toBe(1);
    expect(said()).toBe(storageSentence("full"));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      storageSentence("full"),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(useDawStore.getState().feedbackToast).toBeNull();
  });

  it("says a refused write once while reads keep working", () => {
    act(() => reportStorageFailure("queue", full()));
    for (let i = 0; i < 3; i++) {
      act(() => reportStorageOk("queue", "read"));
      act(() => reportStorageFailure("queue", full()));
    }
    expect(seq()).toBe(1);
    expect(said()).toBe(storageSentence("full"));
    act(() => reportStorageOk("queue"));
    act(() => reportStorageFailure("queue", full()));
    expect(seq()).toBe(2);
  });

  it("says it again only after the failure cleared", () => {
    act(() => reportStorageFailure("snapshot", blocked()));
    expect(seq()).toBe(1);
    act(() => reportStorageOk("snapshot"));
    expect(seq()).toBe(1);
    act(() => reportStorageFailure("snapshot", blocked()));
    expect(seq()).toBe(2);
    expect(said()).toBe(storageSentence("blocked"));
  });

  it("says the settings sentence for a settings failure, once", () => {
    act(() => reportStorageFailure("prefs", blocked()));
    act(() => reportStorageFailure("prefs", blocked()));
    expect(seq()).toBe(1);
    expect(said()).toBe(PREFS_SENTENCE);
  });
});
