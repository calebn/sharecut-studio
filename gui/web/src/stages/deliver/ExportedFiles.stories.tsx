import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { StatusRow } from "../../system/StatusRow";
import { Button } from "../../ui";
import { DeliverSection } from "./DeliverSection";
import { ExportedFiles } from "./ExportedFiles";
import type { ExportedFile } from "./exportedFileModel";

const MB = 1024 * 1024;

const FILES: ExportedFile[] = [
  {
    id: "episode-12.mp3",
    name: "episode-12.mp3",
    kind: "audio",
    label: "Listening file",
    bytes: 58 * MB,
    current: true,
    href: "#episode-12.mp3",
  },
  {
    id: "episode-12.wav",
    name: "episode-12.wav",
    kind: "audio",
    label: "Lossless master",
    bytes: 612 * MB,
    current: true,
    href: "#episode-12.wav",
  },
  {
    id: "episode-12.md",
    name: "episode-12.md",
    kind: "transcript",
    label: "Markdown",
    bytes: 41_000,
    current: true,
    href: "#episode-12.md",
  },
  {
    id: "episode-12.srt",
    name: "episode-12.srt",
    kind: "transcript",
    label: "Captions",
    bytes: 63_000,
    current: true,
    href: "#episode-12.srt",
  },
  {
    id: "episode-12.chapters.json",
    name: "episode-12.chapters.json",
    kind: "chapters",
    label: "Chapters",
    bytes: 2_100,
    current: true,
    href: "#episode-12.chapters.json",
  },
  {
    id: "feed.xml",
    name: "feed.xml",
    kind: "feed",
    label: "Feed file",
    bytes: 9_200,
    current: true,
    href: "#feed.xml",
  },
];

const AUDIO = FILES.slice(0, 2);

const meta: Meta<typeof ExportedFiles> = {
  title: "Stages/Deliver/ExportedFiles",
  component: ExportedFiles,
  tags: ["autodocs"],
  args: { files: AUDIO, access: "download", onReveal: fn(), onStarted: fn() },
  decorators: [
    (Story) => (
      <div
        className="dv-stage"
        style={{ padding: "var(--space-5)", maxInlineSize: "40rem" }}
      >
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "Every exported file is a row with one quiet action: Download in a browser, Reveal in the desktop app. The same list sits in Episode file, Transcript and Podcast listing, and groups by kind in the Editor link's Files section. Export stays the only filled button on the page.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ExportedFiles>;

export const HostBrowser: Story = {
  render: (args) => (
    <DeliverSection title="Episode file">
      <StatusRow state="done" title="Exported" detail="Last export 2:14 PM" />
      <Button variant="primary" className="dv-export">
        Export again
      </Button>
      <ExportedFiles {...args} />
    </DeliverSection>
  ),
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const link = view.getByRole("link", {
      name: "Download episode-12.mp3, 61 MB",
    });
    link.addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(link);
    await expect(args.onStarted).toHaveBeenCalledOnce();
  },
};

export const DesktopApp: Story = {
  args: { access: "reveal", files: AUDIO.map(({ href: _, ...f }) => f) },
  render: HostBrowser.render,
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(
      view.getByRole("button", { name: "Reveal episode-12.wav, 642 MB" }),
    );
    await expect(args.onReveal).toHaveBeenCalledOnce();
  },
};

export const Transcript: Story = {
  args: {
    files: FILES.slice(2, 4).map((f, i) => ({ ...f, current: i === 0 })),
  },
  render: (args) => (
    <DeliverSection title="Transcript">
      <ExportedFiles {...args} />
    </DeliverSection>
  ),
};

export const ExportRunning: Story = {
  args: { running: true },
  render: HostBrowser.render,
};

export const EditorFiles: Story = {
  args: { files: FILES, grouped: true },
  render: (args) => (
    <DeliverSection title="Files">
      <p className="dv-note">Exported by the host · 2:14 PM</p>
      <ExportedFiles {...args} />
    </DeliverSection>
  ),
};
