(() => {
  const key = "__sharecut2149ChronologyAdapter";
  if (window[key]) throw new Error("2149 chronology adapter already installed");
  const gate = window.__sharecut2149Gate;
  if (!gate || typeof gate.beginChronology !== "function") throw new Error("2149 missing chronology gate");
  const remove = gate.remove;
  let removed;
  gate.remove = () => {
    if (removed) return removed;
    const snapshot = remove();
    delete window[key];
    snapshot.chronology_cleanup = { adapter_removed: !window[key], live_listeners: snapshot.chronology.live_listeners };
    if (!snapshot.chronology_cleanup.adapter_removed || snapshot.chronology_cleanup.live_listeners !== 0)
      throw new Error("2149 incomplete observer/adapter cleanup");
    removed = snapshot;
    return snapshot;
  };
  window[key] = Object.freeze({
    applyMark(gate, command) {
      const context = command.chronology_context;
      const boundary = command.chronology_boundary;
      if (context || boundary) {
        if (command.op !== "mark" || !context || !["begin", "end"].includes(boundary))
          throw new Error("2149 malformed chronology command");
        const label = boundary === "begin" ? context.label : "after-observation-" + context.operation_id;
        if (command.label !== label || label.length > 60) throw new Error("2149 chronology label mismatch");
        if (boundary === "begin") gate.beginChronology(context);
        else gate.endChronology(context);
      } else if (/^(before-native-|after-observation-)/.test(command.label)) {
        throw new Error("2149 boundary mark requires full context");
      }
      gate.mark(command.label);
    },
    payload(snapshot) {
      if (!snapshot.chronology) throw new Error("2149 missing chronology snapshot");
      return { chronology: snapshot.chronology, chronology_cleanup: snapshot.chronology_cleanup };
    },
  });
})();
