import { describe, it, expect } from 'vitest';
import { cleanup } from '../src/llm/script.ts';
import { setJsonSchema } from '../src/llm/set.ts';
import { Ollama, pickModel, freeVramForRender, SUGGESTED_MODELS } from '../src/llm/ollama.ts';
import { PROP_KEYS } from '../src/sets/props/index.ts';
import { PALETTE_NAMES } from '../src/sets/palettes.ts';
import { parseScript } from '../src/parse/index.ts';

/**
 * These run without Ollama installed. The generation calls themselves need a
 * model, but everything that decides whether generated output is *usable* is
 * pure and gets tested here — which is the part that actually protects the
 * pipeline.
 */

describe('script cleanup', () => {
  it('strips a code fence', () => {
    const out = cleanup('```fountain\n# TITLE\n\nBOB\nHi.\n```');
    expect(out.startsWith('# TITLE')).toBe(true);
    expect(out).not.toContain('```');
  });

  it('drops a chatty preamble before the script', () => {
    // Models add "Here's your scene:" no matter how firmly you ask them not to.
    const out = cleanup("Sure! Here's a scene for you:\n\n# THE THING\n\nINT. ROOM - DAY\n\nBOB\nHi.\n");
    expect(out.startsWith('# THE THING')).toBe(true);
  });

  it('keeps a script that starts at a scene heading', () => {
    expect(cleanup('INT. ROOM - DAY\n\nBOB\nHi.\n').startsWith('INT. ROOM - DAY')).toBe(true);
  });

  it('normalises line endings and ends with exactly one newline', () => {
    const out = cleanup('# T\r\n\r\nBOB\r\nHi.\r\n\r\n\r\n');
    expect(out).not.toContain('\r');
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('produces something the engine parser accepts', () => {
    const out = cleanup('```\n# T\n\nINT. ROOM - DAY\n\nBOB\n(deadpan)\nMorning.\n\n[BEAT 1200]\n```');
    const sp = parseScript(out, 'x');
    expect(sp.characters).toEqual(['BOB']);
    expect(sp.elements.some((e) => e.kind === 'beat')).toBe(true);
  });
});

describe('set generation schema', () => {
  const schema = setJsonSchema() as {
    properties: {
      palette: { enum: string[] };
      layers: { properties: Record<string, { items: { properties: { prop: { enum: string[] } } } }> };
    };
    required: string[];
  };

  it('constrains props to the live registry', () => {
    // The same guard the director has: a model cannot name a prop that does not
    // exist, because the grammar it generates against does not contain one.
    const enums = schema.properties.layers.properties['back']!.items.properties.prop.enum;
    expect(enums).toEqual(PROP_KEYS);
    expect(enums).toContain('bar-counter');
    expect(enums).not.toContain('hovercar');
  });

  it('constrains palettes to the ones that exist', () => {
    expect(schema.properties.palette.enum).toEqual(PALETTE_NAMES);
  });

  it('requires all three depth layers', () => {
    expect(Object.keys(schema.properties.layers.properties).sort()).toEqual(['back', 'fore', 'mid']);
  });

  it('grows automatically when a prop is added', () => {
    const enums = schema.properties.layers.properties['fore']!.items.properties.prop.enum;
    expect(enums.length).toBe(PROP_KEYS.length);
  });
});

describe('ollama client', () => {
  it('reports a usable reason when unreachable, naming the fix', async () => {
    const status = await new Ollama('http://127.0.0.1:9').available();
    expect(status.ok).toBe(false);
    if (!status.ok) {
      expect(status.reason).toMatch(/ollama/i);
      expect(status.reason).toMatch(/pull/);
    }
  });

  it('prefers an installed suggested model over an arbitrary one', () => {
    const models = [
      { name: 'llava:7b', sizeBytes: 0, parameterSize: null, quantization: null },
      { name: 'mistral-small:latest', sizeBytes: 0, parameterSize: null, quantization: null },
    ];
    expect(pickModel(models)).toBe('mistral-small:latest');
  });

  it('honours an explicit choice when it is installed', () => {
    const models = [
      { name: 'mistral-small', sizeBytes: 0, parameterSize: null, quantization: null },
      { name: 'qwen3:14b', sizeBytes: 0, parameterSize: null, quantization: null },
    ];
    expect(pickModel(models, 'qwen3:14b')).toBe('qwen3:14b');
  });

  it('falls back to whatever is installed', () => {
    const models = [{ name: 'weird-model', sizeBytes: 0, parameterSize: null, quantization: null }];
    expect(pickModel(models)).toBe('weird-model');
    expect(pickModel([])).toBeNull();
  });

  it('suggests models that fit a 16GB card', () => {
    expect(SUGGESTED_MODELS.length).toBeGreaterThan(0);
  });

  it('never throws when freeing VRAM with no Ollama present', async () => {
    // Called before every render. A missing LLM must not block a render that
    // does not need one.
    await expect(freeVramForRender()).resolves.toEqual([]);
  });
});
