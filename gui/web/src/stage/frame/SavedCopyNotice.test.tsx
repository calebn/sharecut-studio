import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DawProvider } from "../../state/store";
import { minimalProject } from "../../test/fixtures";
import { BannerStack } from "./BannerStack";

vi.mock("./GuestVersionNotice", () => ({ GuestVersionNotice: () => null }));

function mount(shareCapabilities: string[] | null) {
  return render(
    <DawProvider
      projectPath="share:tok"
      initialProject={minimalProject()}
      guestMode="view"
      shareCapabilities={shareCapabilities}
    >
      <BannerStack guestShare />
    </DawProvider>,
  );
}

describe("saved copy notice", () => {
  it("says a guest without capabilities is viewing a read-only saved copy", () => {
    mount(null);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing a saved copy because the host can't be reached. It is read-only.",
    );
  });

  it("stays away from a live guest link", () => {
    mount(["view", "play"]);
    expect(screen.queryByText(/saved copy/)).not.toBeInTheDocument();
  });
});
