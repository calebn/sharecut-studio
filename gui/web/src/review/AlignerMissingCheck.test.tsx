import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ModelState, useWordTiming } from "../models";
import { ModelsContext } from "../models/useModels";
import { useDawStore } from "../state/dawStore";
import { reviewContent } from "../storybook/reviewContent";
import { QUEUE_WITHOUT_CHECKS } from "../storybook/reviewFixtures";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import {
  modelStatus,
  modelsApi,
  registryRows,
  renderWithLanding,
} from "../test/renderWithModels";
import { AlignerMissingCheck } from "./AlignerMissingCheck";
import { ReviewQueue, type ReviewQueueProps } from "./ReviewQueue";

const TITLE = "Cuts may clip word edges until word timing is installed";
const TARGET = {
  id: "word-aligner",
  variant: "wav2vec2",
  label: "Word aligner",
  size: "~360 MB",
};

type Api = ReturnType<typeof modelsApi>;

function withAligner(state: ModelState, over: Partial<Api> = {}): Api {
  const api = modelsApi({ status: modelStatus(registryRows()) });
  return {
    ...api,
    ...over,
    models:
      api.models?.map((row) =>
        row.id === "word-aligner" ? { ...row, state } : row,
      ) ?? null,
  };
}

function host(api: ReturnType<typeof modelsApi>) {
  return ({ children }: { children: ReactNode }) => (
    <ModelsContext.Provider value={api}>{children}</ModelsContext.Provider>
  );
}

const FAILED: ModelState = {
  kind: "failed",
  failure: { kind: "network", plain: "The download stopped." },
};

const DOWNLOADING: ModelState = {
  kind: "downloading",
  bytes: 90_000_000,
  total: 360_000_000,
};

