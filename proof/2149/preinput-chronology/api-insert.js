  metadata.viewportChronology = { version: 1, transport_run: chronologyRun,
    gate_instance: chronologyInstance, time_origin: chronologyOrigin,
    installed_at: chronologyInstalled, sources: chronologySources.slice() };
  const chronologyApi = window[key];
  const chronologyOriginalExport = chronologyApi.export;
  chronologyApi.export = () => {
    const status = chronologyStatus();
    return { ...chronologyOriginalExport(), chronology: status };
  };
  const chronologyOriginalRemove = chronologyApi.remove;
  let chronologyRemoved;
  chronologyApi.remove = () => chronologyRemoved ||= chronologyOriginalRemove();
  chronologyApi.beginChronology = (context) => {
    const keys = ["transport_run", "native_run", "operation_id", "trial_id", "request_sha256", "gate_instance", "label"];
    const exact = context && Object.keys(context).sort().join() === keys.sort().join();
    if (!exact || context.transport_run !== chronologyRun || context.gate_instance !== chronologyInstance ||
        !/^[a-z0-9-]{1,80}$/.test(context.native_run || "") || !/^[a-z0-9-]{1,42}$/.test(context.operation_id || "") ||
        !/^(setup[0-9]*|sham1)$/.test(context.trial_id || "") || !/^[a-f0-9]{64}$/.test(context.request_sha256 || "") ||
        context.label !== "before-native-" + context.operation_id || context.label.length > 60)
      throw new Error("2149 invalid exact chronology context");
    const status = chronologyStatus();
    const identity = context.native_run + "/" + context.operation_id;
    if (condition !== "sham" || status.error || chronologyPhase === "before-native" || chronologySeen.has(identity) ||
        (chronologyNativeRun && context.native_run !== chronologyNativeRun) || chronologyTargetStarted)
      throw new Error("2149 chronology not ready or duplicate operation");
    if (Math.abs(status.viewport.scale - 1) > 1e-6) {
      chronologyFail("nonbaseline-start"); throw new Error("2149 nonbaseline chronology start");
    }
    chronologyNativeRun = context.native_run;
    chronologyTargetStarted = context.trial_id === "sham1";
    chronologySeen.add(identity);
    chronologyContext = Object.freeze({ ...context });
    chronologyPhase = "before-native";
    push({ kind: "chronology-start", label: context.label, context: chronologyContext,
      sequence: rows.length, at: status.at, chronology: status });
    if (condition !== "sham") throw new Error("2149 chronology budget stopped at start");
    return chronologyApi.export();
  };
  chronologyApi.endChronology = (context) => {
    if (chronologyPhase !== "before-native" || !context ||
        Object.keys(context).sort().join() !== Object.keys(chronologyContext).sort().join() ||
        Object.keys(chronologyContext).some((key) => context[key] !== chronologyContext[key]))
      throw new Error("2149 chronology end context mismatch");
    const status = chronologyStatus();
    if (condition !== "sham" || status.error) throw new Error("2149 chronology stopped before end");
    chronologyPhase = "after-observation";
    push({ kind: "chronology-end", label: "after-observation-" + context.operation_id,
      context: chronologyContext, sequence: rows.length, at: status.at, chronology: status });
    return chronologyApi.export();
  };
