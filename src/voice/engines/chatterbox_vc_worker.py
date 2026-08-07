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
import os
import struct
import sys
import traceback
import wave


def log(**kw):
    print(json.dumps(kw), flush=True)


def load_approved_model(model_class, model_dir, device):
    """Load only the manifest-selected snapshot supplied by the orchestrator."""
    return model_class.from_local(model_dir, device=device)


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


def voicing(librosa, numpy, audio, sample_rate):
    """Median voiced pitch and the share of frames that are voiced at all.

    The voiced share is the honest signal for "is this still speech". A
    conversion that collapses into breathy noise keeps its loudness and its
    energy envelope, so amplitude-based checks wave it through; its voiced
    frames are what disappear.
    """
    if len(audio) < max(256, int(sample_rate * 0.08)):
        return None, None
    f0, voiced, _probability = librosa.pyin(
        audio,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C7"),
        sr=sample_rate,
    )
    values = f0[numpy.isfinite(f0) & voiced]
    ratio = float(len(values)) / float(max(1, len(f0)))
    return (float(numpy.median(values)) if len(values) else None), ratio


def voicing_of_file(librosa, numpy, file_path):
    audio, sample_rate = librosa.load(file_path, sr=None, mono=True)
    return voicing(librosa, numpy, audio, sample_rate)


