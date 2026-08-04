import type {
  Num, Palette, ParamSpec, ParamValue, Primitive, PropDocument,
} from '../types.ts';
import { Button, Field, NumberInput, Select, Slider, TextInput } from './ui.tsx';

/**
 * The right-hand column: what the selected shape is, and what the prop's own
 * controls are.
 *
 * Every numeric field here accepts either a number or an expression over the
 * prop's params. The distinction is deliberately visible — a bound field shows
 * its expression as text — because "this moves when Width moves" is the single
 * most important thing to be able to see about a parametric prop, and a control
 * that quietly hid it would make the prop's behaviour a surprise.
 */

const SLOT_GROUPS: Array<[string, string[]]> = [
  ['Room', ['wall', 'wallLower', 'wallTrim', 'ceiling', 'ceilingTrim', 'floor', 'floorDark']],
  ['Light', ['light', 'lightGlow', 'accent', 'accentGlow', 'screen', 'glass']],
  ['Material', ['wood', 'woodDark', 'metal', 'metalDark', 'fabric', 'fabricDark', 'clay']],
  ['Surface', ['surface', 'surfaceDark', 'surfaceTrim', 'foliage', 'foliageDark', 'line']],
];

/** Which numeric fields a primitive has, so the inspector never guesses. */
function fieldsOf(prim: Primitive): Array<{ key: string; label: string }> {
  switch (prim.k) {
    case 'rect': return [
      { key: 'x', label: 'X' }, { key: 'y', label: 'Y' },
      { key: 'w', label: 'Width' }, { key: 'h', label: 'Height' },
      { key: 'rx', label: 'Corner' },
    ];
    case 'ellipse': return [
      { key: 'cx', label: 'Centre X' }, { key: 'cy', label: 'Centre Y' },
      { key: 'rx', label: 'Radius X' }, { key: 'ry', label: 'Radius Y' },
    ];
    case 'line': return [
      { key: 'x1', label: 'From X' }, { key: 'y1', label: 'From Y' },
      { key: 'x2', label: 'To X' }, { key: 'y2', label: 'To Y' },
    ];
    case 'text': return [
      { key: 'x', label: 'X' }, { key: 'y', label: 'Y' }, { key: 'size', label: 'Size' },
    ];
    case 'repeat': return [
      { key: 'n', label: 'Count' }, { key: 'dx', label: 'Step X' }, { key: 'dy', label: 'Step Y' },
    ];
    default: return [];
  }
}

