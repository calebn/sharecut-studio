import { useDawStore } from "../state/dawStore";
import { registerCommand } from "./execute";

export function registerFeedbackCommands(): void {
  registerCommand("feedback.dismiss", () => {
    const toast = useDawStore.getState().feedbackToast;
    if (toast === null)
      return { status: "disabled", reason: "No message to dismiss" };
    useDawStore.getState().dismissFeedbackToast(toast.id);
    return { status: "ok" };
  });
}
