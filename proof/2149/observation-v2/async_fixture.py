"""ONE real asyncio timing fixture; no browser, Safari, input, or native claim."""

import asyncio
import json
from pathlib import Path

from observation import collect_absolute, report


async def main():
    jitter_ms = [0, 15, 5, 20, 0, 35, 10, 25, 120]
    loop = asyncio.get_running_loop()
    callbacks = []

    async def reader(slot):
        callbacks.append({"slot": slot, "entered_monotonic_ms": loop.time() * 1000})
        await asyncio.sleep(jitter_ms[slot] / 1000)
        return 1.0

    collection = await collect_absolute(reader)
    result = report(collection)
    t0 = collection.samples[0].at_ms if collection.samples else 0
    result.update(
        scope="actual Python asyncio timer only; no Safari/native/bug efficacy",
        controlled_reader_jitter_ms=jitter_ms,
        reader_entries=callbacks,
        actual_relative_ms=[s.at_ms - t0 for s in collection.samples],
    )
    Path(__file__).with_name("async-receipt.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    if collection.stop_reason != "nine-samples" or not result["verdict"]["valid"]:
        raise SystemExit("Actual scheduler trace INVALID; receipt retained, no rerun")


if __name__ == "__main__":
    asyncio.run(main())
