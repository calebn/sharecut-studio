import { Component, type ReactNode } from "react";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { NETWORK_COVER_COPY, ROOM_ERROR_COVER_COPY } from "./bootCopy";
import { GuestCovers } from "./GuestCovers";
import { isChunkLoadError } from "./isChunkLoadError";

function RoomLoadCover({ chunk }: { chunk: boolean }) {
  const copy = chunk ? NETWORK_COVER_COPY : ROOM_ERROR_COVER_COPY;
  useDocumentTitle(`${copy.title} | ShareCut Studio`);
  return (
    <GuestCovers
      cover={{
        size: "page",
        ...copy,
        primary: { label: "Reload", onClick: () => window.location.reload() },
      }}
    />
  );
}

type State = { failure: { chunk: boolean } | null };

export class RoomLoadBoundary extends Component<
  { children: ReactNode },
  State
> {
  state: State = { failure: null };

  static getDerivedStateFromError(error: unknown): State {
    return { failure: { chunk: isChunkLoadError(error) } };
  }

  render() {
    const { failure } = this.state;
    if (failure) {
      return <RoomLoadCover chunk={failure.chunk} />;
    }
    return this.props.children;
  }
}
