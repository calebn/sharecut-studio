export const note = (text: string, role?: "status" | "alert") => (
  <p className="sys-inspector-note" role={role}>
    {text}
  </p>
);
