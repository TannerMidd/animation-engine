import { type PropDef, num, str, rect, ellipse, line, poly, stroke, r } from './types.ts';
import { escapeXml } from './structure.ts';

/**
 * Interior furniture: office, home and bar.
 *
 * All drawn in local coordinates with the origin where the prop meets the
 * floor, so the same desk works standing against a back wall or in the
 * foreground with a character behind it.
 */

export const INTERIOR_PROPS: Record<string, PropDef> = {
  desk: {
    label: 'Desk',
    tags: ['office', 'home', 'interior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 250, min: 80, max: 700, step: 10 },
      { key: 'height', label: 'Height', type: 'number', default: 96, min: 40, max: 200, step: 5 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 250);
      const h = num(ctx, 'height', 96);
      const top = 16;

      let out = rect(p, -w / 2 + 14, -h + top, 12, h - top, p.woodDark);
      out += rect(p, w / 2 - 26, -h + top, 12, h - top, p.woodDark);
      out += rect(p, -w / 2, -h, w, top, p.wood);
      return out;
    },
  },

  monitor: {
    label: 'Monitor',
    tags: ['office', 'interior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 108, min: 40, max: 300, step: 4 },
      { key: 'height', label: 'Height', type: 'number', default: 76, min: 30, max: 200, step: 4 },
      { key: 'on', label: 'Screen lit', type: 'boolean', default: true },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 108);
      const h = num(ctx, 'height', 76);
      const on = ctx.params['on'] !== false;
      const stand = 16;

      let out = rect(p, -9, -stand, 18, stand, p.metal);
      out += rect(p, -w / 2, -stand - h, w, h, p.metal, { rx: 6 });
      out += rect(p, -w / 2 + 10, -stand - h + 10, w - 20, h - 22, on ? p.screen : p.metalDark, {
        outline: false,
      });
      return out;
    },
  },

  chair: {
    label: 'Office chair',
    tags: ['office', 'interior'],
    params: [{ key: 'height', label: 'Seat height', type: 'number', default: 90, min: 40, max: 180, step: 5 }],
    render(ctx) {
      const { palette: p } = ctx;
      const seat = num(ctx, 'height', 90);
      const w = 74;

      let out = line(p, -34, 0, 34, 0, p.metalDark, 5);
      out += rect(p, -5, -seat, 10, seat, p.metalDark);
      out += rect(p, -w / 2, -seat - 14, w, 16, p.fabric, { rx: 6 });
      out += rect(p, -w / 2 + 6, -seat - 90, w - 12, 78, p.fabric, { rx: 8 });
      return out;
    },
  },

  'filing-cabinet': {
    label: 'Filing cabinet',
    tags: ['office', 'interior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 90, min: 40, max: 200, step: 5 },
      { key: 'height', label: 'Height', type: 'number', default: 180, min: 60, max: 400, step: 10 },
      { key: 'drawers', label: 'Drawers', type: 'number', default: 3, min: 1, max: 6, step: 1 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 90);
      const h = num(ctx, 'height', 180);
      const n = Math.max(1, Math.round(num(ctx, 'drawers', 3)));

      let out = rect(p, -w / 2, -h, w, h, p.metal);
      for (let i = 0; i < n; i++) {
        const y = -h + (h / n) * i + 6;
        out += rect(p, -w / 2 + 8, y, w - 16, h / n - 12, p.metalDark, { strokeWidth: 2 });
        out += line(p, -14, y + h / n / 2 - 6, 14, y + h / n / 2 - 6, p.surface, 4);
      }
      return out;
    },
  },

  'water-cooler': {
    label: 'Water cooler',
    tags: ['office', 'interior'],
    params: [],
    render(ctx) {
      const { palette: p } = ctx;
      let out = rect(p, -32, -120, 64, 120, p.surface);
      out += rect(p, -26, -190, 52, 72, p.glass, { rx: 8 });
      out += rect(p, -10, -108, 20, 14, p.metalDark, { strokeWidth: 2 });
      return out;
    },
  },

  whiteboard: {
    label: 'Whiteboard',
    tags: ['office', 'interior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 300, min: 100, max: 700, step: 10 },
      { key: 'height', label: 'Height', type: 'number', default: 180, min: 60, max: 400, step: 10 },
      { key: 'y', label: 'Height off floor', type: 'number', default: 240, min: 0, max: 500, step: 10 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 300);
      const h = num(ctx, 'height', 180);
      const top = -num(ctx, 'y', 240) - h;

      let out = rect(p, -w / 2, top, w, h, '#e8e6df');
      // Scribbles, so it doesn't read as a blank rectangle.
      out += line(p, -w / 2 + 30, top + 40, -w / 2 + w * 0.55, top + 40, p.metalDark, 4);
      out += line(p, -w / 2 + 30, top + 70, -w / 2 + w * 0.4, top + 70, p.metalDark, 4);
      out += line(p, -w / 2 + 30, top + 100, -w / 2 + w * 0.62, top + 100, p.accent, 4);
      return out;
    },
  },

  sofa: {
    label: 'Sofa',
    tags: ['home', 'interior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 320, min: 120, max: 700, step: 10 },
      { key: 'height', label: 'Back height', type: 'number', default: 150, min: 60, max: 300, step: 5 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 320);
      const h = num(ctx, 'height', 150);
      const seat = h * 0.45;

      let out = rect(p, -w / 2, -h, w, h, p.fabric, { rx: 14 });
      out += rect(p, -w / 2, -seat, w, seat, p.fabricDark, { rx: 12 });
      out += rect(p, -w / 2, -h * 0.82, 34, h * 0.82, p.fabric, { rx: 12 });
      out += rect(p, w / 2 - 34, -h * 0.82, 34, h * 0.82, p.fabric, { rx: 12 });
      return out;
    },
  },

  tv: {
    label: 'Television',
    tags: ['home', 'interior', 'bar'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 220, min: 80, max: 500, step: 10 },
      { key: 'height', label: 'Height', type: 'number', default: 130, min: 50, max: 300, step: 5 },
      { key: 'y', label: 'Height off floor', type: 'number', default: 0, min: 0, max: 500, step: 10 },
      { key: 'on', label: 'Screen lit', type: 'boolean', default: true },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 220);
      const h = num(ctx, 'height', 130);
      const off = num(ctx, 'y', 0);
      const on = ctx.params['on'] !== false;
      const top = -off - h;

      let out = '';
      if (off <= 0) {
        out += rect(p, -30, -18, 60, 18, p.metalDark);
      }
      out += rect(p, -w / 2, top, w, h, p.metal, { rx: 4 });
      out += rect(p, -w / 2 + 8, top + 8, w - 16, h - 16, on ? p.screen : p.metalDark, { outline: false });
      return out;
    },
  },

  lamp: {
    label: 'Floor lamp',
    tags: ['home', 'interior'],
    params: [{ key: 'height', label: 'Height', type: 'number', default: 300, min: 120, max: 600, step: 10 }],
    render(ctx) {
      const { palette: p } = ctx;
      const h = num(ctx, 'height', 300);
      let out = ellipse(p, 0, 0, 30, 9, p.metalDark);
      out += rect(p, -4, -h, 8, h, p.metalDark);
      out += poly(p, [
        [-42, -h],
        [42, -h],
        [30, -h - 60],
        [-30, -h - 60],
      ], p.light);
      return out;
    },
  },

  bookshelf: {
    label: 'Bookshelf',
    tags: ['home', 'interior', 'office'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 180, min: 80, max: 500, step: 10 },
      { key: 'height', label: 'Height', type: 'number', default: 320, min: 100, max: 600, step: 10 },
      { key: 'shelves', label: 'Shelves', type: 'number', default: 4, min: 2, max: 8, step: 1 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 180);
      const h = num(ctx, 'height', 320);
      const n = Math.max(2, Math.round(num(ctx, 'shelves', 4)));

      let out = rect(p, -w / 2, -h, w, h, p.woodDark);
      const gap = h / n;
      // Books as alternating bars — legible at any size, and cheap.
      for (let i = 0; i < n; i++) {
        const shelfY = -h + gap * i + gap - 10;
        out += rect(p, -w / 2 + 6, shelfY, w - 12, 8, p.wood, { outline: false });
        let x = -w / 2 + 14;
        let k = 0;
        while (x < w / 2 - 20) {
          const bw = 8 + ((i + k) % 3) * 5;
          const bh = gap * (0.45 + (((i * 3 + k) % 4) * 0.08));
          const fill = [p.accent, p.fabric, p.foliage, p.clay][(i + k) % 4]!;
          out += rect(p, x, shelfY - bh, bw, bh, fill, { outline: false });
          x += bw + 3;
          k++;
        }
      }
      return out;
    },
  },

  counter: {
    label: 'Kitchen counter',
    tags: ['home', 'interior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 320, min: 100, max: 700, step: 10 },
      { key: 'height', label: 'Height', type: 'number', default: 130, min: 60, max: 220, step: 5 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 320);
      const h = num(ctx, 'height', 130);

      let out = rect(p, -w / 2, -h, w, h, p.surface);
      out += rect(p, -w / 2 - 6, -h, w + 12, 16, p.surfaceDark);
      const doors = Math.max(1, Math.round(w / 110));
      for (let i = 1; i < doors; i++) {
        const x = -w / 2 + (w / doors) * i;
        out += line(p, x, -h + 20, x, -6, p.surfaceDark, 3);
      }
      return out;
    },
  },

  fridge: {
    label: 'Fridge',
    tags: ['home', 'interior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 130, min: 60, max: 260, step: 5 },
      { key: 'height', label: 'Height', type: 'number', default: 300, min: 120, max: 500, step: 10 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 130);
      const h = num(ctx, 'height', 300);

      let out = rect(p, -w / 2, -h, w, h, p.surface, { rx: 6 });
      out += line(p, -w / 2, -h * 0.62, w / 2, -h * 0.62, p.line, 3);
      out += rect(p, w / 2 - 20, -h * 0.58, 8, 44, p.metalDark, { strokeWidth: 2 });
      out += rect(p, w / 2 - 20, -h * 0.72, 8, 40, p.metalDark, { strokeWidth: 2 });
      return out;
    },
  },

  'bar-counter': {
    label: 'Bar counter',
    tags: ['bar', 'interior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 520, min: 150, max: 900, step: 10 },
      { key: 'height', label: 'Height', type: 'number', default: 150, min: 80, max: 240, step: 5 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 520);
      const h = num(ctx, 'height', 150);

      let out = rect(p, -w / 2, -h, w, h, p.wood);
      out += rect(p, -w / 2 - 10, -h, w + 20, 18, p.woodDark);
      out += line(p, -w / 2, -h * 0.42, w / 2, -h * 0.42, p.woodDark, 4);
      return out;
    },
  },

  stool: {
    label: 'Bar stool',
    tags: ['bar', 'interior'],
    params: [{ key: 'height', label: 'Height', type: 'number', default: 130, min: 60, max: 240, step: 5 }],
    render(ctx) {
      const { palette: p } = ctx;
      const h = num(ctx, 'height', 130);

      let out = ellipse(p, 0, 0, 26, 8, p.metalDark);
      out += rect(p, -5, -h, 10, h, p.metalDark);
      out += line(p, -20, -h * 0.35, 20, -h * 0.35, p.metalDark, 4);
      out += ellipse(p, 0, -h, 34, 12, p.fabric);
      return out;
    },
  },

  'bottle-shelf': {
    label: 'Bottle shelf',
    tags: ['bar', 'interior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 300, min: 100, max: 600, step: 10 },
      { key: 'y', label: 'Height off floor', type: 'number', default: 220, min: 0, max: 500, step: 10 },
      { key: 'rows', label: 'Rows', type: 'number', default: 2, min: 1, max: 4, step: 1 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 300);
      const base = -num(ctx, 'y', 220);
      const rows = Math.max(1, Math.round(num(ctx, 'rows', 2)));
      const rowH = 70;

      let out = '';
      for (let row = 0; row < rows; row++) {
        const shelfY = base - row * rowH;
        out += rect(p, -w / 2, shelfY, w, 8, p.woodDark, { outline: false });
        let x = -w / 2 + 14;
        let k = 0;
        while (x < w / 2 - 16) {
          const bh = 34 + ((row + k) % 3) * 10;
          const fill = [p.foliage, p.clay, p.glass, p.accent][(row + k) % 4]!;
          out += rect(p, x, shelfY - bh, 11, bh, fill, { strokeWidth: 2 });
          x += 17;
          k++;
        }
      }
      return out;
    },
  },

  'neon-sign': {
    label: 'Neon sign',
    tags: ['bar', 'interior', 'exterior'],
    params: [
      { key: 'text', label: 'Text', type: 'text', default: 'OPEN' },
      { key: 'y', label: 'Height off floor', type: 'number', default: 340, min: 0, max: 700, step: 10 },
      { key: 'size', label: 'Text size', type: 'number', default: 44, min: 16, max: 140, step: 2 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const text = str(ctx, 'text', 'OPEN');
      const size = num(ctx, 'size', 44);
      const y = -num(ctx, 'y', 340);
      const w = Math.max(80, text.length * size * 0.72 + 40);

      // Glow is a fat translucent copy behind the stroke — no filters, which
      // keeps rendering deterministic across machines.
      let out = rect(p, -w / 2, y - size, w, size * 1.5, p.metalDark, { rx: 10 });
      const common = `x="0" y="${r(y + size * 0.16)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="${r(size)}"`;
      out += `<text ${common} fill="none" stroke="${p.accentGlow}" stroke-width="9" opacity="0.45">${escapeXml(text)}</text>`;
      out += `<text ${common} fill="${p.accent}">${escapeXml(text)}</text>`;
      return out;
    },
  },

  booth: {
    label: 'Booth seat',
    tags: ['bar', 'interior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 260, min: 100, max: 600, step: 10 },
      { key: 'height', label: 'Back height', type: 'number', default: 200, min: 80, max: 400, step: 10 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 260);
      const h = num(ctx, 'height', 200);

      let out = rect(p, -w / 2, -h, w, h, p.fabricDark, { rx: 10 });
      const tufts = Math.max(2, Math.round(w / 70));
      for (let i = 0; i < tufts; i++) {
        const x = -w / 2 + (w / tufts) * (i + 0.5);
        out += line(p, x, -h + 16, x, -h * 0.45, p.fabric, 3);
      }
      out += rect(p, -w / 2, -h * 0.42, w, h * 0.42, p.fabric, { rx: 8 });
      return out;
    },
  },
};

void stroke;
