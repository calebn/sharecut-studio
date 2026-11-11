export const note = (text: string, role?: "status" | "alert", id?: string) => (
  <p id={id} className="sys-inspector-note" role={role}>
    {text}
  </p>
);
