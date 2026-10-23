# Phone word correction proof for #2163

Product head: `ab220eca5bf6aa92987f1130027f73e62369c796`. Baseline: `11ba91f3bc88995eb84c600df90ea60f23fbb3b2`.

The real copied `sharecut_ux_demo` project was opened in a 320×568 Chromium touch viewport. Two real touchscreen taps opened Correct mode. Initial boxes were read before field focus or sheet scrolling.

| Case | Sheet bottom | Corrected text bottom | Apply bottom |
| --- | ---: | ---: | ---: |
| Before | 516 | 1200 | 1274 |
| After | 516 | 382 | 456 |
| Long word and track identity | 516 | 402 | 476 |

[Before](before.png), [after](after.png), [long word](long-word.png). [Compact receipt](receipt.json) includes source blobs, input and actual nonempty JS/CSS response-body SHA256 hashes, 44px controls, no-scroll geometry, visible validation, real correction and UI Undo, phrase correction and Undo, and preserved Select ordering. Full original long heading remains accessible.

This proves Chromium desktop emulation only. It does not establish native Safari, hardware, or software-keyboard acceptance. The long word and track identity are synthetic changes to a disposable fixture copy. Other controls were later scrolled into view to verify reachability. These images and receipts contain only public fixture content.
