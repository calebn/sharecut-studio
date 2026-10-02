type FlightKey = string | undefined;

export type SingleFlightResult<T> = { ran: true; value: T } | { ran: false };

const testResets = new Set<() => void>();

export function createSingleFlight() {
  let active: { key: FlightKey } | null = null;
  let resetEpoch = 0;
  const reset = () => {
    resetEpoch += 1;
    active = null;
  };
  testResets.add(reset);

  return {
    async run<T>(
      work: () => Promise<T>,
      key?: string,
    ): Promise<SingleFlightResult<T>> {
      if (active !== null && active.key === key) {
        return { ran: false };
      }
      active = { key };
      const startedAtEpoch = resetEpoch;
      try {
        return { ran: true, value: await work() };
      } finally {
        if (
          resetEpoch === startedAtEpoch &&
          active !== null &&
          active.key === key
        ) {
          active = null;
        }
      }
    },
  };
}

export function _resetSingleFlightsForTests(): void {
  for (const reset of testResets) {
    reset();
  }
}
