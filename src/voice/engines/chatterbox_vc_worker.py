"""Batch, duration-preserving Chatterbox voice conversion.

This worker is only invoked by an explicit creator action. It converts an
approved performance recording into an approved character timbre; it is never
an implicit fallback during scene rendering.

The source recording remains the timing master. Chatterbox VC is expected to
preserve its sample count closely, and the TypeScript orchestration layer
measures the result before it can be accepted.
"""

import json
import math
import struct
import sys
import traceback
import wave


def log(**kw):
    print(json.dumps(kw), flush=True)


def save_wav(path, tensor, sample_rate):
    audio = tensor.detach().cpu().flatten().clamp(-1.0, 1.0)
    pcm = (audio * 32767.0).short()
    try:
        data = pcm.numpy().tobytes()
    except Exception:
        values = pcm.tolist()
        data = struct.pack("<%dh" % len(values), *values)

    with wave.open(path, "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(int(sample_rate))
        fh.writeframes(data)

    return len(pcm), len(pcm) / float(sample_rate)


def median_pitch(librosa, numpy, file_path):
    """Robust voiced median used only for a uniform register shift."""
    audio, sample_rate = librosa.load(file_path, sr=None, mono=True)
    if len(audio) < max(256, int(sample_rate * 0.08)):
        return None
    f0, voiced, _probability = librosa.pyin(
        audio,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C7"),
        sr=sample_rate,
    )
    values = f0[numpy.isfinite(f0) & voiced]
    return float(numpy.median(values)) if len(values) else None


def apply_register_policy(torch, wav, sample_rate, item):
    policy = item.get("registerPolicy", "adapt-to-character")
    warnings = []
    source_pitch = None
    target_pitch = None
    shift = 0.0
    if policy == "adapt-to-character":
        try:
            import librosa
            import numpy as np

            source_pitch = median_pitch(librosa, np, item["source"])
            target_pitch = median_pitch(librosa, np, item["target"])
            if source_pitch and target_pitch:
                requested = 12.0 * math.log2(target_pitch / source_pitch)
                shift = max(-8.0, min(8.0, requested))
                if abs(requested - shift) > 0.01:
                    warnings.append(
                        f"character register shift was safety-clamped from {requested:.2f} to {shift:.2f} semitones"
                    )
                if abs(shift) >= 0.05:
                    samples = wav.detach().cpu().flatten().numpy()
                    shifted = librosa.effects.pitch_shift(
                        samples,
                        sr=sample_rate,
                        n_steps=shift,
                        res_type="soxr_hq",
                    )
                    # librosa preserves duration, but clamp defensively so the
                    # accepted performance remains the exact timing master.
                    if len(shifted) < len(samples):
                        shifted = np.pad(shifted, (0, len(samples) - len(shifted)))
                    wav = torch.from_numpy(shifted[:len(samples)]).float().unsqueeze(0)
            else:
                warnings.append("could not measure source/target pitch; character register adaptation was not applied")
        except Exception as exc:
            warnings.append(f"character register adaptation was unavailable: {exc}")
    elif policy != "preserve-performer":
        raise ValueError(f"unknown register policy: {policy}")

    return wav, policy, shift, source_pitch, target_pitch, warnings


def main():
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        job = json.load(fh)

    items = job.get("items", [])
    if not items:
        log(event="done", rendered=0)
        return 0

    try:
        import torch
        from chatterbox.vc import ChatterboxVC
    except Exception as exc:
        log(event="fatal", error=f"import failed: {exc}")
        return 1

    device = job.get("device", "cuda")
    if device == "cuda" and not torch.cuda.is_available():
        log(event="warn", message="CUDA unavailable, falling back to CPU")
        device = "cpu"

    if device == "cuda":
        try:
            torch.zeros(1).to("cuda")
        except Exception as exc:
            log(event="fatal", error=f"GPU unusable ({torch.cuda.get_device_name(0)}): {exc}")
            return 1

    log(event="loading", device=device)
    try:
        model = ChatterboxVC.from_pretrained(device=device)
    except Exception as exc:
        log(event="fatal", error=f"could not load voice-conversion model: {exc}")
        return 1
    log(event="loaded", sampleRate=int(model.sr))

    rendered = 0
    try:
        for item in items:
            torch.manual_seed(int(item.get("seed", 0)))
            wav = model.generate(
                audio=item["source"],
                target_voice_path=item["target"],
            )
            wav, policy, register_shift, source_pitch, target_pitch, warnings = apply_register_policy(
                torch, wav, model.sr, item
            )
            samples, seconds = save_wav(item["out"], wav, model.sr)
            rendered += 1
            log(
                event="item",
                id=item["id"],
                out=item["out"],
                durationMs=int(seconds * 1000),
                sampleRate=int(model.sr),
                samples=samples,
                registerPolicy=policy,
                registerShiftSemitones=register_shift,
                sourceMedianPitchHz=source_pitch,
                targetMedianPitchHz=target_pitch,
                warnings=warnings,
            )
    except Exception as exc:
        log(event="error", error=str(exc), trace=traceback.format_exc()[-1200:])
        return 1

    log(event="done", rendered=rendered)
    return 0


if __name__ == "__main__":
    sys.exit(main())
