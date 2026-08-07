"""Register handling in the voice-conversion worker.

Two rules decide whether a converted line sounds like the character or like a
pitch-shifted stranger, and both are cheap to pin without loading the model:

  1. a target reference under the encoder's floor is lifted into range *for
     conditioning only*, because below it the conversion collapses into noise;
  2. the register correction is measured against the conversion, never against
     the source recording — measuring source-to-target and applying it to an
     already-converted signal lands a full interval past the character.
"""

import importlib.util
import math
import os
import sys
import tempfile
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location(
    "vc_worker", os.path.join(ROOT, "src", "voice", "engines", "chatterbox_vc_worker.py")
)
vc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vc)

import librosa  # noqa: E402  (after the worker import, which is the unit under test)


class FakeModelClass:
    called = None

    @classmethod
    def from_local(cls, model_dir, device):
        cls.called = (model_dir, device)
        return "approved-model"


def tone(path, hz, seconds=1.5, sample_rate=24000):
    """A buzzy harmonic tone — enough structure for pyin to track a pitch."""
    t = np.arange(int(seconds * sample_rate)) / sample_rate
    wave_data = sum(np.sin(2 * np.pi * hz * n * t) / n for n in (1, 2, 3, 4))
    wave_data = wave_data / np.max(np.abs(wave_data)) * 0.8
    pcm = (wave_data * 32767).astype("<i2")
    with wave.open(path, "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(sample_rate)
        fh.writeframes(pcm.tobytes())
    return path


def median_hz(path):
    audio, sr = librosa.load(path, sr=None, mono=True)
    pitch, _ratio = vc.voicing(librosa, np, audio, sr)
    return pitch


def test_low_reference_is_lifted_into_range(work):
    low = tone(os.path.join(work, "low.wav"), 80.0)
    measured = median_hz(low)
    path, lift, warnings = vc.conditioning_target(librosa, np, low, measured, work)

    assert path != low, "an under-floor reference must be conditioned from a lifted copy"
    assert lift > 0, "lift must raise, never lower"
    assert warnings and "floor" in warnings[0]
    lifted = median_hz(path)
    assert lifted >= vc.MIN_CONDITIONING_PITCH_HZ - 4, f"lifted to {lifted:.1f} Hz"
    # The original reference on disk is never touched: it stays the character.
    assert abs(median_hz(low) - measured) < 0.5


def test_in_range_reference_is_used_untouched(work):
    ok = tone(os.path.join(work, "ok.wav"), 140.0)
    path, lift, warnings = vc.conditioning_target(librosa, np, ok, median_hz(ok), work)
    assert path == ok and lift == 0.0 and warnings == []


def test_sparse_short_line_is_bounded_for_conversion_and_restored(work):
    import torch

    sample_rate = 24000
    speech = tone(os.path.join(work, "speech.wav"), 110.0, seconds=0.35, sample_rate=sample_rate)
    spoken, _ = librosa.load(speech, sr=None, mono=True)
    silence = np.zeros(sample_rate, dtype=np.float32)
    source_audio = np.concatenate([silence, spoken, silence])
    source = os.path.join(work, "sparse.wav")
    vc.write_mono_wav(np, source, source_audio, sample_rate)

    conversion, timing = vc.conversion_source(librosa, np, source, work)
    assert conversion != source and timing is not None
    bounded, bounded_rate = librosa.load(conversion, sr=None, mono=True)
    assert bounded_rate == sample_rate
    assert len(bounded) < len(source_audio) / 2, "external silence should not reach the converter"

    restored = vc.restore_source_timing(
        torch,
        torch.from_numpy(bounded).float().unsqueeze(0),
        sample_rate,
        timing,
    ).detach().cpu().flatten().numpy()
    assert len(restored) == len(source_audio), "the performance must keep its exact clock"
    nonzero = np.flatnonzero(np.abs(restored) > 0.01)
    assert nonzero[0] >= sample_rate * 0.95
    assert nonzero[-1] <= sample_rate * 1.40


def test_dense_line_is_not_needlessly_rewritten(work):
    source = tone(os.path.join(work, "dense.wav"), 110.0)
    conversion, timing = vc.conversion_source(librosa, np, source, work)
    assert conversion == source and timing is None


def test_register_correction_measures_the_conversion_not_the_source():
    """A conversion already sitting on the character needs no correction.

    Under the old rule this case drew the full source-to-target interval
    (-5.4 semitones) and pushed the result far below the character.
    """
    import torch

    wav = torch.zeros(1, 2400)
    _out, policy, shift, _warnings = vc.apply_register_policy(
        torch, wav, 24000, {"registerPolicy": "adapt-to-character"},
        {"sourceMedianPitchHz": 109.4, "targetMedianPitchHz": 80.1, "outputMedianPitchHz": 80.0},
    )
    assert policy == "adapt-to-character"
    assert shift == 0.0, f"expected no correction, got {shift}"


def test_register_correction_is_clamped_and_directional():
    import torch

    wav = torch.zeros(1, 24000)
    _out, _policy, shift, warnings = vc.apply_register_policy(
        torch, wav, 24000, {"registerPolicy": "adapt-to-character"},
        # Landed an octave under the character: correct upward, but only so far.
        {"sourceMedianPitchHz": 109.4, "targetMedianPitchHz": 160.0, "outputMedianPitchHz": 80.0},
    )
    assert shift == vc.MAX_RESIDUAL_SEMITONES, f"expected clamp, got {shift}"
    assert any("clamped" in w for w in warnings)


def test_preserve_performer_never_shifts():
    import torch

    wav = torch.zeros(1, 2400)
    _out, policy, shift, warnings = vc.apply_register_policy(
        torch, wav, 24000, {"registerPolicy": "preserve-performer"},
        {"sourceMedianPitchHz": 109.4, "targetMedianPitchHz": 80.1, "outputMedianPitchHz": 105.0},
    )
    assert policy == "preserve-performer" and shift == 0.0 and warnings == []


def main():
    loaded = vc.load_approved_model(FakeModelClass, "approved/snapshot", "cpu")
    assert loaded == "approved-model"
    assert FakeModelClass.called == ("approved/snapshot", "cpu")
    with tempfile.TemporaryDirectory() as work:
        test_low_reference_is_lifted_into_range(work)
        test_in_range_reference_is_used_untouched(work)
        test_sparse_short_line_is_bounded_for_conversion_and_restored(work)
        test_dense_line_is_not_needlessly_rewritten(work)
    test_register_correction_measures_the_conversion_not_the_source()
    test_register_correction_is_clamped_and_directional()
    test_preserve_performer_never_shifts()
    print("ok: conditioning floor and register correction hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