def write_mono_wav(numpy, path, audio, sample_rate):
    pcm = numpy.clip(audio, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    with wave.open(path, "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(int(sample_rate))
        fh.writeframes(pcm.tobytes())


# Chatterbox can collapse a short utterance into high-frequency noise when the
# source file is mostly leading/trailing silence. Keep internal pauses, but
# remove external silence before conversion and put the result back on the
# original clock afterwards. A 100 ms margin keeps breaths and quiet consonants.
SPEECH_FRAME_MS = 20
SPEECH_MARGIN_MS = 100
MIN_REMOVABLE_SILENCE_MS = 250
MIN_CONVERSION_AUDIO_MS = 250
SPEECH_ABSOLUTE_RMS = 10.0 ** (-42.0 / 20.0)
SPEECH_RELATIVE_RMS = 10.0 ** (-30.0 / 20.0)


def conversion_source(librosa, numpy, source_path, job_dir):
    """Return a speech-bounded source plus the data needed to restore timing."""
    audio, sample_rate = librosa.load(source_path, sr=None, mono=True)
    frame = max(1, int(round(sample_rate * SPEECH_FRAME_MS / 1000.0)))
    frame_count = int(math.ceil(len(audio) / float(frame)))
    rms = numpy.zeros(frame_count, dtype=float)
    for index in range(frame_count):
        chunk = audio[index * frame:min(len(audio), (index + 1) * frame)]
        if len(chunk):
            rms[index] = float(numpy.sqrt(numpy.mean(chunk * chunk)))

    peak = float(numpy.max(rms)) if len(rms) else 0.0
    threshold = max(SPEECH_ABSOLUTE_RMS, peak * SPEECH_RELATIVE_RMS)
    active = numpy.flatnonzero(rms >= threshold)
    if not len(active):
        return source_path, None

    margin = int(round(sample_rate * SPEECH_MARGIN_MS / 1000.0))
    start = max(0, int(active[0]) * frame - margin)
    end = min(len(audio), (int(active[-1]) + 1) * frame + margin)
    removable_ms = (start + len(audio) - end) * 1000.0 / sample_rate
    conversion_ms = (end - start) * 1000.0 / sample_rate
    if removable_ms < MIN_REMOVABLE_SILENCE_MS or conversion_ms < MIN_CONVERSION_AUDIO_MS:
        return source_path, None

    trimmed = os.path.join(job_dir, "source-%s.wav" % abs(hash((source_path, start, end))))
    write_mono_wav(numpy, trimmed, audio[start:end], sample_rate)
    return trimmed, {
        "sourceSampleRate": sample_rate,
        "sourceSamples": len(audio),
        "startSample": start,
        "endSample": end,
    }


def restore_source_timing(torch, wav, sample_rate, timing):
    """Place converted speech back on the source clock at its exact duration."""
    if not timing:
        return wav

    source_rate = timing["sourceSampleRate"]
    total = int(round(timing["sourceSamples"] * sample_rate / float(source_rate)))
    start = int(round(timing["startSample"] * sample_rate / float(source_rate)))
    end = int(round(timing["endSample"] * sample_rate / float(source_rate)))
    expected = max(0, min(total, end) - min(total, start))
    converted = wav.detach().cpu().flatten()
    restored = torch.zeros(total, dtype=converted.dtype)
    copied = min(expected, len(converted))
    if copied:
        restored[start:start + copied] = converted[:copied]
    return restored.unsqueeze(0)


# The model already re-voices into the target speaker, so the register it
# produces is the target's. Anything past a small residual correction is
# damage: librosa's phase vocoder does not move formants, which is what makes
# an over-shifted result sound like a pitch-shifted original rather than a
# different person.
MAX_RESIDUAL_SEMITONES = 2.0
MIN_RESIDUAL_SEMITONES = 0.75

# Below roughly 85 Hz the speaker encoder stops resolving a voice at all and
# the conversion collapses into breathy noise — measured on this engine, an
# 80 Hz reference retains 0.22 of the performance's voicing while 90, 94 and
# 104 Hz references retain 1.14-1.31. Conditioning is therefore normalised
# into range before conversion. The character's own register is not lost by
# doing so: the output lands a couple of semitones under the conditioning, so
# a reference raised into range converts back down onto the voice it came from.
MIN_CONDITIONING_PITCH_HZ = 95.0
MAX_CONDITIONING_LIFT_SEMITONES = 8.0


def conditioning_target(librosa, numpy, target_path, target_pitch, job_dir):
    """A copy of the target reference the model can actually read.

    Returns (path, lift_semitones, warnings). An in-range reference is used
    untouched — this only rescues voices the encoder would otherwise drop.
    """
    if not target_pitch or target_pitch >= MIN_CONDITIONING_PITCH_HZ:
        return target_path, 0.0, []

    lift = 12.0 * math.log2(MIN_CONDITIONING_PITCH_HZ / target_pitch)
    if lift > MAX_CONDITIONING_LIFT_SEMITONES:
        return target_path, 0.0, [
            "target voice reference sits at %.0f Hz, too far below the %.0f Hz the converter "
            "can read; conversion will not resemble it" % (target_pitch, MIN_CONDITIONING_PITCH_HZ)
        ]

    audio, sample_rate = librosa.load(target_path, sr=None, mono=True)
    lifted = librosa.effects.pitch_shift(audio, sr=sample_rate, n_steps=lift, res_type="soxr_hq")
    path = os.path.join(job_dir, "conditioning-%s.wav" % abs(hash((target_path, round(lift, 3)))))
    write_mono_wav(numpy, path, lifted, sample_rate)
    return path, lift, [
        "target voice reference sits at %.0f Hz, under the converter's %.0f Hz floor; conditioning "
        "was lifted %.2f semitones so the voice resolves. The conversion still lands in the "
        "character's own register." % (target_pitch, MIN_CONDITIONING_PITCH_HZ, lift)
    ]


def apply_register_policy(torch, wav, sample_rate, item, measured):
    """Nudge the converted output onto the target's register, if it missed.

    The correction is measured against the *conversion*, never against the
    source recording. Measuring source-to-target and applying it here shifts a
    signal that has already moved, landing a full interval past the character.
    """
    policy = item.get("registerPolicy", "adapt-to-character")
    warnings = []
    shift = 0.0
    if policy not in ("adapt-to-character", "preserve-performer"):
        raise ValueError(f"unknown register policy: {policy}")
    if policy != "adapt-to-character":
        return wav, policy, shift, warnings

    output_pitch = measured.get("outputMedianPitchHz")
    target_pitch = measured.get("targetMedianPitchHz")
    if not output_pitch or not target_pitch:
        warnings.append("could not measure converted/target pitch; character register adaptation was not applied")
        return wav, policy, shift, warnings

    try:
        import librosa
        import numpy as np

        residual = 12.0 * math.log2(target_pitch / output_pitch)
        if abs(residual) < MIN_RESIDUAL_SEMITONES:
            return wav, policy, shift, warnings
        shift = max(-MAX_RESIDUAL_SEMITONES, min(MAX_RESIDUAL_SEMITONES, residual))
        if abs(residual - shift) > 0.01:
            warnings.append(
                f"conversion landed {residual:.2f} semitones from the character's register; "
                f"correction was clamped to {shift:.2f} to avoid formant damage"
            )
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
    except Exception as exc:
        shift = 0.0
        warnings.append(f"character register adaptation was unavailable: {exc}")

    return wav, policy, shift, warnings


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
        model = load_approved_model(ChatterboxVC, job["model_dir"], device)
    except Exception as exc:
        log(event="fatal", error=f"could not load voice-conversion model: {exc}")
        return 1
    log(event="loaded", sampleRate=int(model.sr))

    try:
        import librosa
        import numpy as np
    except Exception as exc:
        log(event="fatal", error=f"pitch analysis is unavailable: {exc}")
        return 1

    job_dir = os.path.dirname(os.path.abspath(sys.argv[1]))
    rendered = 0
    try:
        for item in items:
            source_pitch, source_voiced = voicing_of_file(librosa, np, item["source"])
            target_pitch, _target_voiced = voicing_of_file(librosa, np, item["target"])
            conversion_audio, source_timing = conversion_source(
                librosa, np, item["source"], job_dir
            )
            conditioning, lift, lift_warnings = conditioning_target(
                librosa, np, item["target"], target_pitch, job_dir
            )
            torch.manual_seed(int(item.get("seed", 0)))
            wav = model.generate(
                audio=conversion_audio,
                target_voice_path=conditioning,
            )
            output_pitch, output_voiced = voicing(
                librosa, np, wav.detach().cpu().flatten().numpy(), int(model.sr)
            )
            measured = {
                "sourceMedianPitchHz": source_pitch,
                "targetMedianPitchHz": target_pitch,
                "outputMedianPitchHz": output_pitch,
            }
            wav, policy, register_shift, warnings = apply_register_policy(
                torch, wav, model.sr, item, measured
            )
            warnings = lift_warnings + warnings
            if register_shift:
                output_pitch, output_voiced = voicing(
                    librosa, np, wav.detach().cpu().flatten().numpy(), int(model.sr)
                )
            wav = restore_source_timing(torch, wav, int(model.sr), source_timing)
            if source_timing:
                output_pitch, output_voiced = voicing(
                    librosa, np, wav.detach().cpu().flatten().numpy(), int(model.sr)
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
                conditioningLiftSemitones=lift,
                sourceMedianPitchHz=source_pitch,
                targetMedianPitchHz=target_pitch,
                outputMedianPitchHz=output_pitch,
                sourceVoicedRatio=source_voiced,
                outputVoicedRatio=output_voiced,
                warnings=warnings,
            )
    except Exception as exc:
        log(event="error", error=str(exc), trace=traceback.format_exc()[-1200:])
        return 1

    log(event="done", rendered=rendered)
    return 0


if __name__ == "__main__":
    sys.exit(main())
