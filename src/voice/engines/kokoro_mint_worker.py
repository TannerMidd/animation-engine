"""
Batch Kokoro-82M reference-clip renderer.

Mint-only: this worker exists to give a character a *natural-sounding*
reference clip for Chatterbox to clone, replacing the old SAPI/pitch-shift
mint chain whose robotic prosody cloned straight into every performance. It is
deliberately not a dialogue engine — line synthesis stays with Chatterbox,
which owns emotion control and zero-shot cloning.

Protocol matches chatterbox_worker.py: job JSON in argv[1], one flushed JSON
event per line on stdout (loading / loaded / item / warn / error / fatal /
done), audio written as mono 16-bit PCM WAV directly to the caller-chosen
path. Items carry {id, out, text, bankVoice, speed, seed}.

Runs on CPU on purpose: 82M params reading one fixed paragraph is seconds of
work, single-threaded torch keeps it bit-stable across runs, and minting never
has to arbitrate VRAM with a resident Chatterbox or Ollama.

Named kokoro_mint_worker.py, not kokoro.py — Python puts a script's own
directory first on sys.path, so a worker named after the package would shadow
the installed package and break its own import.
"""
import json
import os
import struct
import sys
import traceback
import wave


def log(**kw):
    """One JSON object per line, flushed, so Node can follow along live."""
    print(json.dumps(kw), flush=True)


SAMPLE_RATE = 24000  # Kokoro's native rate; also the project's reference rate.


def save_wav(path, samples, sample_rate):
    """Write mono 16-bit PCM directly; same rationale as chatterbox_worker."""
    clipped = [max(-1.0, min(1.0, float(v))) for v in samples]
    pcm = [int(round(v * 32767.0)) for v in clipped]
    data = struct.pack("<%dh" % len(pcm), *pcm)

    with wave.open(path, "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(int(sample_rate))
        fh.writeframes(data)

    return len(pcm) / float(sample_rate)


def render_items(pipelines, torch, items):
    """One pass over the batch. `pipelines` maps a language prefix to a KPipeline."""
    rendered = 0
    for item in items:
        voice = item["bankVoice"]
        # Kokoro inference is non-sampling, so the seed is defensive: if a
        # future version samples anywhere, mints stay reproducible per item.
        torch.manual_seed(int(item.get("seed", 0)))

        pipeline = pipelines[voice[0]]
        segments = []
        for result in pipeline(item["text"], voice=voice, speed=float(item.get("speed", 1.0))):
            audio = result.audio
            if audio is None:
                continue
            segments.append(audio.detach().cpu().flatten())

        if not segments:
            log(event="error", id=item["id"], error=f"kokoro produced no audio for voice {voice}")
            return rendered, False

        # MINT_TEXT is one paragraph, so this is normally a single segment; the
        # spacer only matters if the pipeline ever splits, and 120 ms keeps any
        # split reading like a breath rather than a cut.
        spacer = torch.zeros(int(SAMPLE_RATE * 0.12))
        joined = []
        for i, seg in enumerate(segments):
            if i:
                joined.append(spacer)
            joined.append(seg)
        audio = torch.cat(joined)

        if not float(audio.abs().max()) > 0.0:
            log(event="error", id=item["id"], error=f"kokoro produced silent audio for voice {voice}")
            return rendered, False

        duration_ms = int(save_wav(item["out"], audio.tolist(), SAMPLE_RATE) * 1000)
        rendered += 1
        log(event="item", id=item["id"], out=item["out"], durationMs=duration_ms)

    return rendered, True


def load_pipelines(KModel, KPipeline, torch, items, model_dir):
    """Load the approved snapshot directly; never resolve Hugging Face refs."""
    repository = "hexgrad/Kokoro-82M"
    shared_model = KModel(
        repo_id=repository,
        config=os.path.join(model_dir, "config.json"),
        model=os.path.join(model_dir, "kokoro-v1_0.pth"),
    ).to("cpu").eval()
    pipelines = {}
    for item in items:
        prefix = item["bankVoice"][0]
        if prefix not in pipelines:
            pipelines[prefix] = KPipeline(
                lang_code=prefix,
                repo_id=repository,
                model=shared_model,
                device="cpu",
            )
        voice = item["bankVoice"]
        if voice not in pipelines[prefix].voices:
            voice_file = os.path.join(model_dir, "voices", f"{voice}.pt")
            pipelines[prefix].voices[voice] = torch.load(voice_file, weights_only=True)
    return pipelines


def main() -> int:
    # utf-8-sig: tolerate a BOM from Windows tooling; Node never writes one.
    with open(sys.argv[1], "r", encoding="utf-8-sig") as fh:
        job = json.load(fh)

    items = job["items"]
    if not items:
        log(event="done", rendered=0)
        return 0

    try:
        import torch
        from kokoro import KModel, KPipeline
    except Exception as exc:
        log(event="fatal", error=f"import failed: {exc}")
        return 1

    torch.set_num_threads(1)

    log(event="loading", device="cpu")
    try:
        # One pipeline per language prefix ('a' American, 'b' British), all
        # sharing one 82M model loaded from the manifest-selected snapshot.
        pipelines = load_pipelines(KModel, KPipeline, torch, items, job["model_dir"])
    except Exception as exc:
        log(event="fatal", error=f"could not load model: {exc}")
        return 1
    log(event="loaded", sample_rate=SAMPLE_RATE)

    try:
        rendered, ok = render_items(pipelines, torch, items)
    except Exception as exc:
        log(event="error", error=str(exc), trace=traceback.format_exc()[-800:])
        return 1

    log(event="done", rendered=rendered)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
