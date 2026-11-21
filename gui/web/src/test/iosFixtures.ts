import type { BootstrapHost, WhisperModelChoice } from "../api";

/** What an iPhone reports: whisper.cpp transcription, in-process media tools, no folder picker. */
export const IOS_HOST: BootstrapHost = {
  name: "ios",
  can_spawn_processes: false,
  loopback_is_trusted: false,
  media_tools: "in_process",
  transcription: "whisper_cpp",
  folder_picker: false,
};

/** The two whisper.cpp variants the engine lists on an iPhone. */
export const IOS_WHISPER_CATALOG: WhisperModelChoice[] = [
  {
    id: "small.en-q5_1",
    label: "Recommended",
    size: "190 MB",
    description: "Better accuracy; uses more storage and memory. English only.",
  },
  {
    id: "base.en-q5_1",
    label: "Less accurate",
    size: "60 MB",
    description:
      "Smaller download; expect more errors on fast or overlapping speech. English only.",
  },
];
