import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { THEME_STORAGE_KEY, useTheme } from "./useTheme";

function Reader({ id }: { id: string }) {
  const { preference, setPreference } = useTheme();
  return (
    <button type="button" onClick={() => setPreference("dark")}>
      {id}:{preference}
    </button>
  );
}

afterEach(() => {
  window.localStorage.removeItem(THEME_STORAGE_KEY);
  delete document.documentElement.dataset.theme;
});

describe("useTheme across the page", () => {
  it("keeps the Project menu and the Settings sheet on the same choice", () => {
    render(
      <>
        <Reader id="menu" />
        <Reader id="settings" />
      </>,
    );
    act(() => screen.getByText("menu:system").click());
    expect(screen.getByText("menu:dark")).toBeInTheDocument();
    expect(screen.getByText("settings:dark")).toBeInTheDocument();
  });
});
