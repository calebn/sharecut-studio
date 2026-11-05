import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  ConnectAgentSheet,
  type ConnectAgentSheetProps,
} from "./ConnectAgentSheet";

const URL = "http://127.0.0.1:8765/mcp";

function setup(props: Partial<ConnectAgentSheetProps> = {}) {
  const onCopy = vi.fn(async () => undefined);
  const onOpenRecent = vi.fn();
  const view = render(
    <ConnectAgentSheet
      form="centered"
      open
      onClose={vi.fn()}
      url={URL}
      hasProject
      connected={null}
      onCopy={onCopy}
      onOpenRecent={onOpenRecent}
      {...props}
    />,
  );
  return { ...view, onCopy, onOpenRecent, user: userEvent.setup() };
}

describe("ConnectAgentSheet", () => {
  it("picks a client and shows the one block that client needs", async () => {
    const { user } = setup();
    const claude = screen.getByRole("button", { name: "Claude" });
    expect(claude).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("MCP URL")).toHaveValue(URL);
    await user.click(screen.getByRole("button", { name: "Cursor" }));
    const config = screen.getByLabelText<HTMLTextAreaElement>("Cursor config");
    expect(JSON.parse(config.value)).toEqual({
      mcpServers: { sharecut: { url: URL } },
    });
    await user.click(screen.getByRole("button", { name: "Other" }));
    expect(screen.getByLabelText("MCP URL")).toHaveValue(URL);
  });

  it("has one read-only block and one Copy", () => {
    setup();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getByLabelText("MCP URL")).toHaveAttribute("readonly");
    expect(screen.getAllByRole("button", { name: /^Cop/ })).toHaveLength(1);
  });

  it("copies what the chosen client needs and says Copied", async () => {
    const { user, onCopy } = setup({ defaultClient: "cursor" });
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(onCopy).toHaveBeenCalledWith(
      JSON.stringify({ mcpServers: { sharecut: { url: URL } } }, null, 2),
    );
    expect(
      await screen.findByRole("button", { name: "Copied" }),
    ).toBeInTheDocument();
  });

  it("says when the copy fails and where to copy from instead", async () => {
    const { user } = setup({
      onCopy: vi.fn(async () => {
        throw new Error("Clipboard unavailable");
      }),
    });
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(
      await screen.findByText("Couldn't copy. Select the text and copy it."),
    ).toBeInTheDocument();
  });

  it("says Not connected yet until an agent joins, then names it", () => {
    const { rerender } = setup();
    expect(screen.getByText("Not connected yet")).toBeInTheDocument();
    rerender(
      <ConnectAgentSheet
        form="centered"
        open
        onClose={vi.fn()}
        url={URL}
        hasProject
        connected="Claude"
        onCopy={vi.fn()}
        onOpenRecent={vi.fn()}
      />,
    );
    expect(screen.getByText("Connected: Claude")).toBeInTheDocument();
    expect(screen.queryByText("Not connected yet")).toBeNull();
  });

  it("asks for an episode first, with a way to Recent", async () => {
    const { user, onOpenRecent } = setup({ hasProject: false });
    expect(
      screen.getByText(
        /Open an episode first\. The agent works on the open episode\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Not connected yet")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Recent" }));
    expect(onOpenRecent).toHaveBeenCalledOnce();
  });

  it("has no accessibility violations", async () => {
    const { baseElement } = setup({ connected: "Claude" });
    await expectNoA11yViolations(baseElement);
  });

  it("has no accessibility violations with no episode", async () => {
    const { baseElement } = setup({ hasProject: false, form: "bottom" });
    await expectNoA11yViolations(baseElement);
  });
});
