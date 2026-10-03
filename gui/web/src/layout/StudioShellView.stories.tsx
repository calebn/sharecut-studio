import type { Meta, StoryObj } from "@storybook/react-vite";
import { type DragEvent, useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import type { LayoutMode } from "../state/types";
import type { PresenceTab } from "../types/session";
import { BottomTabsSplitterView } from "./BottomTabsSplitterView";
import { FollowBannerView } from "./FollowBannerView";
import { StatusBarView } from "./StatusBarView";
import { StudioShellView, type StudioWorkspace } from "./StudioShellView";
import {
  ShellStoryFrame,
  ShellStoryHeaders,
  ShellStoryInspector,
  ShellStoryTimeline,
  ShellStoryTools,
  ShellStoryTranscript,
  ShellStoryTransport,
} from "./shellStoryFixtures";

type PreviewProps = {
  tablet: boolean;
  scene: "arrange" | "loading" | "ingest";
  initialTab: PresenceTab;
  initialLayout: LayoutMode;
  guest: boolean;
  following: boolean;
  initialInspector: boolean;
  onTabChange: (tab: PresenceTab) => void;
  onPlayingChange: (playing: boolean) => void;
  onInspect: (trackId: string) => void;
  onSeek: (sec: number) => void;
  onImport: () => void;
  onDismissCoach: () => void;
  onDrop: (files: string[]) => void;
  onCloseInspector: () => void;
  onExpandedChange: (expanded: boolean) => void;
  onStopFollowing: () => void;
  onResize: (rem: number) => void;
};
function StudioPreview(args: PreviewProps) {
  const [tab, setTab] = useState(args.initialTab);
  const [playing, setPlaying] = useState(false);
  const [inspector, setInspector] = useState(args.initialInspector);
  const [expanded, setExpanded] = useState(false);
  const [following, setFollowing] = useState(args.following);
  const [coachOpen, setCoachOpen] = useState(true);
  const [over, setOver] = useState(false);
  const [height, setHeight] = useState(12.5);
  const onInspect = (trackId: string) => {
    args.onInspect(trackId);
    setInspector(true);
  };
  const onTabChange = (next: PresenceTab) => {
    args.onTabChange(next);
    setTab(next);
  };
  const workspace: StudioWorkspace =
    args.scene === "loading"
      ? {
          kind: "loading",
          headers: <ShellStoryHeaders onInspect={onInspect} />,
          canvas: (
            <div className="timeline-area" aria-label="Loading timeline">
              <p>Loading timeline…</p>
            </div>
          ),
        }
      : args.scene === "ingest"
        ? {
            kind: "ingest",
            headers: <ShellStoryHeaders onInspect={onInspect} />,
            ingest: {
              over,
              dropLabel: over
                ? "Add audio tracks"
                : "Drop audio files here, or Import Audio (Ctrl+I)",
              importShortcut: "Ctrl+I",
              coachOpen,
              onDragOver: (event: DragEvent<HTMLButtonElement>) => {
                event.preventDefault();
                setOver(true);
              },
              onDragLeave: () => setOver(false),
              onDrop: (event: DragEvent<HTMLButtonElement>) => {
                event.preventDefault();
                setOver(false);
                args.onDrop(
                  Array.from(event.dataTransfer.files, (file) => file.name),
                );
              },
              onImport: args.onImport,
              onDismissCoach: () => {
                args.onDismissCoach();
                setCoachOpen(false);
              },
            },
          }
        : {
            kind: "arrange",
            canvas: (
              <ShellStoryTimeline selected={inspector} onInspect={onInspect} />
            ),
          };
  return (
    <ShellStoryFrame
      shell={args.tablet ? "tablet" : "desktop"}
      layout={args.initialLayout}
      tabsHeight={height}
    >
      <StudioShellView
        appearance={{ guestShare: args.guest, following }}
        layout={args.initialLayout}
        chrome={{
          notices: {
            banners: args.guest ? (
              <div className="guest-banner" role="status">
                Guest · View only
              </div>
            ) : null,
            follow: following ? (
              <FollowBannerView
                name="Avery"
                guest={args.guest}
                degraded={{}}
                onStopFollowing={() => {
                  args.onStopFollowing();
                  setFollowing(false);
                }}
              />
            ) : null,
          },
          transport: (
            <ShellStoryTransport
              compact={args.tablet}
              loading={args.scene === "loading"}
              playing={playing}
              onPlayingChange={(next) => {
                args.onPlayingChange(next);
                setPlaying(next);
              }}
            />
          ),
          footer: (
            <StatusBarView
              guestShare={args.guest}
              narrow={args.tablet}
              summary={
                args.scene === "loading"
                  ? null
                  : {
                      pendingReviewCount: 0,
                      unmappedCount: 0,
                      cut: null,
                      socialClipCount: 0,
                      renderStale: false,
                      renderSummary: "Mix up to date",
                      transcriptNeedsSync: false,
                    }
              }
              statusAnnouncement=""
              onOpenTab={onTabChange}
            />
          ),
          overlay: null,
        }}
        workspace={workspace}
        panels={{
          activeTab: tab,
          pipelineRunning: false,
          splitter: (
            <BottomTabsSplitterView
              heightRem={height}
              minRem={8}
              maxRem={24}
              userSet
              onResize={(next) => {
                args.onResize(next);
                setHeight(Math.min(24, Math.max(8, next)));
              }}
              onReset={() => setHeight(12.5)}
            />
          ),
          content:
            tab === "transcript" ? (
              <ShellStoryTranscript onSeek={args.onSeek} />
            ) : (
              <p>
                {tab === "comments"
                  ? "Keep this introduction."
                  : "No items in this fixture."}
              </p>
            ),
          onTabChange,
        }}
        inspector={
          args.tablet
            ? {
                kind: "tablet",
                tools: (
                  <div
                    className="editing-tool-rail"
                    role="group"
                    aria-label="Editing tools"
                  >
                    <ShellStoryTools />
                  </div>
                ),
                sheet: {
                  open: inspector,
                  expanded,
                  content: <ShellStoryInspector />,
                  onClose: () => {
                    args.onCloseInspector();
                    setInspector(false);
                    setExpanded(false);
                  },
                  onExpandedChange: (next) => {
                    args.onExpandedChange(next);
                    setExpanded(next);
                  },
                },
              }
            : {
                kind: "desktop",
                content: inspector ? <ShellStoryInspector /> : null,
              }
        }
      />
    </ShellStoryFrame>
  );
}
const meta: Meta<PreviewProps> = {
  title: "Templates/StudioShell",
  component: StudioPreview,
  parameters: { layout: "fullscreen" },
  render: (args) => <StudioPreview {...args} />,
  args: {
    tablet: false,
    scene: "arrange",
    initialTab: "transcript",
    initialLayout: "default",
    guest: false,
    following: false,
    initialInspector: false,
    onTabChange: fn(),
    onPlayingChange: fn(),
    onInspect: fn(),
    onSeek: fn(),
    onImport: fn(),
    onDismissCoach: fn(),
    onDrop: fn(),
    onCloseInspector: fn(),
    onExpandedChange: fn(),
    onStopFollowing: fn(),
    onResize: fn(),
  },
};
export default meta;
type Story = StoryObj<PreviewProps>;

export const Desktop: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Play" }));
    await expect(
      canvas.getByRole("button", { name: "Pause" }),
    ).toBeInTheDocument();
    await expect(args.onPlayingChange).toHaveBeenCalledWith(true);
    await userEvent.click(canvas.getByRole("button", { name: "Comments" }));
    await expect(args.onTabChange).toHaveBeenCalledWith("comments");
    await expect(
      canvas.getByRole("button", { name: "Comments" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.getByText("Keep this introduction."),
    ).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Transcript" }));
    await expect(args.onTabChange).toHaveBeenCalledWith("transcript");
    await expect(
      canvas.getByRole("button", { name: "Welcome." }),
    ).toBeInTheDocument();
  },
};
export const DesktopInspector: Story = {
  args: { initialInspector: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("main")).toHaveTextContent("Dialogue track");
    await userEvent.click(
      canvas.getByRole("button", { name: "Open track details, Mira" }),
    );
    await expect(args.onInspect).toHaveBeenCalledWith("mira");
    await expect(canvasElement.querySelector(".daw-main")).not.toHaveClass(
      "daw-main--inspector-collapsed",
    );
  },
};
export const GuestFollowing: Story = {
  args: { guest: true, following: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const panels = within(
      canvasElement.querySelector<HTMLElement>(".tab-bar")!,
    );
    await expect(
      panels.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Transcript", "Comments"]);
    await userEvent.click(
      canvas.getByRole("button", { name: "Stop following" }),
    );
    await expect(args.onStopFollowing).toHaveBeenCalledWith();
    await expect(canvasElement.querySelector(".daw-shell")).not.toHaveClass(
      "daw-shell--following",
    );
  },
};
export const Loading: Story = {
  args: { scene: "loading" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Loading episode…" }),
    ).toBeInTheDocument();
    await expect(canvas.getByLabelText("Loading timeline")).toHaveTextContent(
      "Loading timeline…",
    );
    await expect(
      canvas.queryByRole("button", { name: "Drop audio files or import" }),
    ).toBeNull();
    await expect(canvas.getByRole("button", { name: "Play" })).toBeDisabled();
  },
};
export const EmptyIngest: Story = {
  args: { scene: "ingest" },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Drop audio files or import" }),
    );
    await expect(args.onImport).toHaveBeenCalledWith();
    await userEvent.click(canvas.getByRole("button", { name: "Got it" }));
    await expect(args.onDismissCoach).toHaveBeenCalledWith();
    await expect(canvas.queryByText(/Drop stems here/)).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "Drop audio files or import" }),
    ).toBeInTheDocument();
  },
};
export const TabletInspector: Story = {
  args: { tablet: true, initialInspector: true },
  play: async ({ args }) => {
    const body = within(document.body);
    await expect(
      body.getByRole("dialog", { name: "Inspector" }),
    ).toHaveAttribute("aria-modal", "false");
    await userEvent.click(body.getByRole("button", { name: "Expand" }));
    await expect(args.onExpandedChange).toHaveBeenCalledWith(true);
    await expect(body.getByRole("dialog", { name: "Inspector" })).toHaveClass(
      "bottom-sheet--full",
    );
    await userEvent.click(body.getByRole("button", { name: "Close" }));
    await expect(args.onCloseInspector).toHaveBeenCalledWith();
    await expect(body.queryByRole("dialog")).toBeNull();
  },
};
export const Tablet: Story = {
  args: { tablet: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Open track details, Mira" }),
    );
    await expect(args.onInspect).toHaveBeenCalledWith("mira");
    await expect(
      within(document.body).getByRole("dialog", { name: "Inspector" }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(document.body).getByRole("button", { name: "Close" }),
    );
    await expect(args.onCloseInspector).toHaveBeenCalledWith();
  },
};
