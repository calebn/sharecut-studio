# Observation-v2 verification summary

The three Python source files are the exact frozen files reviewed for the observation-v2 reference. The separate public manifest contains their full hashes and the hashes of this summary and the fresh-run handoff.

Seventeen unit tests passed. They cover deterministic timing jitter, the inclusive left bracket, the synthetic2001ms endpoint edge, excessive gaps, hard expiry, short or incomplete traces, duplicate and nonmonotonic data, nonfinite or nonpositive scales, absolute deadline scheduling, stable zoom already present at the first post-return sample, transient zoom followed by reversal, and an unstable final tail. Ruff lint and format checks passed. Independent review of the actual source passed.

ONE actual Python asyncio timing run passed. It recorded nine actual samples over2121.515ms, a maximum adjacent gap of344.738ms, and five final bracketed samples spanning1120.978ms. The callback delay fixture used0,15,5,20,0,35,10,25,120ms. The original raw receipt is preserved privately. This publication does not rerun that fixture.

An independent root simulation passed10000 deterministic cases using seed2149 and callback lateness between0 and150ms after the absolute deadlines. No case was invalid. This is tested jitter coverage, not a guarantee for all schedules. The five-sample tail rule is deliberately stricter than the400ms maximum-gap rule alone. The unit tests include an otherwise gap-admissible late schedule that fails the extra density requirement.

These are numerical and scheduler checks. They are not Safari, native gesture or product-efficacy proof. The reference records timestamps when its Python callback completes. The Mac browser sampler must record its own actual browser monotonic observation timestamps. It must not substitute HTTP completion times or scheduled ideal times.

The2001ms endpoint example is synthetic inferred input. The earlier Mac case remains INVALID under its original observation rule. Do not relabel, resume or replay that case, or remove its invalid-lifecycle lock. Parent reports its native ACK and final XCTest qualification succeeded while its browser observation failed. Raw Mac receipts have not been inspected in cloud.

Only the five files listed in sha256.json are part of this new package. No private Mac paths, tokens, recordings, raw case logs, user data, or machine-local check reports are included. The package changes no product, server route, CSP or other security policy. The failed product candidate remains draft and unaccepted.
