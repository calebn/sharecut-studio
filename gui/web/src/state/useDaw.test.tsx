import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import { useDawStore } from "./dawStore";
import type { DawState } from "./types";
import { pickDaw, useDaw } from "./useDaw";

let initialState: DawState | undefined;
const selectPathAndPlaying = pickDaw("projectPath", "isPlaying");

afterEach(() => {
  const state = initialState;
  initialState = undefined;
  if (state !== undefined) {
    act(() => useDawStore.setState(state));
  }
});

describe("pickDaw", () => {
  it("selects exactly the requested fields and preserves their references", () => {
    const project = minimalProject();
    const state: DawState = {
      ...useDawStore.getState(),
      project,
      projectPath: "/tmp/selected.project.json",
      isPlaying: true,
    };
    const selected = pickDaw("project", "projectPath", "isPlaying")(state);

    expect(Object.keys(selected)).toEqual([
      "project",
      "projectPath",
      "isPlaying",
    ]);
    expect(selected.project).toBe(state.project);
    expect(selected.projectPath).toBe("/tmp/selected.project.json");
    expect(selected.isPlaying).toBe(true);
  });

  it("handles empty and duplicate key lists", () => {
    const state = useDawStore.getState();

    expect(pickDaw()(state)).toEqual({});
    expect(pickDaw("projectPath", "projectPath")(state)).toEqual({
      projectPath: state.projectPath,
    });
  });

  it("selects every governed hot field when requested", () => {
    const selected = pickDaw(
      "playheadSec",
      "scrollLeft",
      "sessionClients",
      "pointerTrackId",
      "bladeHoverSec",
    )(useDawStore.getState());

    expect(Object.keys(selected)).toEqual([
      "playheadSec",
      "scrollLeft",
      "sessionClients",
      "pointerTrackId",
      "bladeHoverSec",
    ]);
  });

  it("keeps the selected key union constrained to DawState keys", () => {
    expectTypeOf<
      "missingField" extends Parameters<typeof pickDaw>[number] ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf(pickDaw("projectPath", "isPlaying")).toEqualTypeOf<
      (state: DawState) => Pick<DawState, "projectPath" | "isPlaying">
    >();
  });

  it("rerenders only when a selected value changes", () => {
    initialState = useDawStore.getState();
    act(() =>
      useDawStore.setState({
        projectPath: "/tmp/pick-daw.project.json",
        isPlaying: false,
        audioError: null,
      }),
    );
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useDaw(selectPathAndPlaying);
    });
    const initialRenders = renders;
    const initialSelection = result.current;
    expect(initialSelection).toEqual({
      projectPath: "/tmp/pick-daw.project.json",
      isPlaying: false,
    });

    act(() => useDawStore.setState({ audioError: "unselected change" }));
    expect(renders).toBe(initialRenders);
    expect(result.current).toBe(initialSelection);

    const nextIsPlaying = true;
    act(() => useDawStore.setState({ isPlaying: nextIsPlaying }));
    expect(renders).toBe(initialRenders + 1);
    expect(result.current).toEqual({
      projectPath: "/tmp/pick-daw.project.json",
      isPlaying: nextIsPlaying,
    });
  });
});
