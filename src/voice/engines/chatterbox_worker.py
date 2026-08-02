"""
Batch Chatterbox TTS renderer.

Invoked once per job with JSON describing every line that needs synthesizing.
Batching matters a great deal here: loading the model costs several seconds and
several GB of VRAM, so doing it per line would dominate the runtime of the
whole pipeline.

Reads the job from argv[1], writes one JSON result line per item to stdout so
the caller can stream progress.

CONDITIONING IS PER-ITEM STATE, AND IT LEAKS. ChatterboxTTS.generate() with an
audio_prompt_path overwrites the model's resident conditionals; without one it
silently *reuses whatever is already there*. Loop a cast through one model and
every unreferenced character after the first cloned one inherits that clone's
voice. The default conditionals are therefore snapshotted at load and restored
before every unreferenced item — every line gets exactly the speaker it asked
for, never the previous item's.
"""
import json
import struct
import sys
import traceback
import wave


def log(**kw):
    """One JSON object per line, flushed, so Node can follow along live."""
    print(json.dumps(kw), flush=True)


def save_wav(path, tensor, sample_rate):
    """
    Write mono 16-bit PCM directly, bypassing torchaudio.save.

    torchaudio 2.11 routes save() through TorchCodec, which is a separate
    install. Writing the WAV here avoids that dependency entirely and, more
    usefully, pins the output format — the dialogue mixer places samples
    natively and requires every line to share a sample rate and channel count.
    """
    audio = tensor.detach().cpu().flatten().clamp(-1.0, 1.0)
    pcm = (audio * 32767.0).short()

    try:
        data = pcm.numpy().tobytes()
    except Exception:
        # numpy missing or unusable — slower, but never a hard failure.
        values = pcm.tolist()
        data = struct.pack("<%dh" % len(values), *values)

    with wave.open(path, "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(int(sample_rate))
        fh.writeframes(data)

    return len(pcm) / float(sample_rate)


def render_items(model, torch, items):
    """One pass over the batch, with explicit conditioning per item."""
    # The built-in voice, as loaded. Restored for every unreferenced item so no
    # line can inherit the previous line's speaker.
    default_conds = model.conds

    rendered = 0
    for item in items:
        # Seed per item so a re-render of an unchanged line is identical, and
        # so one changed line does not reroll every other take.
        torch.manual_seed(int(item.get("seed", 0)))

        ref = item.get("ref")
        if ref:
            model.prepare_conditionals(ref, exaggeration=float(item.get("exaggeration", 0.5)))
        else:
            model.conds = default_conds

        wav = model.generate(
            item["text"],
            exaggeration=float(item.get("exaggeration", 0.5)),
            cfg_weight=float(item.get("cfg_weight", 0.5)),
        )
        duration_ms = int(save_wav(item["out"], wav, model.sr) * 1000)
        rendered += 1
        log(event="item", id=item["id"], out=item["out"], durationMs=duration_ms)

    return rendered


def main() -> int:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        job = json.load(fh)

    items = job["items"]
    if not items:
        log(event="done", rendered=0)
        return 0

    try:
        import torch
        from chatterbox.tts import ChatterboxTTS
    except Exception as exc:
        log(event="fatal", error=f"import failed: {exc}")
        return 1

    device = job.get("device", "cuda")
    if device == "cuda" and not torch.cuda.is_available():
        log(event="warn", message="CUDA unavailable, falling back to CPU (much slower)")
        device = "cpu"

    if device == "cuda":
        # Blackwell (sm_120) needs a torch built with CUDA 12.8+. Fail loudly
        # here rather than deep inside the first generate() call.
        try:
            torch.zeros(1).to("cuda")
        except Exception as exc:
            log(event="fatal", error=f"GPU unusable ({torch.cuda.get_device_name(0)}): {exc}")
            return 1

    log(event="loading", device=device)
    try:
        model = ChatterboxTTS.from_pretrained(device=device)
    except Exception as exc:
        log(event="fatal", error=f"could not load model: {exc}")
        return 1
    log(event="loaded", sample_rate=int(model.sr))

    try:
        rendered = render_items(model, torch, items)
    except Exception as exc:
        log(event="error", error=str(exc), trace=traceback.format_exc()[-800:])
        return 1

    log(event="done", rendered=rendered)
    return 0


if __name__ == "__main__":
    sys.exit(main())
