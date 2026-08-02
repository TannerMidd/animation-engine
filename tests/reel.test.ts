import { describe, it, expect } from 'vitest';
import { stackArgs } from '../src/render/encode.ts';

const argv = stackArgs('top.mp4', 'bottom.mp4', 'reel.mp4');
const graph = argv[argv.indexOf('-filter_complex') + 1]!;
const maps = argv.flatMap((a, i) => (a === '-map' ? [argv[i + 1]!] : []));

const labelsIn = (s: string) => [...s.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!);

describe('the identity reel stack', () => {
  it('consumes every filter output it creates', () => {
    // Regression: the graph once grew an audio concat whose [audio_discard]
    // output nothing read. ffmpeg rejects the entire graph over one dangling
    // label ("Filter concat has an unconnected output"), so the reel died at
    // the very last step, after both halves had already rendered.
    const produced: string[] = [];
    const consumed = maps.filter((m) => m.startsWith('[')).map((m) => m.slice(1, -1));
    for (const chain of graph.split(';')) {
      consumed.push(...labelsIn(chain.match(/^(?:\[[^\]]+\])+/)?.[0] ?? ''));
      produced.push(...labelsIn(chain.match(/(?:\[[^\]]+\])+$/)?.[0] ?? ''));
    }
    for (const label of produced) expect(consumed).toContain(label);
    // The mirror image: a consumed label no chain produced. Bare N:v / N:a
    // stream refs come from the -i inputs, not the graph, so they are exempt.
    for (const label of consumed) {
      if (!/^\d+:/.test(label)) expect(produced).toContain(label);
    }
  });

  it('maps the stacked video and exactly one audio stream', () => {
    expect(maps).toEqual(['[v]', '0:a']);
    expect(graph).toContain('vstack=inputs=2');
    expect(argv[argv.length - 1]).toBe('reel.mp4');
  });
});
