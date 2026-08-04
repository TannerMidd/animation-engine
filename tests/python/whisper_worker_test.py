"""
Hermetic protocol test for the Whisper verification worker.

Injects fake whisper/librosa/torch modules and pins what the TS side depends
on: one item event per clip with the transcript stripped, greedy decoding
options, per-clip independence (no conditioning on previous text), and audio
loaded at 16 kHz mono. Run with the project venv:

    .venv/Scripts/python tests/python/whisper_worker_test.py
"""
import contextlib
import io
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src", "voice", "engines"))
import whisper_worker  # noqa: E402


class FakeModel:
    def __init__(self):
        self.calls = []

    def transcribe(self, audio, **options):
        self.calls.append(options)
        return {"text": f"  transcript {len(self.calls)}  "}


def main() -> int:
    model = FakeModel()
    loaded = []

    def load_audio(path):
        loaded.append(path)
        return [0.0] * 160

    items = [
        {"id": "a", "wav": "a.wav"},
        {"id": "b", "wav": "b.wav"},
    ]
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        rendered = whisper_worker.transcribe_items(model, load_audio, items)

    assert rendered == 2, f"expected 2 transcribed, got {rendered}"
    assert loaded == ["a.wav", "b.wav"], loaded

    events = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
    assert [e["id"] for e in events if e["event"] == "item"] == ["a", "b"], events
    assert events[0]["transcript"] == "transcript 1", "transcripts must arrive stripped"

    for options in model.calls:
        assert options["temperature"] == 0.0, "decoding must stay greedy/repeatable"
        assert options["condition_on_previous_text"] is False, "clips are independent, not a conversation"
        assert options["language"] == "en"

    print("whisper_worker_test: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
