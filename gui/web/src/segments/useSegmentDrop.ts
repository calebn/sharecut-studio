import { useCallback } from "react";
import {
  type BundleDrop,
  useBundleDrop,
} from "../system/importSheet/useBundleDrop";
import {
  NOT_A_SEGMENT_FILE,
  ONE_FILE_ONLY,
  SEGMENT_EXTENSION,
  ZIP_TYPE,
} from "./importMessages";

type Options = {
  enabled: boolean;
  onFile: (file: File) => void;
  onRefuse: (message: string) => void;
};

export type SegmentDrop = BundleDrop;

function isSegmentFile(file: File): boolean {
  return (
    file.name.toLowerCase().endsWith(SEGMENT_EXTENSION) ||
    file.type === ZIP_TYPE
  );
}

/** Drop handlers for the segment library list: one `.sharecutseg` or zip file is imported. */
export function useSegmentDrop({
  enabled,
  onFile,
  onRefuse,
}: Options): SegmentDrop {
  const accepts = useCallback(isSegmentFile, []);
  return useBundleDrop({
    enabled,
    accepts,
    refusal: NOT_A_SEGMENT_FILE,
    oneFileOnly: ONE_FILE_ONLY,
    onFile,
    onRefuse,
  });
}
