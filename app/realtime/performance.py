"""Local latency-budget measurement helpers for the realtime media plane.

These helpers measure the CPU-bound, in-process cost of a code path (for
example ``SpeechQueue.cancel_current()`` reacting to a barge-in, timed with
``time.perf_counter_ns()``). They deliberately say nothing about end-to-end
wall-clock latency across the WebSocket boundary to the TypeScript sidecar --
that is a separate, larger budget validated by integration/hardware tests,
not by anything in this module or by unit tests that import it.
"""

NS_PER_MS = 1_000_000

# Local barge-in cancellation (SpeechQueue.cancel_current, driven by
# SpeechQueueProcessor reacting to UserStartedSpeakingFrame -- see
# speech_queue.py) must complete well within this budget. This is local
# queue/processor overhead only; see tests/performance/test_barge_in_latency.py.
LOCAL_BARGE_IN_BUDGET_MS = 5.0

# The larger, end-to-end barge-in budget (audio-in to audio actually
# stopped, including any sidecar hop). Validated elsewhere, by
# integration/hardware tests -- never by a unit test in this repo.
END_TO_END_BARGE_IN_BUDGET_MS = 150.0


def percentile_ms(samples_ns: list[int], rank: float) -> float:
    """Return the ``rank``th percentile (0-100) of nanosecond samples, in milliseconds.

    Uses linear interpolation between the two nearest ranks over a sorted
    copy of ``samples_ns``.
    """
    if not samples_ns:
        raise ValueError("samples_ns must not be empty")
    if not 0 <= rank <= 100:
        raise ValueError("rank must be between 0 and 100")

    ordered = sorted(samples_ns)
    if len(ordered) == 1:
        return ordered[0] / NS_PER_MS

    position = (rank / 100) * (len(ordered) - 1)
    lower_index = int(position)
    upper_index = min(lower_index + 1, len(ordered) - 1)
    fraction = position - lower_index

    interpolated_ns = ordered[lower_index] + (ordered[upper_index] - ordered[lower_index]) * fraction
    return interpolated_ns / NS_PER_MS
