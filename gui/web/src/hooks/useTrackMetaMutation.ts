import { sendTrackMeta, type TrackMetaFields } from "./trackMeta";
import { useProjectMutation } from "./useProjectMutation";

export function useTrackMetaMutation(trackId: string) {
  const mutation = useProjectMutation();
  const saveMetaFields = (fields: TrackMetaFields) =>
    mutation.run(async () => {
      await sendTrackMeta(trackId, fields);
      return true;
    });
  return { ...mutation, saveMetaFields };
}
