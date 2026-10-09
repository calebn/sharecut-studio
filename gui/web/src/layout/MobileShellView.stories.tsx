import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import type { MobileMode, MoreDestination } from "../state/types";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { TrackMixView } from "../tracks/TrackMixView";
import { Timecode } from "../ui/Timecode";
import { FollowBannerView } from "./FollowBannerView";
import { ListenHero } from "./ListenHero";
import { type MobileScreen, MobileShellView } from "./MobileShellView";
import { shellProject, shellTime } from "./shellStoryData";
import {
  ShellStoryFrame,
  ShellStoryInspector,
  ShellStoryTimeline,
  ShellStoryTools,
  ShellStoryTranscript,
  ShellStoryTransport,
} from "./shellStoryFixtures";
import { TransportPlayControls } from "./TransportPlayControls";

type PreviewProps = {
  initialMode: MobileMode;
  initialDestination: MoreDestination;
  guest: boolean;
  following: boolean;
  initialInspector: boolean;
  loading: boolean;
  onModeChange: (mode: MobileMode) => void;
  onBack: (destination: MoreDestination) => void;
  onPlayingChange: (playing: boolean) => void;
  onInspect: (trackId: string) => void;
  onCloseInspector: () => void;
  onExpandedChange: (expanded: boolean) => void;
  onStopFollowing: () => void;
  onSeek: (sec: number) => void;
};
function PhonePreview(args: PreviewProps) {
  const [mode, setMode] = useState(args.initialMode);
  const [destination, setDestination] = useState(args.initialDestination);
  const [playing, setPlaying] = useState(false);
  const [inspector, setInspector] = useState(args.initialInspector);
  const [mix, setMix] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [following, setFollowing] = useState(args.following);
  const onPlayingChange = (next: boolean) => {
    args.onPlayingChange(next);
    setPlaying(next);
  };
  const onInspect = (trackId: string) => {
    args.onInspect(trackId);
    setInspector(true);
  };
  const screen: MobileScreen =
    mode === "listen"
      ? {
          kind: "listen",
          content: (
            <div className="mobile-listen">
              <ListenHero
                title={
                  args.loading ? "Loading episode…" : shellProject.meta.name
                }
                playing={playing}
                controls={
                  <TransportPlayControls
                    playing={playing}
                    disabled={args.loading}
                    onTogglePlay={() => onPlayingChange(!playing)}
                    onStop={() => onPlayingChange(false)}
                  />
                }
                timecode={<Timecode current={shellTime.current} />}
                scrubber={null}
              />
            </div>
          ),
        }
      : mode === "timeline"
        ? {
            kind: "timeline",
            canvas: (
              <ShellStoryTimeline selected={inspector} onInspect={onInspect} />
            ),
            tools: (
              <div
                className="editing-tool-rail"
                role="group"
                aria-label="Editing tools"
              >
                <ShellStoryTools />
              </div>
            ),
          }
        : mode === "text"
          ? {
              kind: "text",
              content: <ShellStoryTranscript onSeek={args.onSeek} />,
            }
          : {
              kind: "more",
              destination,
              content:
                destination === "comments" ? (
                  <article>
                    <p>{shellProject.comments?.[0].body}</p>
                  </article>
                ) : (
                  <>
                    <p>Comments, history, and project tools live in More.</p>
                    <button
                      type="button"
                      className="mobile-more-item"
                      onClick={() => {
                        setInspector(false);
                        setMix(true);
                      }}
                    >
                      Mix
                    </button>
                  </>
                ),
              onBack: () => {
                args.onBack("hub");
                setDestination("hub");
              },
            };
  return (
    <ShellStoryFrame shell="phone">
      <MobileShellView
        appearance={{ guestShare: args.guest, following }}
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
          announcement: "",
          transport: (
            <ShellStoryTransport
              compact
              loading={args.loading}
              playing={playing}
              onPlayingChange={onPlayingChange}
            />
          ),
          status: null,
          overlay: null,
        }}
        screen={screen}
        onModeChange={(next) => {
          args.onModeChange(next);
          setMix(false);
          setMode(next);
        }}
        sheet={
          mix
            ? {
                kind: "mix",
                onClose: () => setMix(false),
                content: (
                  <TrackMixView
                    state="ready"
                    rows={[
                      {
                        id: "mira",
                        label: "Mira",
                        initials: "M",
                        identityColor: "var(--color-clip-dialogue-0)",
                        muteState: "off",
                        solo: false,
                        faderDb: 0,
                      },
                    ]}
                    access={{ kind: "listen" }}
                    preview="host"
                    onMute={() => {}}
                    onSolo={() => {}}
                  />
                ),
              }
            : inspector
              ? {
                  kind: "inspector",
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
                }
              : { kind: "closed" }
        }
      />
    </ShellStoryFrame>
  );
}
const meta: Meta<PreviewProps> = {
  title: "Templates/MobileShell",
  tags: ["autodocs"],
  component: PhonePreview,
  parameters: { ...isolatedStoryParameters, layout: "fullscreen" },
  render: (args) => <PhonePreview {...args} />,
  args: {
    initialMode: "listen",
    initialDestination: "hub",
    guest: false,
    following: false,
    initialInspector: false,
    loading: false,
    onModeChange: fn(),
    onBack: fn(),
    onPlayingChange: fn(),
    onInspect: fn(),
    onCloseInspector: fn(),
    onExpandedChange: fn(),
    onStopFollowing: fn(),
    onSeek: fn(),
  },
};
export default meta;
type Story = StoryObj<PreviewProps>;