export function PrimitiveInspector({
  primitive, params, palette, onChange, onDelete, onRaise, onLower,
}: {
  primitive: Primitive;
  params: ParamSpec[];
  palette: Palette;
  onChange: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
  onRaise: () => void;
  onLower: () => void;
}) {
  const bindable = params.filter((p) => p.type === 'number' || p.type === 'boolean').map((p) => p.key);
  const booleans = params.filter((p) => p.type === 'boolean').map((p) => p.key);
  const texts = params.filter((p) => p.type === 'text');
  const visual = primitive.k !== 'repeat';

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2.5">
        <span className="text-[11px] uppercase tracking-wider text-ink-faint flex-1">{primitive.k}</span>
        <Button variant="ghost" onClick={onLower} title="Send backwards">↓</Button>
        <Button variant="ghost" onClick={onRaise} title="Bring forwards">↑</Button>
        <Button variant="danger" onClick={onDelete} title="Delete this shape">Delete</Button>
      </div>

      {visual && (
        <SlotPicker
          label="Fill"
          value={(primitive as { f?: string | null }).f ?? null}
          palette={palette}
          allowNone
          onChange={(f) => onChange({ f })}
        />
      )}

      {fieldsOf(primitive).map(({ key, label }) => (
        <NumField
          key={key}
          label={label}
          value={(primitive as unknown as Record<string, Num | undefined>)[key]}
          bindable={bindable}
          onChange={(v) => onChange({ [key]: v })}
        />
      ))}

      {primitive.k === 'poly' && (
        <Field label={`Points (${primitive.p.length / 2})`}>
          <TextInput
            value={primitive.p.join(', ')}
            onChange={(v) => {
              const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
              if (parts.length >= 4 && parts.length % 2 === 0) {
                onChange({ p: parts.map((s) => (Number.isFinite(Number(s)) ? Number(s) : s)) });
              }
            }}
          />
        </Field>
      )}

      {primitive.k === 'text' && (
        <>
          <Field label="Text" hint={texts.length ? `Use $${texts[0]!.key} to show the ${texts[0]!.label} param` : undefined}>
            <TextInput value={primitive.value} onChange={(value) => onChange({ value })} />
          </Field>
          <Field label="Align">
            <Select
              value={primitive.anchor ?? 'middle'}
              options={['start', 'middle', 'end']}
              onChange={(anchor) => onChange({ anchor })}
            />
          </Field>
        </>
      )}

      {visual && (
        <div className="border-t border-edge mt-3 pt-2.5">
          <Toggle
            label="Outline"
            checked={(primitive as { l?: 0 | 1 }).l !== 0}
            onChange={(on) => onChange({ l: on ? 1 : 0 })}
          />
          <Toggle
            label="Draw crisply"
            hint="No wobble. For circles and anything mechanical."
            checked={(primitive as { sm?: 0 | 1 }).sm === 1}
            onChange={(on) => onChange({ sm: on ? 1 : 0 })}
          />
          <Toggle
            label="Reaches the frame edge"
            hint="Square and fill-only, so no seam opens at the boundary."
            checked={(primitive as { e?: 0 | 1 }).e === 1}
            onChange={(on) => onChange({ e: on ? 1 : 0 })}
          />
          {primitive.k === 'poly' && (
            <Toggle
              label="Closed"
              checked={primitive.c !== 0}
              onChange={(on) => onChange({ c: on ? 1 : 0 })}
            />
          )}
          <NumField
            label="Opacity"
            value={(primitive as { o?: Num }).o}
            bindable={bindable}
            onChange={(o) => onChange({ o })}
          />
          <NumField
            label="Line width"
            value={(primitive as { sw?: Num }).sw}
            bindable={bindable}
            onChange={(sw) => onChange({ sw })}
          />
          <NumField
            label="Rotation"
            value={(primitive as { rot?: Num }).rot}
            bindable={bindable}
            onChange={(rot) => onChange({ rot })}
          />
        </div>
      )}

      <div className="border-t border-edge mt-3 pt-2.5">
        <Field label="Only show when" hint="Leave blank to always show it.">
          <Select
            value={primitive.show ?? ''}
            options={[
              { value: '', label: 'always' },
              ...booleans.flatMap((k) => [
                { value: k, label: `${k} is on` },
                { value: `!${k}`, label: `${k} is off` },
              ]),
            ]}
            onChange={(show) => onChange({ show: show || undefined })}
          />
        </Field>
        {!booleans.length && (
          <div className="text-[11px] text-ink-faint -mt-1.5">
            Add a switch parameter to make a shape optional.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A number, or arithmetic over the params.
 *
 * The chain toggles between the two: a literal you can type, or an expression
 * the prop evaluates. Picking a param from the menu writes the expression for
 * you, which is the whole point — nobody should have to learn a syntax to make
 * a shelf follow its cabinet.
 */
function NumField({
  label, value, bindable, onChange,
}: {
  label: string;
  value: Num | undefined;
  bindable: string[];
  onChange: (v: Num | undefined) => void;
}) {
  const bound = typeof value === 'string';

  return (
    <div className="mb-2.5">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</span>
        {bindable.length > 0 && (
          <button
            type="button"
            title={bound ? 'Back to a fixed number' : 'Drive this from a parameter'}
            onClick={() => onChange(bound ? 0 : `${bindable[0]} / 2`)}
            className={`text-[11px] px-1 rounded cursor-pointer ${bound ? 'text-accent' : 'text-ink-ghost hover:text-ink-dim'}`}
          >
            ⛓
          </button>
        )}
      </div>
      {bound ? (
        <>
          <TextInput value={String(value)} onChange={(v) => onChange(v)} />
          <div className="flex flex-wrap gap-1 mt-1">
            {bindable.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => onChange(`${String(value)} ${String(value).trim() ? '' : ''}${k}`.trim())}
                className="text-[10px] px-1 rounded border border-edge text-ink-faint hover:text-ink cursor-pointer"
              >
                {k}
              </button>
            ))}
          </div>
        </>
      ) : (
        <NumberInput
          value={typeof value === 'number' ? value : 0}
          onChange={(v) => onChange(v)}
        />
      )}
    </div>
  );
}

function Toggle({ label, checked, onChange, hint }: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="block mb-2 cursor-pointer">
      <span className="flex items-center gap-2 text-[12px] text-ink-dim">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </span>
      {hint && <span className="block text-[11px] text-ink-faint ml-5">{hint}</span>}
    </label>
  );
}

