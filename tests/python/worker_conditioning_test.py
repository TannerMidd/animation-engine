"""
Conditioning-bleed regression test for the Chatterbox worker.

Drives render_items with a fake model and asserts the invariant the real
ChatterboxTTS violates by default: an item without a reference must synthesize
with the model's *default* conditionals, never with whatever the previous item
left resident. Run with the project venv:

    .venv/Scripts/python tests/python/worker_conditioning_test.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src", "voice", "engines"))
import chatterbox_worker  # noqa: E402


class FakeTensor:
    def detach(self):
        return self

    def cpu(self):
        return self

    def flatten(self):
        return self

    def clamp(self, lo, hi):
        return self

    def abs(self):
        return self

    def max(self):
        return 0.5  # under the normalization ceiling: hot-take scaling stays off

    def __mul__(self, other):
        return self

    def short(self):
        return self

    def __len__(self):
        return 240

    def numpy(self):
        raise RuntimeError("force the struct fallback")

    def tolist(self):
        return [0] * 240


class FakeTorch:
    @staticmethod
    def manual_seed(_):
        pass


class FakeModel:
    """Mimics ChatterboxTTS's conditioning behaviour, including the leak."""

    def __init__(self):
        self.conds = "DEFAULT"
        self.sr = 24000
        self.used = []

    def prepare_conditionals(self, ref, exaggeration=0.5):
        # The real model replaces self.conds with the reference's conditionals
        # and leaves them resident — which is exactly the leak.
        self.conds = f"REF:{ref}"

    def generate(self, text, exaggeration=0.5, cfg_weight=0.5,
                 temperature=0.8, repetition_penalty=1.2, min_p=0.05, top_p=1.0):
        self.used.append(self.conds)
        return FakeTensor()


def main() -> int:
    model = FakeModel()
    with tempfile.TemporaryDirectory() as tmp:
        items = [
            {"id": "a", "out": os.path.join(tmp, "a.wav"), "text": "hi", "ref": os.path.join(tmp, "brent.ref.wav"), "seed": 1},
            {"id": "b", "out": os.path.join(tmp, "b.wav"), "text": "hi", "ref": None, "seed": 2},
            {"id": "c", "out": os.path.join(tmp, "c.wav"), "text": "hi", "ref": os.path.join(tmp, "carl.ref.wav"), "seed": 3},
            {"id": "d", "out": os.path.join(tmp, "d.wav"), "text": "hi", "ref": None, "seed": 4},
        ]
        rendered = chatterbox_worker.render_items(model, FakeTorch, items)

    assert rendered == 4, f"expected 4 rendered, got {rendered}"
    expected = ["REF:" + items[0]["ref"], "DEFAULT", "REF:" + items[2]["ref"], "DEFAULT"]
    assert model.used == expected, (
        "conditioning bled between speakers:\n"
        f"  used:     {model.used}\n"
        f"  expected: {expected}"
    )
    print("ok: no conditioning bleed across 4 mixed items")
    return 0


if __name__ == "__main__":
    sys.exit(main())