export const Phone360: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Play" }));
    await expect(
      canvas.getByRole("button", { name: "Pause" }),
    ).toBeInTheDocument();
    await expect(args.onPlayingChange).toHaveBeenCalledWith(true);
    await userEvent.click(canvas.getByRole("button", { name: "Pause" }));
    await expect(args.onPlayingChange).toHaveBeenCalledWith(false);
    await userEvent.click(canvas.getByRole("button", { name: "Timeline" }));
    await expect(args.onModeChange).toHaveBeenCalledWith("timeline");
    await expect(
      canvas.getByRole("button", { name: "Timeline" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvasElement.querySelector(".daw-shell-transport > header.transport"),
    ).toBeInTheDocument();
    await expect(canvas.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  },
};
export const Timeline: Story = {
  args: { initialMode: "timeline" },
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
    await expect(
      within(document.body).queryByRole("dialog", { name: "Inspector" }),
    ).toBeNull();
  },
};
export const Text: Story = {
  args: { initialMode: "text" },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Welcome." }));
    await expect(canvas.getByRole("button", { name: "Welcome." })).toHaveClass(
      "selected",
    );
    await expect(args.onSeek).toHaveBeenCalledWith(12.5);
  },
};
export const MoreComments: Story = {
  args: { initialMode: "more", initialDestination: "comments" },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Keep this introduction."),
    ).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "← More" }));
    await expect(args.onBack).toHaveBeenCalledWith("hub");
    await expect(
      canvas.getByText("Comments, history, and project tools live in More."),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "← More" })).toBeNull();
  },
};
export const GuestFollowing: Story = {
  args: { guest: true, following: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Guest · View only")).toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole("button", { name: "Stop following" }),
    );
    await expect(args.onStopFollowing).toHaveBeenCalledWith();
    await expect(canvasElement.querySelector(".daw-shell")).not.toHaveClass(
      "daw-shell--following",
    );
  },
};
export const OpenInspector: Story = {
  args: { initialMode: "timeline", initialInspector: true },
  play: async ({ args }) => {
    const body = within(document.body);
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
export const Loading: Story = {
  args: { loading: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Loading episode…" }),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Play" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Stop" })).toBeDisabled();
  },
};

export const MoreMix: Story = {
  args: { initialMode: "more" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Mix" });
    await userEvent.click(trigger);
    const body = within(document.body);
    await expect(body.getAllByRole("dialog")).toHaveLength(1);
    await expect(body.getByRole("dialog", { name: "Mix" })).toHaveClass(
      "bottom-sheet--full",
    );
    await userEvent.click(body.getByRole("button", { name: "Close" }));
    await expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    await expect(body.queryByRole("dialog")).toBeNull();
    await expect(trigger).toHaveFocus();
  },
};
