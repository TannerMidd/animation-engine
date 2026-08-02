import type { Beat } from '../types.ts';

/**
 * The scene as a strip of beats, width proportional to duration.
 *
 * Reading a shot list as JSON tells you what happens; seeing it as a strip
 * tells you about *rhythm* — three long lines in a row, or a pause that is
 * dwarfed by everything around it. That is the thing you are actually editing.
 */

const SPEAKER_COLOURS = ['#c8834a', '#6f9b5a', '#7a8fc0', '#b06a8f', '#a89050'];

export function speakerColour(cast: string[], speaker: string): string {
  const i = cast.indexOf(speaker);
  return SPEAKER_COLOURS[i < 0 ? 0 : i % SPEAKER_COLOURS.length]!;
}

export function BeatTimeline({
  beats, beatStarts, durationMs, selected, onSelect, playheadMs, cast,
}: {
  beats: Beat[];
  beatStarts: number[];
  durationMs: number;
  selected: number | null;
  onSelect: (index: number) => void;
  playheadMs: number;
  cast: string[];
}) {
  if (!beats.length) {
    return <div className="h-full grid place-items-center text-ink-faint text-[12px]">no beats yet</div>;
  }

  const total = Math.max(1, durationMs);
  const width = (i: number) => {
    const start = beatStarts[i] ?? 0;
    const end = i + 1 < beatStarts.length ? beatStarts[i + 1]! : durationMs;
    return Math.max(0.4, ((end - start) / total) * 100);
  };

  return (
    <div className="relative h-full flex flex-col">
      <div className="relative flex-1 flex items-stretch gap-px px-1 py-1 min-h-0">
        {beats.map((beat, i) => {
          const isSel = selected === i;
          const colour =
            beat.kind === 'line' ? speakerColour(cast, beat.speaker)
            : beat.kind === 'pause' ? '#4a525c'
            : '#5f6772';

          const label =
            beat.kind === 'line' ? beat.text
            : beat.kind === 'pause' ? `${beat.ms}ms`
            : beat.text;

          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelect(i)}
              title={`${i}  ${beat.kind}  ${beat.shot}\n${label}`}
              style={{ width: `${width(i)}%`, backgroundColor: colour, opacity: isSel ? 1 : 0.62 }}
              className={`relative rounded-sm overflow-hidden text-left px-1 min-w-[3px] transition-opacity hover:opacity-90 ${
                isSel ? 'ring-2 ring-ink' : ''
              }`}
            >
              <span className="block text-[10px] leading-tight text-stage/90 font-medium truncate">
                {beat.kind === 'pause' ? '⏸' : beat.kind === 'action' ? '❖' : beat.speaker}
              </span>
              <span className="block text-[10px] leading-tight text-stage/70 truncate">{beat.shot}</span>
            </button>
          );
        })}

        <div
          className="absolute top-0 bottom-0 w-0.5 bg-ink pointer-events-none z-10"
          style={{ left: `calc(${Math.min(100, (playheadMs / total) * 100)}% )` }}
        />
      </div>
    </div>
  );
}
