"""Non-hermetic smoke test for the deliberately overlaid local ML runtime."""
import importlib.metadata as metadata


def main() -> int:
    import torch
    import torchaudio
    import whisper
    from chatterbox.tts import ChatterboxTTS
    from chatterbox.vc import ChatterboxVC
    from kokoro import KModel, KPipeline

    expected = {
        "chatterbox-tts": "0.1.7",
        "torch": "2.11.0+cu128",
        "torchaudio": "2.11.0+cu128",
    }
    actual = {name: metadata.version(name) for name in expected}
    assert actual == expected, f"runtime does not match the project locks: {actual}"
    assert torch.__version__ == expected["torch"]
    assert torchaudio.__version__ == expected["torchaudio"]
    assert all((whisper, ChatterboxTTS, ChatterboxVC, KModel, KPipeline))
    print(f"runtime_environment_test: ok ({actual})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
