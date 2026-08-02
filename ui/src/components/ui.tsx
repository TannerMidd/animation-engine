import type { ReactNode, CSSProperties } from 'react';

/** Small shared primitives. Hand-rolled — the app needs six of them, not a library. */

export function Button({
  children, onClick, disabled, variant = 'default', title, className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  title?: string;
  className?: string;
}) {
  const styles = {
    default: 'bg-panel-2 hover:bg-edge border-edge text-ink',
    primary: 'bg-accent hover:bg-accent-dim border-accent text-stage font-medium',
    ghost: 'bg-transparent hover:bg-panel-2 border-transparent text-ink-dim hover:text-ink',
    danger: 'bg-transparent hover:bg-bad/20 border-transparent text-bad',
  }[variant];

  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`px-2.5 py-1 rounded border text-[12px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function Select({
  value, options, onChange, className = '',
}: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`bg-panel-2 border border-edge rounded px-1.5 py-1 text-[12px] text-ink outline-none focus:border-accent ${className}`}
    >
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}

export function NumberInput({
  value, onChange, min, max, step = 1, className = '',
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
      className={`bg-panel-2 border border-edge rounded px-1.5 py-1 text-[12px] text-ink outline-none focus:border-accent w-full ${className}`}
    />
  );
}

export function TextInput({
  value, onChange, placeholder, className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`bg-panel-2 border border-edge rounded px-1.5 py-1 text-[12px] text-ink outline-none focus:border-accent w-full ${className}`}
    />
  );
}

export function Slider({
  value, onChange, min, max, step = 0.01, label, format,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  label: string;
  format?: (v: number) => string;
}) {
  return (
    <label className="block mb-2">
      <div className="flex items-baseline justify-between text-[11px] mb-0.5">
        <span className="uppercase tracking-wide text-ink-faint">{label}</span>
        <span className="tabular-nums text-ink-dim">{format ? format(value) : value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-accent h-1 cursor-pointer"
      />
    </label>
  );
}

/**
 * A row of colours.
 *
 * Colour is the one thing a dropdown of hex codes cannot convey, and the choice
 * is always "which of these looks right next to the others" rather than "which
 * hex value do I want".
 */
export function Swatches({
  value, options, onChange, label,
}: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <div className="mb-2.5">
      <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            onClick={() => onChange(c)}
            style={{ background: c }}
            className={`w-5 h-5 rounded border transition-transform ${
              value.toLowerCase() === c.toLowerCase()
                ? 'border-accent scale-110 ring-1 ring-accent'
                : 'border-edge hover:scale-110'
            }`}
          />
        ))}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block mb-2.5">
      <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">{label}</div>
      {children}
      {hint && <div className="text-[11px] text-ink-faint mt-1">{hint}</div>}
    </label>
  );
}

export function Panel({ title, children, actions, className = '', bodyClass = '' }: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <div className={`flex flex-col min-h-0 bg-panel border border-edge rounded-md ${className}`}>
      {title && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-edge shrink-0">
          <span className="text-[11px] uppercase tracking-wider text-ink-faint">{title}</span>
          <div className="flex gap-1 items-center">{actions}</div>
        </div>
      )}
      <div className={`flex-1 min-h-0 overflow-auto ${bodyClass}`}>{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="h-full grid place-items-center text-ink-faint text-[12px] p-6 text-center">{children}</div>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'bad' | 'warn' }) {
  const styles = {
    neutral: 'bg-panel-2 text-ink-dim',
    good: 'bg-good/20 text-good',
    bad: 'bg-bad/20 text-bad',
    warn: 'bg-accent/20 text-accent',
  }[tone];
  return <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${styles}`}>{children}</span>;
}

export function Spinner({ style }: { style?: CSSProperties }) {
  return (
    <span
      style={style}
      className="inline-block w-3 h-3 border-2 border-ink-faint border-t-accent rounded-full animate-spin"
    />
  );
}
