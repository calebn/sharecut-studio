"""Synthetic fixtures only; no historical Mac receipt is loaded or reclassified."""

import math
import unittest
from unittest.mock import patch

from observation import Sample, collect_absolute, validate


def trace(times=None, scales=None):
    times = times if times is not None else list(range(0, 2001, 250))
    scales = scales if scales is not None else [1.0] * len(times)
    return [Sample(i, t, s) for i, (t, s) in enumerate(zip(times, scales, strict=True))]


class ValidatorTests(unittest.TestCase):
    def test_nominal_inclusive_left_bracket(self):
        result = validate(trace())
        self.assertTrue(result.valid, result)
        self.assertEqual(result.final_indices, (4, 5, 6, 7, 8))
        self.assertEqual(result.final_span_ms, 1000)

    def test_inferred_2001_edge_is_synthetic_not_old_run_reclassification(self):
        result = validate(trace([0, 250, 500, 750, 1000, 1250, 1500, 1750, 2001]))
        self.assertTrue(result.valid, result)
        self.assertEqual(result.final_span_ms, 1001)
        self.assertEqual(len(result.final_indices), 5)

    def test_admissible_jitter(self):
        for times in [
            [0, 255, 505, 760, 1002, 1260, 1510, 1765, 2060],
            [0, 250, 500, 760, 1160, 1410, 1660, 1910, 2150],
            [0, 250, 500, 850, 1200, 1500, 1800, 2150, 2499],
        ]:
            with self.subTest(times=times):
                self.assertTrue(validate(trace(times)).valid)

    def test_global_gap_is_inclusive_400(self):
        valid = [0, 250, 500, 750, 1150, 1400, 1650, 1900, 2150]
        self.assertTrue(validate(trace(valid)).valid)
        invalid = valid.copy()
        invalid[4] += 0.1
        self.assertIn("adjacent-gap-above-400ms", validate(trace(invalid)).reasons)

    def test_five_sample_requirement_is_additional_density_bound(self):
        times = [0, 250, 500, 750, 1050, 1450, 1850, 2250, 2499]
        result = validate(trace(times))
        self.assertFalse(result.valid)
        self.assertEqual(result.max_gap_ms, 400)
        self.assertGreaterEqual(result.final_span_ms, 1000)
        self.assertEqual(result.reasons, ("fewer-than-five-bracketed-samples",))

    def test_no_early_ending_or_hard_end_inclusive(self):
        early = validate(trace([0, 250, 500, 750, 1000, 1250, 1500, 1750, 1999]))
        self.assertIn("coverage-below-2000ms", early.reasons)
        self.assertIn("sample-before-absolute-slot", early.reasons)
        late = validate(trace([0, 250, 500, 850, 1200, 1500, 1800, 2150, 2500]))
        self.assertIn("hard-end-at-or-after-2500ms", late.reasons)

    def test_nine_actual_samples_and_slots(self):
        self.assertFalse(validate(trace()[:-1]).valid)
        data = trace()
        data[4] = Sample(3, 1000, 1)
        self.assertIn("missing-duplicate-or-out-of-order-slot", validate(data).reasons)

    def test_duplicate_nonmonotonic_nonfinite_times(self):
        for value in [750, 749, math.nan, math.inf]:
            data = trace()
            data[4] = Sample(4, value, 1)
            self.assertFalse(validate(data).valid)

    def test_all_scales_must_be_finite_positive(self):
        for value in [math.nan, math.inf, -math.inf, 0, -1]:
            data = trace()
            data[0] = Sample(0, 0, value)
            self.assertIn("scale-must-be-finite-positive", validate(data).reasons)

    def test_post_return_already_zoomed_is_valid(self):
        result = validate(trace(scales=[1.6] * 9))
        self.assertTrue(result.valid)
        self.assertTrue(result.any_zoom)

    def test_early_transient_zoom_reversal_is_retained(self):
        scales = [1, 1.6, 1.2, 1, 1, 1, 1, 1, 1]
        result = validate(trace(scales=scales))
        self.assertTrue(result.valid)
        self.assertTrue(result.any_zoom)

    def test_late_zoom_or_reversal_motion_invalid_but_retained(self):
        for scales in [[1] * 8 + [1.6], [1.6] * 8 + [1]]:
            result = validate(trace(scales=scales))
            self.assertFalse(result.valid)
            self.assertTrue(result.any_zoom)
            self.assertIn("final-scale-not-stable", result.reasons)

    def test_motion_below_one_and_cumulative_drift(self):
        for tail in [
            [1, 0.999998, 0.999997, 0.999996, 0.999995],
            [1, 1.0000003, 1.0000006, 1.0000009, 1.0000012],
        ]:
            self.assertIn("final-scale-not-stable", validate(trace(scales=[1] * 4 + tail)).reasons)

    def test_invalid_trace_never_qualified_even_with_zoom(self):
        result = validate(trace([0, 250, 500, 750, 1000, 1250, 1500, 1750, 2600], [1.6] * 9))
        self.assertFalse(result.valid)
        self.assertTrue(result.any_zoom)

    def test_absolute_timestamp_translation(self):
        shifted = [Sample(s.slot, 123456789 + s.at_ms, s.scale) for s in trace()]
        self.assertTrue(validate(shifted).valid)


class SchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def run_fake(self, reader_delays):
        class Clock:
            now = 100.0

            def time(self):
                return self.now

        class Timeout:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

        clock = Clock()
        calls = []

        async def sleep(delay):
            clock.now += delay

        async def reader(slot):
            calls.append(slot)
            clock.now += reader_delays[slot] / 1000
            return 1.0

        with (
            patch("observation.asyncio.get_running_loop", return_value=clock),
            patch("observation.asyncio.sleep", side_effect=sleep),
            patch("observation.asyncio.timeout_at", return_value=Timeout()),
        ):
            collection = await collect_absolute(reader)
        return collection, calls

    async def test_reader_delay_does_not_shift_later_absolute_slots(self):
        data, calls = await self.run_fake([0, 100, 0, 0, 0, 0, 0, 0, 0])
        relative = [round(s.at_ms - data.samples[0].at_ms, 6) for s in data.samples]
        self.assertEqual(relative, [0, 350, 500, 750, 1000, 1250, 1500, 1750, 2000])
        self.assertEqual(calls, list(range(9)))

    async def test_late_reader_is_not_recorded_or_repeated(self):
        data, calls = await self.run_fake([0, 0, 0, 0, 0, 0, 0, 0, 500])
        self.assertEqual(data.stop_reason, "hard-end")
        self.assertEqual(len(data.samples), 8)
        self.assertEqual(calls, list(range(9)))
        self.assertFalse(validate(data.samples).valid)


if __name__ == "__main__":
    unittest.main()
