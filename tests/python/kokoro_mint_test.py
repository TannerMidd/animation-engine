"""
Hermetic regression test for the Kokoro mint worker.

Drives render_items with a fake pipeline (no weights, no kokoro install) and
pins the protocol the TS side and the reference format depend on: one item
event per rendered clip, per-item seeding, segment concatenation with the
breath spacer, 16-bit/24 kHz mono WAV output, and a loud failure on empty
audio. Run with the project venv:

    .venv/Scripts/python tests/python/kokoro_mint_test.py
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import wave

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src", "voice", "engines"))
import kokoro_mint_worker  # noqa: E402


class FakeTensor:
    def __init__(self, values):
        self.values = [float(v) for v in values]

    def detach(self):
        return self

    def cpu(self):
        return self

    def flatten(self):
        return self

    def abs(self):
        return FakeTensor([abs(v) for v in self.values])

    def max(self):
        return max(self.values) if self.values else 0.0

    def tolist(self):
        return list(self.values)


class FakeTorch:
    seeds = []

    @staticmethod
    def manual_seed(s):
        FakeTorch.seeds.append(int(s))

    @staticmethod
    def zeros(n):
        return FakeTensor([0.0] * int(n))

    @staticmethod
    def cat(parts):
        out = []
        for p in parts:
            out.extend(p.values)
        return FakeTensor(out)


class FakeResult:
    def __init__(self, audio):
        self.audio = audio


class FakePipeline:
    def __init__(self, segments):
        self.segments = segments
        self.calls = []

    def __call__(self, text, voice, speed):
        self.calls.append((text, voice, speed))
        for seg in self.segments:
            yield FakeResult(None if seg is None else FakeTensor(seg))


def main() -> int:
    spacer = int(kokoro_mint_worker.SAMPLE_RATE * 0.12)

    with tempfile.TemporaryDirectory() as tmp:
        # Two segments -> one spacer between them; a None audio result is skipped.
        pipeline = FakePipeline([[0.5] * 240, None, [0.25] * 240])
        items = [
            {"id": "a", "out": os.path.join(tmp, "a.wav"), "text": "hi", "bankVoice": "af_test", "speed": 1.02, "seed": 11},
            {"id": "b", "out": os.path.join(tmp, "b.wav"), "text": "ho", "bankVoice": "af_other", "speed": 0.97, "seed": 12},
        ]
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            rendered, ok = kokoro_mint_worker.render_items({"a": pipeline}, FakeTorch, items)

        assert (rendered, ok) == (2, True), f"expected clean render, got {(rendered, ok)}"
        assert FakeTorch.seeds == [11, 12], f"per-item seeding broken: {FakeTorch.seeds}"
        assert [c[1] for c in pipeline.calls] == ["af_test", "af_other"], pipeline.calls
        assert [c[2] for c in pipeline.calls] == [1.02, 0.97], "speed must pass through untouched"

        events = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
        item_events = [e for e in events if e["event"] == "item"]
        assert len(item_events) == 2, f"expected one item event per clip, got {events}"

        with wave.open(items[0]["out"], "rb") as fh:
            assert fh.getnchannels() == 1, "reference clips are mono"
            assert fh.getsampwidth() == 2, "reference clips are 16-bit PCM"
            assert fh.getframerate() == kokoro_mint_worker.SAMPLE_RATE
            expected = 240 + spacer + 240
            assert fh.getnframes() == expected, f"segments + spacer: want {expected}, got {fh.getnframes()}"
            first = int.from_bytes(fh.readframes(1), "little", signed=True)
            assert first == round(0.5 * 32767.0), f"sample scaling off: {first}"

        # Empty output must fail the item loudly, never commit a silent reference.
        silent = FakePipeline([])
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            rendered, ok = kokoro_mint_worker.render_items(
                {"a": silent}, FakeTorch,
                [{"id": "c", "out": os.path.join(tmp, "c.wav"), "text": "x", "bankVoice": "af_test", "speed": 1.0, "seed": 1}],
            )
        assert (rendered, ok) == (0, False), "empty audio must not count as rendered"
        events = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
        assert any(e["event"] == "error" for e in events), f"expected an error event, got {events}"
        assert not os.path.exists(os.path.join(tmp, "c.wav")), "no file may appear for a failed item"

    print("kokoro_mint_test: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
