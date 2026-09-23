import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { Lobby } from "./Lobby";
import { MIC_ALLOW_LABEL } from "./micPermission";
import {
  ROOM_TONE_GATE_COPY,
  ROOM_TONE_PROMPT_COPY,
  SPEAKERS_WARNING,
} from "./types";

const mic = {
  stream: null,
  devices: [] as MediaDeviceInfo[],
  micError: null,
  settingsWarning: null,
  permission: "idle" as const,
  onAllowMic: () => undefined,
  onRetryMic: () => undefined,
};

describe("Lobby", () => {
  it("omits mic UI on the producer path", async () => {
    const { container } = render(
      <Lobby
        producer
        name="Pat"
        onName={() => undefined}
        headphonesOk={false}
        onHeadphones={() => undefined}
        deviceId=""
        onDeviceId={() => undefined}
        onJoinProducer={() => undefined}
        onAccept={() => undefined}
        onDecline={() => undefined}
        showMic={false}
        {...mic}
      />,
    );
    expect(screen.getByRole("button", { name: "Join" })).toBeInTheDocument();
    expect(screen.queryByText("Microphone")).toBeNull();
    expect(screen.queryByRole("button", { name: MIC_ALLOW_LABEL })).toBeNull();
    expect(screen.queryByText(/I am wearing headphones/)).toBeNull();
    expect(screen.queryByText(ROOM_TONE_PROMPT_COPY)).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("shows Allow microphone, consent, and speaker warning for guests", async () => {
    const { container } = render(
      <Lobby
        producer={false}
        name="Ava"
        onName={() => undefined}
        headphonesOk={false}
        onHeadphones={() => undefined}
        deviceId=""
        onDeviceId={() => undefined}
        onJoinProducer={() => undefined}
        onAccept={() => undefined}
        onDecline={() => undefined}
        showMic
        {...mic}
      />,
    );
    expect(screen.getByText("Microphone")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: MIC_ALLOW_LABEL }),
    ).toBeInTheDocument();
    expect(screen.getByText(SPEAKERS_WARNING)).toBeInTheDocument();
    expect(screen.getByText(ROOM_TONE_PROMPT_COPY)).toBeInTheDocument();
    const accept = screen.getByRole("button", { name: "Accept" });
    expect(accept).toBeDisabled();
    expect(accept).toHaveAttribute("aria-describedby");
    await expectNoA11yViolations(container);
  });

  it("describes Accept with headphones copy after mic grant", async () => {
    render(
      <Lobby
        producer={false}
        name="Ava"
        onName={() => undefined}
        headphonesOk={false}
        onHeadphones={() => undefined}
        deviceId=""
        onDeviceId={() => undefined}
        onJoinProducer={() => undefined}
        onAccept={() => undefined}
        onDecline={() => undefined}
        showMic
        {...mic}
        permission="granted"
      />,
    );
    const accept = screen.getByRole("button", { name: "Accept" });
    expect(accept).toBeDisabled();
    const describedBy = accept.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const warning = screen.getByText(SPEAKERS_WARNING);
    expect(describedBy?.split(" ")).toContain(warning.id);
  });

  it("keeps Accept disabled after the granted mic is lost", () => {
    render(
      <Lobby
        producer={false}
        name="Ava"
        onName={() => undefined}
        headphonesOk
        onHeadphones={() => undefined}
        deviceId=""
        onDeviceId={() => undefined}
        onJoinProducer={() => undefined}
        onAccept={() => undefined}
        onDecline={() => undefined}
        showMic
        {...mic}
        permission="lost"
      />,
    );
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
  });

  it("holds Accept until room tone is recorded or skipped", async () => {
    const { container, rerender } = render(
      <Lobby
        producer={false}
        name="Ava"
        onName={() => undefined}
        headphonesOk
        onHeadphones={() => undefined}
        deviceId=""
        onDeviceId={() => undefined}
        onJoinProducer={() => undefined}
        onAccept={() => undefined}
        onDecline={() => undefined}
        showMic
        {...mic}
        permission="granted"
        stream={{} as MediaStream}
        roomToneReady={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    expect(screen.getByText(ROOM_TONE_GATE_COPY)).toBeInTheDocument();
    await expectNoA11yViolations(container);
    rerender(
      <Lobby
        producer={false}
        name="Ava"
        onName={() => undefined}
        headphonesOk
        onHeadphones={() => undefined}
        deviceId=""
        onDeviceId={() => undefined}
        onJoinProducer={() => undefined}
        onAccept={() => undefined}
        onDecline={() => undefined}
        showMic
        {...mic}
        permission="granted"
        stream={{} as MediaStream}
        roomToneReady
        roomToneStatus="skipped"
      />,
    );
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
  });

  it("hides room tone when upload is off", () => {
    render(
      <Lobby
        producer={false}
        name="Ava"
        onName={() => undefined}
        headphonesOk
        onHeadphones={() => undefined}
        deviceId=""
        onDeviceId={() => undefined}
        onJoinProducer={() => undefined}
        onAccept={() => undefined}
        onDecline={() => undefined}
        showMic
        {...mic}
        permission="granted"
        stream={{} as MediaStream}
        showRoomTone={false}
      />,
    );
    expect(screen.queryByText(ROOM_TONE_PROMPT_COPY)).toBeNull();
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
  });

  it("describes Accept with the room-tone gate copy", () => {
    render(
      <Lobby
        producer={false}
        name="Ava"
        onName={() => undefined}
        headphonesOk
        onHeadphones={() => undefined}
        deviceId=""
        onDeviceId={() => undefined}
        onJoinProducer={() => undefined}
        onAccept={() => undefined}
        onDecline={() => undefined}
        showMic
        {...mic}
        permission="granted"
        stream={{} as MediaStream}
        roomToneReady={false}
      />,
    );
    const accept = screen.getByRole("button", { name: "Accept" });
    const described = accept.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described ?? "")).toHaveTextContent(
      ROOM_TONE_GATE_COPY,
    );
  });
});
