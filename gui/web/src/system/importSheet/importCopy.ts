export const WAIT_TO_DROP =
  "Wait for the library to finish, then drop the file again.";
export const ADD_LABEL = "Add to library";
export const CANCEL_LABEL = "Cancel";
export const CLOSE_LABEL = "Close";
export const CHOOSE_AGAIN_LABEL = "Choose another file";
export const ADDING_LABEL = "Adding…";
export const IMPORT_FAILED = "Couldn't import that file. Try again.";
export const ZIP_TYPE = "application/zip";

export function checkingMessage(fileName: string): string {
  return `Checking ${fileName}…`;
}
