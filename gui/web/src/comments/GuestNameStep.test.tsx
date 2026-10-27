import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { GuestNameStep } from "./GuestNameStep";

it("mounts the polite prompt empty, then fills it so it is announced", async () => {
  render(
    <GuestNameStep
      name=""
      onNameChange={vi.fn()}
      onConfirm={vi.fn()}
      onPostAsGuest={vi.fn()}
      busy={false}
    />,
  );
  const region = screen.getByRole("status");
  expect(region).toBeEmptyDOMElement();
  expect(await screen.findByText(/Add your name/)).toBe(region);
});
