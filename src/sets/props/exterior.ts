import { type PropDef, num, str, rect, ellipse, line, poly, r } from './types.ts';
import { escapeXml } from './structure.ts';

/**
 * Outdoor props.
 *
 * Sky-borne things (cloud, moon) take a `y` measured off the floor rather than
 * standing on it, so a descriptor can put them anywhere in the upper band.
 */

export const EXTERIOR_PROPS: Record<string, PropDef> = {
  tree: {
    label: 'Tree',
    tags: ['exterior'],
    params: [
      { key: 'height', label: 'Height', type: 'number', default: 420, min: 120, max: 900, step: 10 },
      { key: 'spread', label: 'Canopy spread', type: 'number', default: 170, min: 60, max: 400, step: 10 },
      { key: 'trunk', label: 'Trunk width', type: 'number', default: 34, min: 10, max: 100, step: 2 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const h = num(ctx, 'height', 420);
      const spread = num(ctx, 'spread', 170);
      const tw = num(ctx, 'trunk', 34);
      const canopyY = -h + spread * 0.55;

      let out = rect(p, -tw / 2, -h * 0.55, tw, h * 0.55, p.wood);
      // Three overlapping blobs read as foliage without any detail work.
      out += ellipse(p, 0, canopyY, spread, spread * 0.78, p.foliage);
      out += ellipse(p, -spread * 0.55, canopyY + spread * 0.3, spread * 0.6, spread * 0.5, p.foliageDark);
      out += ellipse(p, spread * 0.55, canopyY + spread * 0.26, spread * 0.58, spread * 0.48, p.foliageDark);
      return out;
    },
  },

  bush: {
    label: 'Bush',
    tags: ['exterior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 140, min: 40, max: 400, step: 10 },
      { key: 'height', label: 'Height', type: 'number', default: 80, min: 20, max: 250, step: 5 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 140);
      const h = num(ctx, 'height', 80);

      let out = ellipse(p, -w * 0.26, -h * 0.6, w * 0.4, h * 0.6, p.foliageDark);
      out += ellipse(p, w * 0.26, -h * 0.55, w * 0.38, h * 0.55, p.foliageDark);
      out += ellipse(p, 0, -h * 0.72, w * 0.42, h * 0.72, p.foliage);
      return out;
    },
  },

  rock: {
    label: 'Rock',
    tags: ['exterior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 120, min: 30, max: 400, step: 5 },
      { key: 'height', label: 'Height', type: 'number', default: 70, min: 20, max: 250, step: 5 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 120);
      const h = num(ctx, 'height', 70);
      return poly(p, [
        [-w / 2, 0],
        [-w * 0.34, -h * 0.82],
        [w * 0.08, -h],
        [w * 0.42, -h * 0.6],
        [w / 2, 0],
      ], p.surface);
    },
  },

  streetlight: {
    label: 'Streetlight',
    tags: ['exterior'],
    params: [
      { key: 'height', label: 'Height', type: 'number', default: 460, min: 150, max: 900, step: 10 },
      { key: 'lit', label: 'Lit', type: 'boolean', default: true },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const h = num(ctx, 'height', 460);
      const lit = ctx.params['lit'] !== false;

      let out = ellipse(p, 0, 0, 20, 7, p.metalDark);
      out += rect(p, -6, -h, 12, h, p.metal);
      out += `<path d="M 0 ${r(-h)} q 0 -34 54 -34" fill="none" stroke="${p.line}" stroke-width="10" stroke-linecap="round"/>`;
      out += ellipse(p, 56, -h - 30, 24, 12, lit ? p.light : p.metalDark);
      if (lit) {
        out += poly(p, [
          [34, -h - 22],
          [78, -h - 22],
          [130, 0],
          [-18, 0],
        ], p.lightGlow, false).replace('/>', ' opacity="0.16"/>');
      }
      return out;
    },
  },

  fence: {
    label: 'Fence',
    tags: ['exterior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 300, min: 80, max: 900, step: 10 },
      { key: 'height', label: 'Height', type: 'number', default: 110, min: 40, max: 300, step: 5 },
      { key: 'gap', label: 'Post spacing', type: 'number', default: 34, min: 14, max: 100, step: 2 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 300);
      const h = num(ctx, 'height', 110);
      const gap = Math.max(14, num(ctx, 'gap', 34));

      let out = '';
      for (let x = -w / 2; x <= w / 2 - 10; x += gap) {
        out += rect(p, x, -h, 12, h, p.wood, { strokeWidth: 2 });
      }
      out += rect(p, -w / 2, -h * 0.72, w, 10, p.woodDark, { strokeWidth: 2 });
      out += rect(p, -w / 2, -h * 0.3, w, 10, p.woodDark, { strokeWidth: 2 });
      return out;
    },
  },

  facade: {
    label: 'Building facade',
    tags: ['exterior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 320, min: 100, max: 900, step: 10 },
      { key: 'height', label: 'Height', type: 'number', default: 480, min: 150, max: 1000, step: 10 },
      { key: 'floors', label: 'Floors', type: 'number', default: 3, min: 1, max: 8, step: 1 },
      { key: 'windowsPerFloor', label: 'Windows per floor', type: 'number', default: 3, min: 1, max: 8, step: 1 },
      { key: 'lit', label: 'Windows lit', type: 'boolean', default: false },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 320);
      const h = num(ctx, 'height', 480);
      const floors = Math.max(1, Math.round(num(ctx, 'floors', 3)));
      const perFloor = Math.max(1, Math.round(num(ctx, 'windowsPerFloor', 3)));
      const lit = ctx.params['lit'] === true;

      let out = rect(p, -w / 2, -h, w, h, p.surfaceDark);
      const fh = h / floors;
      const ww = Math.min(46, (w / perFloor) * 0.5);
      const wh = Math.min(fh * 0.44, 56);

      for (let f = 0; f < floors; f++) {
        for (let i = 0; i < perFloor; i++) {
          const x = -w / 2 + (w / perFloor) * (i + 0.5) - ww / 2;
          const y = -h + fh * f + (fh - wh) / 2;
          // Deterministic "some lights on" pattern — no RNG in a prop, or the
          // set would differ between renders.
          const on = lit && (f * perFloor + i) % 3 !== 1;
          out += rect(p, x, y, ww, wh, on ? p.light : p.glass, { strokeWidth: 2 });
        }
      }
      return out;
    },
  },

  cloud: {
    label: 'Cloud',
    tags: ['exterior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 220, min: 60, max: 600, step: 10 },
      { key: 'y', label: 'Height off floor', type: 'number', default: 460, min: 0, max: 900, step: 10 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 220);
      const y = -num(ctx, 'y', 460);
      const h = w * 0.34;

      let out = ellipse(p, -w * 0.22, y, w * 0.3, h * 0.7, p.light, { outline: false });
      out += ellipse(p, w * 0.2, y + h * 0.1, w * 0.26, h * 0.58, p.light, { outline: false });
      out += ellipse(p, 0, y - h * 0.24, w * 0.28, h * 0.8, p.light, { outline: false });
      return out;
    },
  },

  moon: {
    label: 'Moon',
    tags: ['exterior'],
    params: [
      { key: 'radius', label: 'Radius', type: 'number', default: 54, min: 15, max: 200, step: 2 },
      { key: 'y', label: 'Height off floor', type: 'number', default: 540, min: 0, max: 900, step: 10 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const rad = num(ctx, 'radius', 54);
      const y = -num(ctx, 'y', 540);
      let out = `<circle cx="0" cy="${r(y)}" r="${r(rad * 1.5)}" fill="${p.lightGlow}" opacity="0.14"/>`;
      out += `<circle cx="0" cy="${r(y)}" r="${r(rad)}" fill="${p.light}"/>`;
      return out;
    },
  },

  'road-sign': {
    label: 'Road sign',
    tags: ['exterior'],
    params: [
      { key: 'text', label: 'Text', type: 'text', default: 'NO' },
      { key: 'height', label: 'Post height', type: 'number', default: 220, min: 80, max: 500, step: 10 },
      { key: 'width', label: 'Sign width', type: 'number', default: 130, min: 50, max: 400, step: 5 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const h = num(ctx, 'height', 220);
      const w = num(ctx, 'width', 130);
      const sh = w * 0.55;
      const text = str(ctx, 'text', 'NO');

      let out = rect(p, -5, -h, 10, h, p.metalDark);
      out += rect(p, -w / 2, -h - sh, w, sh, p.surface, { rx: 4 });
      out += `<text x="0" y="${r(-h - sh * 0.32)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="${r(sh * 0.42)}" fill="${p.line}">${escapeXml(text)}</text>`;
      return out;
    },
  },
};

export const GENERIC_PROPS: Record<string, PropDef> = {
  plant: {
    label: 'Potted plant',
    tags: ['generic', 'interior', 'office', 'home'],
    params: [
      { key: 'height', label: 'Height', type: 'number', default: 110, min: 40, max: 300, step: 5 },
      { key: 'leaves', label: 'Leaves', type: 'number', default: 3, min: 1, max: 7, step: 1 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const h = num(ctx, 'height', 110);
      const potH = h * 0.42;
      const leaves = Math.max(1, Math.round(num(ctx, 'leaves', 3)));
      const leafH = h - potH;

      let out = '';
      for (let i = 0; i < leaves; i++) {
        // Fan the leaves symmetrically around vertical.
        const t = leaves === 1 ? 0 : (i / (leaves - 1)) * 2 - 1;
        const angle = t * 30;
        const cx = t * leafH * 0.22;
        const cy = -potH - leafH * 0.46;
        out += `<ellipse cx="${r(cx)}" cy="${r(cy)}" rx="${r(leafH * 0.17)}" ry="${r(leafH * 0.46)}" fill="${p.foliage}" stroke="${p.line}" stroke-width="3" transform="rotate(${r(angle)} ${r(cx)} ${r(cy)})"/>`;
      }
      out += poly(p, [
        [-h * 0.24, -potH],
        [h * 0.24, -potH],
        [h * 0.18, 0],
        [-h * 0.18, 0],
      ], p.clay);
      return out;
    },
  },

  crate: {
    label: 'Crate',
    tags: ['generic', 'exterior', 'interior'],
    params: [{ key: 'size', label: 'Size', type: 'number', default: 90, min: 30, max: 250, step: 5 }],
    render(ctx) {
      const { palette: p } = ctx;
      const s = num(ctx, 'size', 90);
      let out = rect(p, -s / 2, -s, s, s, p.wood);
      out += line(p, -s / 2, -s, s / 2, 0, p.woodDark, 4);
      out += line(p, s / 2, -s, -s / 2, 0, p.woodDark, 4);
      return out;
    },
  },

  poster: {
    label: 'Poster',
    tags: ['generic', 'interior'],
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 110, min: 40, max: 400, step: 5 },
      { key: 'height', label: 'Height', type: 'number', default: 150, min: 40, max: 500, step: 5 },
      { key: 'y', label: 'Height off floor', type: 'number', default: 280, min: 0, max: 600, step: 10 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const w = num(ctx, 'width', 110);
      const h = num(ctx, 'height', 150);
      const top = -num(ctx, 'y', 280) - h;

      let out = rect(p, -w / 2, top, w, h, p.surface);
      out += ellipse(p, 0, top + h * 0.36, w * 0.26, w * 0.26, p.accent);
      out += rect(p, -w * 0.32, top + h * 0.68, w * 0.64, 8, p.line, { outline: false });
      out += rect(p, -w * 0.22, top + h * 0.8, w * 0.44, 6, p.line, { outline: false });
      return out;
    },
  },

  clock: {
    label: 'Wall clock',
    tags: ['generic', 'interior', 'office'],
    params: [
      { key: 'radius', label: 'Radius', type: 'number', default: 34, min: 12, max: 120, step: 2 },
      { key: 'y', label: 'Height off floor', type: 'number', default: 380, min: 0, max: 600, step: 10 },
    ],
    render(ctx) {
      const { palette: p } = ctx;
      const rad = num(ctx, 'radius', 34);
      const cy = -num(ctx, 'y', 380);

      let out = `<circle cx="0" cy="${r(cy)}" r="${r(rad)}" fill="${p.surface}" stroke="${p.line}" stroke-width="3"/>`;
      // Hands at a fixed time — a prop must never depend on the clock, or two
      // renders of the same scene would differ.
      out += line(p, 0, cy, 0, cy - rad * 0.6, p.line, 4);
      out += line(p, 0, cy, rad * 0.42, cy + rad * 0.24, p.line, 4);
      return out;
    },
  },
};
