# synthetic_bleed_60s

Two-track fixture with controlled cross-bleed (12 to 16 s overlap).

Each word is its own tone (five semitones apart) so `echo_risk` can measure the
bleed path against its time-shifted null (#774).

Regenerate: `python scripts/build_synthetic_bleed_fixture.py`