describe("AlignerMissingCheck", () => {
  it("says cuts may clip word edges and offers Get", async () => {
    const download = vi.fn(async () => ({ kind: "ok" as const }));
    render(<AlignerMissingCheck model={TARGET} />, {
      wrapper: host(withAligner({ kind: "missing" }, { download })),
    });
    expect(screen.getByText(TITLE)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Get word timing" }),
    );
    expect(download).toHaveBeenCalledWith(["word-aligner"], undefined);
  });

  it("hands focus to Cancel when Get starts the download, and back to Try again when it fails", async () => {
    const control: { set: (state: ModelState) => void } = {
      set: () => undefined,
    };
    function Machine() {
      const [state, setState] = useState<ModelState>({ kind: "missing" });
      useEffect(() => {
        control.set = setState;
      }, []);
      const api = withAligner(state, {
        download: vi.fn(async () => {
          setState(DOWNLOADING);
          return { kind: "ok" as const };
        }),
      });
      return (
        <ModelsContext.Provider value={api}>
          <AlignerMissingCheck model={TARGET} />
        </ModelsContext.Provider>
      );
    }
    render(<Machine />);
    await userEvent.click(
      screen.getByRole("button", { name: "Get word timing" }),
    );
    const cancel = await screen.findByRole("button", {
      name: "Cancel word timing download",
    });
    expect(cancel).toHaveFocus();
    await userEvent.click(cancel);
    act(() => control.set(FAILED));
    expect(
      await screen.findByRole("button", {
        name: "Try getting word timing again",
      }),
    ).toHaveFocus();
  });

  it("shows progress with Cancel while the download runs, without the Check title", () => {
    render(<AlignerMissingCheck model={TARGET} />, {
      wrapper: host(withAligner(DOWNLOADING)),
    });
    expect(screen.getByText("Getting word timing")).toBeVisible();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cancel word timing download" }),
    ).toBeVisible();
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("offers Try again when the download failed", () => {
    render(<AlignerMissingCheck model={TARGET} />, {
      wrapper: host(withAligner(FAILED)),
    });
    expect(screen.getByText("Couldn't get word timing")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Try getting word timing again" }),
    ).toBeVisible();
  });

  it("says Update, not Get, when the installed model is out of date", () => {
    render(<AlignerMissingCheck model={TARGET} />, {
      wrapper: host(withAligner({ kind: "update_needed" })),
    });
    expect(screen.getByText("Needs an update for word timing")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Update word timing" }),
    ).toHaveTextContent("Update");
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("disables Get with a reason while another download holds the slot", () => {
    render(<AlignerMissingCheck model={TARGET} />, {
      wrapper: host(withAligner({ kind: "missing" }, { busy: true })),
    });
    expect(
      screen.getByRole("button", { name: "Get word timing" }),
    ).toBeDisabled();
    expect(screen.getByText("Another download is running")).toBeVisible();
  });

  it("has no accessibility violations while asking and while downloading", async () => {
    const asking = render(<AlignerMissingCheck model={TARGET} />, {
      wrapper: host(withAligner({ kind: "missing" })),
    });
    await expectNoA11yViolations(asking.container);
    asking.unmount();
    const running = render(<AlignerMissingCheck model={TARGET} />, {
      wrapper: host(withAligner(DOWNLOADING)),
    });
    await expectNoA11yViolations(running.container);
  });
});

describe("the aligner Check in the Review queue", () => {
  let episode = 0;

  function setProject(transcribed: boolean) {
    useDawStore.setState({
      projectPath: `/tmp/p/check-${(episode += 1)}.sharecut`,
      project: minimalProject({
        transcript: transcribed ? { utterances: [{ id: "u" } as never] } : null,
      }),
    });
  }

  function queue(state: ModelState, props: Partial<ReviewQueueProps> = {}) {
    return render(
      <ReviewQueue
        items={QUEUE_WITHOUT_CHECKS}
        content={reviewContent}
        selectedId={null}
        filter="all"
        onFilter={vi.fn()}
        onSelect={vi.fn()}
        onVerb={vi.fn()}
        {...props}
      />,
      { wrapper: host(withAligner(state)) },
    );
  }

  beforeEach(() => setProject(true));

  it("shows once on All and on Checks when the transcript was timed without the aligner", () => {
    const all = queue({ kind: "missing" });
    expect(screen.getAllByText(TITLE)).toHaveLength(1);
    all.unmount();
    queue({ kind: "missing" }, { filter: "checks" });
    expect(screen.getAllByText(TITLE)).toHaveLength(1);
  });

  it("stays out of the other filters", () => {
    queue({ kind: "missing" }, { filter: "suggestions" });
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("stays out of a guest's queue and of a view that cannot decide", () => {
    const guest = queue({ kind: "missing" }, { guest: true, canDecide: true });
    expect(screen.queryByText(TITLE)).toBeNull();
    guest.unmount();
    queue({ kind: "missing" }, { canDecide: false });
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("stays out once the aligner is installed", () => {
    queue({ kind: "installed" });
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("stays out when no transcript was timed", () => {
    setProject(false);
    queue({ kind: "missing" });
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("leaves Prepare the Re-time offer when the aligner lands from the Check", () => {
    const queueProps = {
      items: QUEUE_WITHOUT_CHECKS,
      content: reviewContent,
      selectedId: null,
      filter: "all",
      onFilter: vi.fn(),
      onSelect: vi.fn(),
      onVerb: vi.fn(),
    } satisfies ReviewQueueProps;
    const view = renderWithLanding(<ReviewQueue {...queueProps} />, {
      status: modelStatus(registryRows()),
    });
    expect(screen.getByText(TITLE)).toBeVisible();
    view.land("word-aligner");
    expect(screen.queryByText(TITLE)).toBeNull();
    view.unmount();
    const { result } = renderHook(() => useWordTiming(), {
      wrapper: host(withAligner({ kind: "installed" })),
    });
    expect(result.current.retime).toBe(true);
  });

  it("does not say Nothing here beside the Check", () => {
    queue({ kind: "missing" }, { items: [], filter: "checks" });
    expect(screen.getByText(TITLE)).toBeVisible();
    expect(screen.queryByText("Nothing here")).toBeNull();
  });
});
