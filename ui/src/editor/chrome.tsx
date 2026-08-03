import type { CSSProperties, ReactNode } from 'react';

/**
 * Small chrome primitives shared across the editor.
 *
 * Control heights come from the design system: 24 px primary row, 22–23 px
 * dense rows, 19–20 px toolbar chips, 3 px radius throughout.
 */

export function UcLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`text-[10px] tracking-[.09em] uppercase text-ink-faint ${className}`}>{children}</span>
  );
}

export function Mono({ children, className = '', title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`font-mono text-[10px] ${className}`}>{children}</span>
  );
}

/** Status tag: bordered word chip. Colour never travels without the word. */
export function Tag({
  children, color, title, className = '',
}: {
  children: ReactNode; color: string; title?: string; className?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 text-[9px] tracking-[.06em] uppercase rounded-[2px] px-[5px] py-px border leading-[13px] ${className}`}
      style={{ color, borderColor: color }}
    >
      {children}
    </span>
  );
}

export function Dot({ color, className = '', title, pulse }: { color: string; className?: string; title?: string; pulse?: boolean }) {
  return (
    <span
      title={title}
      className={`inline-block w-[6px] h-[6px] rounded-full shrink-0 ${className}`}
      style={{ background: color, animation: pulse ? 'recpulse 1.1s infinite' : undefined }}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[9px] text-ink-faint border border-edge rounded-[2px] px-1 py-px">{children}</span>
  );
}

/** Standard button: default / primary / toggled-on / danger-ish via props. */
export function Btn({
  children, onClick, title, primary, on, danger, disabled, className = '', style,
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  primary?: boolean;
  /** Accent-tinted "toggle is on" treatment. */
  on?: boolean;
  danger?: boolean;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const tone = primary
    ? 'bg-accent border-accent text-stage font-semibold hover:bg-[#d9955c] hover:border-[#d9955c]'
    : danger
      ? 'bg-bad/15 border-bad/50 text-bad hover:bg-bad/25'
      : on
        ? 'bg-accent/15 border-accent/50 text-accent'
        : 'bg-panel-2 border-edge text-ink-dim hover:text-ink hover:bg-edge';
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={style}
      className={`h-[23px] px-2 rounded-[3px] border text-[11px] inline-flex items-center gap-[5px] whitespace-nowrap cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${tone} ${className}`}
    >
      {children}
    </button>
  );
}

/** Option chip row used by inspector fields (selected option is accent-solid). */
export function OptionChips({
  options, value, onPick, disabled, invalid,
}: {
  options: string[];
  value: string | null;
  onPick: (option: string) => void;
  disabled?: boolean;
  /** Options that are currently not valid targets (shown red, still labelled). */
  invalid?: Record<string, string>;
}) {
  return (
    <span className="flex gap-[3px] flex-wrap">
      {options.map((option) => {
        const selected = option === value;
        const bad = invalid?.[option];
        return (
          <button
            key={option}
            type="button"
            disabled={disabled}
            title={bad ?? option}
            onClick={() => onPick(option)}
            className={`h-[23px] px-[9px] rounded-[3px] border text-[10.5px] cursor-pointer disabled:opacity-40 ${
              selected
                ? 'bg-accent border-accent text-stage'
                : bad
                  ? 'bg-bad/15 border-bad/40 text-bad'
                  : 'bg-panel-2 border-edge text-ink-dim hover:text-ink'
            }`}
          >
            {option}
          </button>
        );
      })}
    </span>
  );
}

export function FieldLabel({ label, value, hint }: { label: string; value?: string | null; hint?: string }) {
  return (
    <span className="flex items-baseline justify-between mb-1">
      <span className="text-[9.5px] tracking-[.09em] uppercase text-ink-faint">{label}</span>
      {value ? <Mono className="text-ink-dim">{value}</Mono> : null}
      {hint && !value ? <span className="text-[10px] text-ink-ghost">{hint}</span> : null}
    </span>
  );
}

export function Spinner({ size = 9 }: { size?: number }) {
  return (
    <span
      className="inline-block rounded-full border-2 border-edge border-t-accent"
      style={{ width: size, height: size, animation: 'spin 1s linear infinite' }}
    />
  );
}

/** Section header row inside panes (uppercase label + rule). */
export function SectionRule({ label, right }: { label: string; right?: ReactNode }) {
  return (
    <div className="px-2 pt-1 pb-[5px] flex items-center gap-1.5">
      <span className="text-[9px] tracking-[.11em] uppercase text-ink-faint">{label}</span>
      <div className="flex-1 h-px bg-[#2f353d]" />
      {right}
    </div>
  );
}
