import { describe, expect, it } from "vitest";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { roomPeople } from "./roomPeople";
import type { RecordParticipant } from "./types";

const host = recordParticipant({
  participant_id: "p_host",
  role: "host",
  display_name: "Hana",
  headphones_ack: false,
});
const maya = recordParticipant({
  participant_id: "p_maya",
  display_name: "Maya",
  headphones_ack: false,
});
const bo = recordParticipant({ participant_id: "p_bo", display_name: "Bo" });

const flagged = (
  participants: RecordParticipant[],
  options: Parameters<typeof roomPeople>[1],
) =>
  roomPeople(recordSnapshot({ participants }), options)
    .filter((person) => person.notWearingHeadphones)
    .map((person) => person.person.name);

describe("roomPeople not wearing headphones", () => {
  it("marks a consented guest who said no, for the host", () => {
    expect(flagged([host, maya, bo], { seesHeadphones: true })).toEqual([
      "Maya",
    ]);
  });

  it("clears when the guest says they are wearing them", () => {
    const wearing = { ...maya, headphones_ack: true };
    expect(flagged([host, wearing], { seesHeadphones: true })).toEqual([]);
  });

  it("shows nobody else's answer to another guest", () => {
    expect(flagged([host, maya, bo], { youId: "p_bo" })).toEqual([]);
  });

  it("shows a guest their own marker", () => {
    expect(flagged([host, maya, bo], { youId: "p_maya" })).toEqual(["Maya"]);
  });

  it("puts no marker before the guest has consented", () => {
    const joining = { ...maya, consented: null };
    expect(flagged([host, joining], { seesHeadphones: true })).toEqual([]);
    expect(flagged([host, joining], { youId: "p_maya" })).toEqual([]);
  });

  it("puts no marker on a guest who left or declined", () => {
    const left = { ...maya, connected: false };
    const declined = { ...bo, headphones_ack: false, consented: false };
    expect(flagged([host, left, declined], { seesHeadphones: true })).toEqual(
      [],
    );
  });

  it("never marks the host or a producer", () => {
    const producer = recordParticipant({
      participant_id: "p_prod",
      role: "producer",
      display_name: "Rosa",
      headphones_ack: false,
    });
    expect(flagged([host, producer], { seesHeadphones: true })).toEqual([]);
    expect(flagged([host, producer], { youId: "p_host" })).toEqual([]);
  });
});
