import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { execute } from "../commands/execute";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { useDawKeymapListener } from "./listener";

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

function KeymapHost() {
  useDawKeymapListener();
  return (
    <>
      <button type="button">Boundary button</button>
      <div data-testid="canvas">Timeline canvas</div>
    </>
  );
}

beforeEach(() => {
  vi.mocked(execute).mockClear();
  useDawStore.getState().hydrate("/tmp/keymap-project", minimalProject());
});

it("gives a focused button native Space activation but keeps canvas Space for transport", async () => {
  const user = userEvent.setup();
  render(<KeymapHost />);
  const button = screen.getByRole("button", { name: "Boundary button" });
  button.focus();
  await user.keyboard(" ");
  await user.keyboard("{Enter}");
  expect(vi.mocked(execute)).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByTestId("canvas"), { key: " ", code: "Space" });
  await waitFor(() =>
    expect(vi.mocked(execute)).toHaveBeenCalledWith(
      "transport.togglePlay",
      expect.anything(),
      expect.objectContaining({ skipWhen: true }),
    ),
  );
});
