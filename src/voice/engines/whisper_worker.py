"""
Batch Whisper transcriber for generated-line verification.

The synthesis orchestrator sends every freshly generated line through this
worker and scores the transcript against the script text; a take that does
not say its line is retried with a different seed rather than shipped. This
is deliberately a *verifier*, not an editor — it never touches audio, it only
reports what the audio says.

Protocol matches the other workers: job JSON in argv[1], one flushed JSON
event per line on stdout. Items carry {id, wav}; results are
{event:'item', id, transcript}.

Audio is loaded with librosa (already a dependency) rather than
whisper.load_audio, which shells out to whatever ffmpeg is on PATH — the
worker must not depend on PATH state.
"""
import json
import sys
import traceback


def log(**kw):
    """One JSON object per line, flushed, so Node can follow along live."""
    print(json.dumps(kw), flush=True)


def load_approved_model(whisper_module, model_path, device):
    """Open the approved checkpoint path directly; never resolve a model name."""
    return whisper_module.load_model(model_path, device=device)


def transcribe_items(model, load_audio, items):
    rendered = 0
    for item in items:
        audio = load_audio(item["wav"])
        # temperature 0 keeps decoding greedy and repeatable;
        # condition_on_previous_text off keeps clips independent — the batch
        # is a bag of lines, not a conversation transcript.
        result = model.transcribe(
            audio,
            language="en",
            temperature=0.0,
            condition_on_previous_text=False,
        )
        rendered += 1
        log(event="item", id=item["id"], transcript=(result.get("text") or "").strip())
    return rendered


def main() -> int:
    # utf-8-sig: tolerate a BOM from Windows tooling; Node never writes one.
    with open(sys.argv[1], "r", encoding="utf-8-sig") as fh:
        job = json.load(fh)

    items = job["items"]
    if not items:
        log(event="done", rendered=0)
        return 0

    try:
        import librosa
        import torch
        import whisper
    except Exception as exc:
        log(event="fatal", error=f"import failed: {exc}")
        return 1

    device = job.get("device", "cuda")
    if device == "cuda" and not torch.cuda.is_available():
        log(event="warn", message="CUDA unavailable, transcribing on CPU (slower)")
        device = "cpu"

    log(event="loading", device=device)
    try:
        model = load_approved_model(whisper, job["model_path"], device)
    except Exception as exc:
        log(event="fatal", error=f"could not load model: {exc}")
        return 1
    log(event="loaded")

    def load_audio(path):
        # Whisper expects mono float32 at 16 kHz.
        y, _ = librosa.load(path, sr=16000, mono=True)
        return y

    try:
        rendered = transcribe_items(model, load_audio, items)
    except Exception as exc:
        log(event="error", error=str(exc), trace=traceback.format_exc()[-800:])
        return 1

    log(event="done", rendered=rendered)
    return 0


if __name__ == "__main__":
    sys.exit(main())
