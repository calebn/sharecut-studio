import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ArchiveLink } from "./ArchiveLink";

const ARCHIVE = {
  name: "ep-export.zip",
  count: 5,
  bytes: 2048,
  href: "/archive?ticket=t",
};

it("links the archive by its name and announces its count and size", async () => {
  const onStarted = vi.fn();
  render(
    <ArchiveLink
      archive={ARCHIVE}
      className="x-class"
      iconSize={16}
      onStarted={onStarted}
    />,
  );

  const link = screen.getByRole("link", {
    name: "Download all 5 files, 2 KB",
  });
  await userEvent.click(link);

  expect(link).toHaveAttribute("href", "/archive?ticket=t");
  expect(link).toHaveAttribute("download", "ep-export.zip");
  expect(link).toHaveClass("ui-control", "modifier-action", "x-class");
  expect(link).toHaveTextContent("Download all");
  expect(onStarted).toHaveBeenCalledTimes(1);
});

it("is a disabled button with the reason while an export runs", () => {
  render(
    <ArchiveLink archive={ARCHIVE} className="x-class" iconSize={16} running />,
  );

  expect(screen.queryByRole("link")).toBeNull();
  const button = screen.getByRole("button", {
    name: "Download all 5 files, 2 KB",
  });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute(
    "title",
    "Exporting now. Download when it finishes.",
  );
});
