import { act, render } from "@testing-library/react";
import { type ReactNode, useLayoutEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useShellAttributes } from "./useShellAttributes";

const root = document.documentElement;

function Frame() {
  useShellAttributes();
  return null;
}

function Home() {
  useShellAttributes("home");
  return null;
}

/** What `html[data-shell]` held when this component's layout effect ran: after every layout effect before it, before any passive one. */
function SeenAtLayout({ into }: { into: (shell: string | undefined) => void }) {
  useLayoutEffect(() => {
    into(root.dataset.shell);
  });
  return null;
}

const shown = (...children: ReactNode[]) => <>{children}</>;

afterEach(() => {
  delete root.dataset.shell;
  delete root.dataset.surface;
});

describe("useShellAttributes", () => {
  it("has written html[data-shell] by the end of the commit that mounts the frame, before any passive effect", () => {
    const seen: (string | undefined)[] = [];
    render(
      shown(
        <Frame key="frame" />,
        <SeenAtLayout key="probe" into={(shell) => seen.push(shell)} />,
      ),
    );
    expect(seen[0]).toBeDefined();
    expect(seen[0]).toBe(root.dataset.shell);
  });

  it("still has data-shell after Home is swapped for the frame in one commit, and no data-surface", () => {
    const seen: (string | undefined)[] = [];
    const { rerender } = render(shown(<Home key="home" />));
    expect(root.dataset.surface).toBe("home");
    const shellOnHome = root.dataset.shell;
    expect(shellOnHome).toBeDefined();
    rerender(
      shown(
        <Frame key="frame" />,
        <SeenAtLayout key="probe" into={(shell) => seen.push(shell)} />,
      ),
    );
    expect(seen.at(-1)).toBeDefined();
    expect(root.dataset.shell).toBe(shellOnHome);
    expect(root.dataset.surface).toBeUndefined();
  });

  it("removes both attributes when the last user unmounts", () => {
    const { unmount } = render(<Home />);
    act(() => unmount());
    expect(root.dataset.shell).toBeUndefined();
    expect(root.dataset.surface).toBeUndefined();
  });
});
