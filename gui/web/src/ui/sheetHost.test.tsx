import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SheetHostPlacement } from "./sheetHost";
import { createSheetHost } from "./useSheetHost";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function hostWithFocusedButton() {
  const host = createSheetHost(document);
  const button = document.createElement("button");
  host.container.append(button);
  document.body.append(host.container);
  button.focus();
  return { host, button };
}

describe("SheetHostPlacement", () => {
  it("places only its owned container in its own document and supports replay after detach", () => {
    const doc = document.implementation.createHTMLDocument("Sheet owner");
    const shell = doc.createElement("div");
    shell.className = "stage-frame";
    const main = doc.createElement("main");
    shell.append(main);
    doc.body.append(shell);
    const host = createSheetHost(doc);
    host.place(true, false);
    expect(host.container.ownerDocument).toBe(doc);
    expect(host.container.previousElementSibling).toBe(main);
    host.detach();
    host.detach();
    expect(host.container.parentElement).toBeNull();
    host.place(false, true);
    expect(host.container.parentElement).toBe(doc.body);
    expect(host.container.hasAttribute("inert")).toBe(true);
    expect(host.container.getAttribute("role")).toBe("presentation");
    host.detach();
  });

  it("keeps a stowed column interactive", () => {
    const doc = document.implementation.createHTMLDocument("Sheet owner");
    const shell = doc.createElement("div");
    shell.className = "stage-frame";
    const main = doc.createElement("main");
    shell.append(main);
    doc.body.append(shell);

    const host = createSheetHost(doc);
    host.place(false, true);
    expect(host.container.hasAttribute("inert")).toBe(true);

    host.place(true, true);
    expect(host.container.previousElementSibling).toBe(main);
    expect(host.container.hasAttribute("inert")).toBe(false);
  });

  it("does not move the container when its placement is unchanged", () => {
    const { host, button } = hostWithFocusedButton();
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { childList: true });
    try {
      host.place(false, false);
      expect(observer.takeRecords()).toEqual([]);
      expect(document.activeElement).toBe(button);
    } finally {
      observer.disconnect();
    }
  });

  it("drops focus held inside the host when it becomes inert", () => {
    const { host, button } = hostWithFocusedButton();
    expect(document.activeElement).toBe(button);
    const { rerender } = render(
      <SheetHostPlacement host={host} column={false} stowed={false} />,
    );
    expect(host.container).not.toHaveAttribute("inert");
    rerender(<SheetHostPlacement host={host} column={false} stowed />);
    expect(host.container).toHaveAttribute("inert");
    expect(document.activeElement).not.toBe(button);
  });

  it("leaves focus alone when the host stays live", () => {
    const { host, button } = hostWithFocusedButton();
    render(<SheetHostPlacement host={host} column={false} stowed={false} />);
    expect(document.activeElement).toBe(button);
  });
});
