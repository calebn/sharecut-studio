export function commandLocks(): LockManager {
  const names = new Map<
    string,
    { shared: number; exclusive: boolean; pending: (() => void)[] }
  >();
  const manager = {
    request(
      name: string,
      options: LockOptions,
      callback: (lock: Lock) => unknown,
    ) {
      const state = names.get(name) ?? {
        shared: 0,
        exclusive: false,
        pending: [],
      };
      names.set(name, state);
      return new Promise((resolve, reject) => {
        const acquire = () => {
          const shared = options.mode === "shared";
          if (state.exclusive || (!shared && state.shared > 0)) return;
          state.pending.shift();
          if (shared) state.shared++;
          else state.exclusive = true;
          Promise.resolve()
            .then(() => callback({ name, mode: options.mode ?? "exclusive" }))
            .then(resolve, reject)
            .finally(() => {
              if (shared) state.shared--;
              else state.exclusive = false;
              state.pending[0]?.();
            });
          if (shared) state.pending[0]?.();
        };
        state.pending.push(acquire);
        if (state.pending.length === 1) acquire();
      });
    },
  };
  return manager as LockManager;
}
