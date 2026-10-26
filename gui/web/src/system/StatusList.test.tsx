import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { StatusList } from "./StatusList";
import { StatusRow } from "./StatusRow";

describe("StatusList", () => {
  it("is a named list with one item per row", () => {
    render(
      <StatusList label="Getting ready">
        <StatusRow state="done" title="Add audio" />
        <StatusRow state="running" title="Transcribe" progress={0.5} />
        <StatusRow state="queued" title="Clean and level" />
      </StatusList>,
    );
    const list = screen.getByRole("list", { name: "Getting ready" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  });

  it("skips children that are false or null", () => {
    render(
      <StatusList label="Getting ready">
        {false}
        {null}
        <StatusRow state="done" title="Add audio" />
      </StatusList>,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("names each row's state in text, not colour alone", () => {
    render(
      <StatusList label="Getting ready">
        <StatusRow state="needs-you" title="Line up tracks" />
        <StatusRow state="failed" title="Transcribe" />
      </StatusList>,
    );
    const [needs, failed] = screen.getAllByRole("listitem");
    expect(within(needs).getByText("Needs you")).toBeInTheDocument();
    expect(within(failed).getByText("Failed")).toBeInTheDocument();
  });

  it("keeps the one action of a row as the only button of its item", async () => {
    const onAction = vi.fn();
    render(
      <StatusList label="Getting ready">
        <StatusRow
          state="failed"
          title="Transcribe"
          action={{ label: "Try again", onAction }}
        />
      </StatusList>,
    );
    const item = screen.getByRole("listitem");
    expect(within(item).getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("nests a list inside an expanded row", async () => {
    function Demo() {
      const [open, setOpen] = useState(false);
      return (
        <StatusList label="Getting ready">
          <StatusRow
            state="running"
            title="Transcribe"
            expanded={open}
            onToggle={() => setOpen(!open)}
          >
            <StatusList label="Transcribe tracks">
              <StatusRow state="done" title="Maya" density="inline" />
              <StatusRow state="running" title="Rosa" density="inline" />
            </StatusList>
          </StatusRow>
          <StatusRow state="queued" title="Clean and level" />
        </StatusList>
      );
    }
    render(<Demo />);
    expect(screen.getAllByRole("list")).toHaveLength(1);
    const toggle = screen.getByRole("button", { name: /Transcribe/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const inner = screen.getByRole("list", { name: "Transcribe tracks" });
    expect(within(inner).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getAllByRole("list")).toHaveLength(2);
  });
});
