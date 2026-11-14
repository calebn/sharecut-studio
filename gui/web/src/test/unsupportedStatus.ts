import fixture from "../../../../tests/fixtures/bootstrap_status/unsupported.json";
import type { BootstrapStatus } from "../api";

/** `GET /api/bootstrap/status` on a host that cannot process audio, captured from the engine; a Python test fails when the engine's answer drifts from it. */
export const UNSUPPORTED_STATUS = fixture as BootstrapStatus;

/** The one sentence the engine gives for the audio tools and for every model on that host. */
export const UNSUPPORTED_SENTENCE = fixture.tools.ffmpeg.hint;
