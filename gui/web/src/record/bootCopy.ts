import type { SystemIconName } from "../system/icons";

type CoverCopy = {
  glyph: SystemIconName;
  title: string;
  children: string;
};

export const NETWORK_COVER_COPY: CoverCopy = {
  glyph: "cloud-off",
  title: "Couldn't reach the room",
  children:
    "Check your internet connection, then try again. If it keeps happening, let the person who invited you know.",
};

export const ROOM_ERROR_COVER_COPY: CoverCopy = {
  glyph: "triangle-alert",
  title: "Something went wrong with the room",
  children:
    "Reload the page to try again. If it keeps happening, let the person who invited you know.",
};
