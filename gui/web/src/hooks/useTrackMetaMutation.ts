import { errorMessage } from "../utils/apiError";
import { sendTrackMeta, type TrackMetaFields } from "./trackMeta";
import { useProjectMutation } from "./useProjectMutation";

export function useTrackMetaMutation(trackId: string) {
  const mutation = useProjectMutation();
  const saveMetaFields = (fields: TrackMetaFields) =>
    mutation.run(async () => {
      await sendTrackMeta(trackId, fields);
      return true;
    });
  /** Saves the speaker and answers with why it was refused, or nothing. */
  const saveSpeaker = async (speaker: string): Promise<string | undefined> => {
    let reason: string | undefined;
    await mutation.run(async () => {
      try {
        await sendTrackMeta(trackId, { speaker });
      } catch (error) {
        reason = errorMessage(error);
        throw error;
      }
    });
    return reason;
  };
  return { ...mutation, saveMetaFields, saveSpeaker };
}
