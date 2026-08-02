import { type PropDef, num, str, rect, line, poly, ceilingLocalY, stroke, r } from './types.ts';

/**
 * Architecture: the shells that define a space, plus the openings in them.
 *
 * The room shells are `spanning` — they cover the whole set including its
 * margin and ignore x. Everything else stands on the floor like a normal prop.
 */

export const STRUCTURE_PROPS: Record<string, PropDef> = {
  'room-wall': {
    label: 'Wall',
    tags: ['structure', 'interior'],
    spanning: true,
    params: [
      { key: 'bandHeight', label: 'Lower band height', type: 'number', default: 150, min: 0, max: 400, step: 10 },
      { key: 'railWidth', label: 'Rail thickness', type: 'number', default: 6, min: 0, max: 20, step: 1 },
    ],
    render(ctx) {
      const { palette: p, geo } = ctx;
      const band = num(ctx, 'bandHeight', 150);
      const rail = num(ctx, 'railWidth', 6);
      const bottom = geo.y0 + geo.height;

      // Full-bleed base first, so any gap between shells reads as wall rather
      // than as a hole in the world.
      let out = rect(p, geo.x0, geo.y0, geo.width, geo.height, p.wall, { outline: false });
      out += rect(p, geo.x0, geo.ceilingY, geo.width, geo.horizonY - geo.ceilingY, p.wall, { outline: false });

      if (band > 0) {
        out += rect(p, geo.x0, geo.horizonY - band, geo.width, band, p.wallLower, { outline: false });
        out += line(p, geo.x0, geo.horizonY - band, geo.x0 + geo.width, geo.horizonY - band, p.wallTrim, rail);
      }
      void bottom;
      return out;
    },
  },

  'room-ceiling': {
    label: 'Ceiling',
    tags: ['structure', 'interior'],
    spanning: true,
    params: [
      { key: 'gridOffset', label: 'Grid line offset', type: 'number', default: 58, min: 0, max: 200, step: 2 },
    ],
    render(ctx) {
      const { palette: p, geo } = ctx;
      const grid = num(ctx, 'gridOffset', 58);
      let out = rect(p, geo.x0, geo.y0, geo.width, geo.ceilingY - geo.y0, p.ceiling, { outline: false });
      out += line(p, geo.x0, geo.ceilingY, geo.x0 + geo.width, geo.ceilingY, p.line, 4);
      if (grid > 0) {
        out += line(p, geo.x0, geo.ceilingY - grid, geo.x0 + geo.width, geo.ceilingY - grid, p.ceilingTrim, 3);
      }
      return out;
    },
  },

  'room-floor': {
    label: 'Floor',
    tags: ['structure', 'interior', 'exterior'],
    spanning: true,
    params: [
      { key: 'bandOffset', label: 'Near-band offset', type: 'number', default: 96, min: 0, max: 400, step: 8 },
    ],
    render(ctx) {
      const { palette: p, geo } = ctx;
      const band = num(ctx, 'bandOffset', 96);
      const bottom = geo.y0 + geo.height;
      let out = rect(p, geo.x0, geo.horizonY, geo.width, bottom - geo.horizonY, p.floor, { outline: false });
      out += line(p, geo.x0, geo.horizonY, geo.x0 + geo.width, geo.horizonY, p.line, 4);
      // A second, darker band in the foreground gives the floor some depth
      // without needing perspective.
      if (band > 0) {
        out += rect(p, geo.x0, geo.horizonY + band, geo.width, bottom - geo.horizonY - band, p.floorDark, {
          outline: false,
        });
      }
      return out;
    },
  },

  sky: {
    label: 'Sky',
    tags: ['structure', 'exterior'],
    spanning: true,
    params: [
      { key: 'bandHeight', label: 'Horizon haze height', type: 'number', default: 130, min: 0, max: 400, step: 10 },
    ],
    render(ctx) {
      const { palette: p, geo } = ctx;
      const band = num(ctx, 'bandHeight', 130);
      // Two flat bands rather than a gradient — gradients read as a different
      // medium next to flat-filled puppets.
      let out = rect(p, geo.x0, geo.y0, geo.width, geo.horizonY - geo.y0, p.ceiling, { outline: false });
      if (band > 0) {
        out += rect(p, geo.x0, geo.horizonY - band, geo.width, band, p.wall, { outline: false });
      }
      return out;
    },
  },

  doorway: {
    label: 'Doorway',
    tags: ['structure', 'interior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 150, min: 60, max: 400, step: 5 },
      { key: 'height', label: 'Height', type: 'number', default: 300, min: 120, max: 600, step: 5 },
      { key: 'open', label: 'Open', type: 'boolean', default: true },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 150);
      const h = num(ctx, 'height', 300);
      const open = ctx.params['open'] !== false;
      const frame = 12;

      let out = rect(p, -w / 2 - frame, -h - frame, w + frame * 2, h + frame, p.surfaceTrim);
      out += rect(p, -w / 2, -h, w, h, open ? p.floorDark : p.wood);
      if (!open) {
        // A handle is the cheapest thing that reads as "door" rather than "slab".
        out += `<circle cx="${r(w / 2 - 22)}" cy="${r(-h / 2)}" r="6" fill="${p.metal}" ${stroke(p, 2)}/>`;
      }
      return out;
    },
  },

  window: {
    label: 'Window',
    tags: ['structure', 'interior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 220, min: 60, max: 600, step: 10 },
      { key: 'height', label: 'Height', type: 'number', default: 160, min: 60, max: 400, step: 10 },
      { key: 'sillY', label: 'Height off floor', type: 'number', default: 250, min: 0, max: 500, step: 10 },
      { key: 'panes', label: 'Panes across', type: 'number', default: 2, min: 1, max: 6, step: 1 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 220);
      const h = num(ctx, 'height', 160);
      const sill = num(ctx, 'sillY', 250);
      const panes = Math.max(1, Math.round(num(ctx, 'panes', 2)));
      const top = -sill - h;

      let out = rect(p, -w / 2, top, w, h, p.glass);
      for (let i = 1; i < panes; i++) {
        const x = -w / 2 + (w / panes) * i;
        out += line(p, x, top, x, top + h, p.line, 3);
      }
      out += rect(p, -w / 2 - 8, -sill, w + 16, 10, p.surfaceTrim);
      return out;
    },
  },

  pillar: {
    label: 'Pillar',
    tags: ['structure', 'interior', 'exterior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 60, min: 20, max: 200, step: 5 },
      { key: 'height', label: 'Height', type: 'number', default: 480, min: 100, max: 900, step: 10 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 60);
      const h = num(ctx, 'height', 480);
      let out = rect(p, -w / 2, -h, w, h, p.surface);
      out += rect(p, -w / 2 - 8, -h, w + 16, 16, p.surfaceDark);
      out += rect(p, -w / 2 - 8, -18, w + 16, 18, p.surfaceDark);
      return out;
    },
  },

  'cubicle-panel': {
    label: 'Cubicle panel',
    tags: ['office', 'interior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 260, min: 60, max: 600, step: 10 },
      { key: 'height', label: 'Height', type: 'number', default: 266, min: 80, max: 600, step: 10 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 260);
      const h = num(ctx, 'height', 266);

      let out = rect(p, -w / 2, -h, w, h + 8, p.surface);
      out += rect(p, -w / 2, -h, w, 14, p.surfaceTrim);
      // A vertical seam stops the panel reading as one flat slab.
      out += line(p, 0, -h + 16, 0, 0, p.surfaceDark, 4);
      return out;
    },
  },

  'ceiling-light': {
    label: 'Ceiling light',
    tags: ['structure', 'interior', 'office'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 240, min: 40, max: 600, step: 10 },
      { key: 'height', label: 'Height', type: 'number', default: 30, min: 8, max: 80, step: 2 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 240);
      const h = num(ctx, 'height', 30);
      // Hangs from the ceiling rather than standing on the floor.
      const y = ceilingLocalY(ctx) - h - 6;

      let out = rect(p, -w / 2, y, w, h, p.light);
      out += `<rect x="${r(-w / 2 + 8)}" y="${r(y + h)}" width="${r(w - 16)}" height="10" fill="${p.lightGlow}" opacity="0.55"/>`;
      return out;
    },
  },

  stairs: {
    label: 'Stairs',
    tags: ['structure', 'interior'],
    params: [
      { key: 'steps', label: 'Steps', type: 'number', default: 5, min: 2, max: 14, step: 1 },
      { key: 'rise', label: 'Step rise', type: 'number', default: 26, min: 10, max: 60, step: 2 },
      { key: 'run', label: 'Step depth', type: 'number', default: 40, min: 15, max: 100, step: 5 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const steps = Math.max(2, Math.round(num(ctx, 'steps', 5)));
      const rise = num(ctx, 'rise', 26);
      const run = num(ctx, 'run', 40);
      const w = steps * run;

      const pts: Array<[number, number]> = [[-w / 2, 0]];
      for (let i = 0; i < steps; i++) {
        pts.push([-w / 2 + i * run, -(i + 1) * rise]);
        pts.push([-w / 2 + (i + 1) * run, -(i + 1) * rise]);
      }
      pts.push([w / 2, 0]);
      return poly(p, pts, p.surface);
    },
  },

  'wall-sign': {
    label: 'Wall sign',
    tags: ['structure', 'interior', 'generic'],
    params: [
      { key: 'text', label: 'Text', type: 'text', default: 'EXIT' },
      { key: 'width', label: 'Width', type: 'number', default: 120, min: 40, max: 400, step: 10 },
      { key: 'height', label: 'Height', type: 'number', default: 46, min: 20, max: 160, step: 2 },
      { key: 'y', label: 'Height off floor', type: 'number', default: 330, min: 0, max: 600, step: 10 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 120);
      const h = num(ctx, 'height', 46);
      const top = -num(ctx, 'y', 330) - h;
      const text = str(ctx, 'text', 'EXIT');

      let out = rect(p, -w / 2, top, w, h, p.accent);
      out += `<text x="0" y="${r(top + h * 0.68)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="${r(h * 0.5)}" fill="${p.line}">${escapeXml(text)}</text>`;
      return out;
    },
  },
};

/** Params can carry user text, and it lands inside SVG markup. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
