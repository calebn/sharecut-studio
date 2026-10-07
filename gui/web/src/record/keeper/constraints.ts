export const KEEPER_AUDIO_FLAGS = {
  echoCancellation: false,
  autoGainControl: false,
  noiseSuppression: false,
  channelCount: 1,
} as const;

export function keeperAudioConstraints(deviceId = ""): MediaStreamConstraints {
  const audio: MediaTrackConstraints = { ...KEEPER_AUDIO_FLAGS };
  if (deviceId) {
    audio.deviceId = { exact: deviceId };
  }
  return { audio };
}

export function keeperSettingsMatch(
  settings: MediaTrackSettings | undefined,
): boolean {
  if (!settings) {
    return true;
  }
  return (
    settings.echoCancellation !== true &&
    settings.autoGainControl !== true &&
    settings.noiseSuppression !== true
  );
}

export const KEEPER_SETTINGS_WARNING =
  "This browser still applied capture processing to your full-quality recording, so it may not be raw.";
