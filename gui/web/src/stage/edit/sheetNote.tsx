export const note = (text: string, role?: "status") => (
  <p className="sys-inspector-note" role={role}>
    {text}
  </p>
);