/** Slots, shown as the colours they currently mean rather than as their names. */
export function SlotPicker({
  label, value, palette, onChange, allowNone,
}: {
  label: string;
  value: string | null;
  palette: Palette;
  onChange: (slot: string | null) => void;
  allowNone?: boolean;
}) {
  return (
    <div className="mb-2.5">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</span>
        <span className="text-[11px] text-ink-dim font-mono">{value ?? 'none'}</span>
      </div>
      {allowNone && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className={`text-[10px] px-1.5 py-0.5 mb-1 rounded border cursor-pointer ${
            value === null ? 'border-accent text-accent' : 'border-edge text-ink-faint hover:text-ink'
          }`}
        >
          no fill
        </button>
      )}
      {SLOT_GROUPS.map(([group, slots]) => (
        <div key={group} className="mb-1">
          <div className="text-[10px] text-ink-ghost mb-0.5">{group}</div>
          <div className="flex flex-wrap gap-1">
            {slots.filter((s) => palette[s]).map((slot) => (
              <button
                key={slot}
                type="button"
                title={slot}
                onClick={() => onChange(slot)}
                style={{ background: palette[slot] }}
                className={`w-5 h-5 rounded border transition-transform ${
                  value === slot ? 'border-accent scale-110 ring-1 ring-accent' : 'border-edge hover:scale-110'
                }`}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The prop's own controls, rendered from its ParamSpec — the same declaration
 * the set designer builds its inspector from. Numbers get a slider here because
 * the question being asked is "how does this look as it moves", not "what
 * number do I want".
 */
export function ParamControl({ spec, value, onChange }: {
  spec: ParamSpec;
  value: ParamValue;
  onChange: (v: ParamValue) => void;
}) {
  if (spec.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 mb-3 text-[12px] text-ink-dim cursor-pointer">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        {spec.label}
      </label>
    );
  }
  if (spec.type === 'choice') {
    return (
      <Field label={spec.label}>
        <Select value={String(value)} options={spec.choices ?? []} onChange={onChange} />
      </Field>
    );
  }
  if (spec.type === 'text') {
    return (
      <Field label={spec.label}>
        <TextInput value={String(value)} onChange={onChange} />
      </Field>
    );
  }
  if (spec.min !== undefined && spec.max !== undefined) {
    return (
      <Slider
        label={spec.label}
        value={Number(value)}
        min={spec.min}
        max={spec.max}
        step={spec.step ?? 1}
        onChange={onChange}
        format={(v) => String(Math.round(v * 100) / 100)}
      />
    );
  }
  return (
    <Field label={spec.label}>
      <NumberInput value={Number(value)} step={spec.step ?? 1} onChange={onChange} />
    </Field>
  );
}

/** Add, edit and remove the prop's parameters. */
export function ParamEditor({ doc, onChange }: {
  doc: PropDocument;
  onChange: (params: ParamSpec[], renames: Record<string, string>) => void;
}) {
  const set = (index: number, patch: Partial<ParamSpec>) => {
    const next = doc.params.map((p, i) => (i === index ? { ...p, ...patch } : p));
    const before = doc.params[index]!;
    const renames = patch.key && patch.key !== before.key ? { [before.key]: patch.key } : {};
    onChange(next, renames);
  };

  return (
    <div>
      {doc.params.map((spec, i) => (
        <div key={i} className="border border-edge rounded p-2 mb-2">
          <div className="flex gap-1.5 mb-1.5">
            <TextInput value={spec.label} onChange={(label) => set(i, { label })} />
            <Button variant="danger" onClick={() => onChange(doc.params.filter((_, n) => n !== i), {})}>×</Button>
          </div>
          <div className="flex gap-1.5 items-center mb-1.5">
            <input
              type="text"
              value={spec.key}
              onChange={(e) => set(i, { key: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })}
              className="bg-panel-2 border border-edge rounded px-1.5 py-1 text-[11px] font-mono text-ink outline-none focus:border-accent w-full"
              title="The name expressions use for this parameter"
            />
            <Select
              value={spec.type}
              options={[
                { value: 'number', label: 'number' },
                { value: 'boolean', label: 'switch' },
                { value: 'text', label: 'text' },
              ]}
              onChange={(type) => set(i, {
                type: type as ParamSpec['type'],
                default: type === 'number' ? 100 : type === 'boolean' ? true : 'TEXT',
                ...(type === 'number' ? { min: 0, max: 400, step: 1 } : { min: undefined, max: undefined }),
              })}
            />
          </div>
          {spec.type === 'number' && (
            <div className="flex gap-1.5">
              <NumberInput value={Number(spec.default)} onChange={(v) => set(i, { default: v })} />
              <NumberInput value={spec.min ?? 0} onChange={(v) => set(i, { min: v })} />
              <NumberInput value={spec.max ?? 400} onChange={(v) => set(i, { max: v })} />
            </div>
          )}
          {spec.type === 'text' && (
            <TextInput value={String(spec.default)} onChange={(v) => set(i, { default: v })} />
          )}
          {spec.type === 'boolean' && (
            <label className="flex items-center gap-2 text-[11px] text-ink-dim cursor-pointer">
              <input type="checkbox" checked={Boolean(spec.default)} onChange={(e) => set(i, { default: e.target.checked })} />
              on by default
            </label>
          )}
        </div>
      ))}
      <Button
        onClick={() => onChange([...doc.params, {
          key: `size${doc.params.length || ''}`,
          label: 'Size',
          type: 'number',
          default: 100,
          min: 10,
          max: 400,
          step: 1,
        }], {})}
      >
        + Add a control
      </Button>
    </div>
  );
}
