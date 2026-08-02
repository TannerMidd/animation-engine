/**
 * Browser-side render runtime.
 *
 * Exposes window.__seek(frame), which applies scene IR state for a single frame
 * synchronously. There is no clock here and no interpolation: no rAF, no CSS
 * transitions, no time source of any kind. Frame N looks the same whether it is
 * reached by playing forward, by jumping at random, or on a different machine
 * six months from now. That property is the whole basis of the render harness —
 * it lets us screenshot frames out of order, resume after a crash, split a
 * scene across CPU cores, and diff two renders byte for byte.
 *
 * The same file backs the live preview, where a requestAnimationFrame loop in
 * the parent window calls __seek instead of Playwright doing it. Preview and
 * final output are therefore one code path and cannot drift apart.
 *
 * Plain JS on purpose: it is injected as a script tag, so there is no build step
 * between editing this file and it running.
 */
(function () {
  'use strict';

  var root = document.getElementById('stage');
  if (!root) throw new Error('runtime: #stage not found');

  var ir = null;
  var actors = {};

  function castKey(scene) {
    return scene.cast
      .map(function (m) {
        return m.id + ':' + m.rig;
      })
      .join('|');
  }

  /**
   * Resolve every element we will touch, once. Per-frame work is then pure
   * attribute writes — no querying, no allocation in the hot path.
   */
  function build(scene) {
    actors = {};

    scene.cast.forEach(function (member) {
      var group = document.getElementById('actor-' + member.id);
      if (!group) throw new Error('runtime: no group for actor "' + member.id + '"');

      var rig = window.__RIGS[member.rig];
      if (!rig) throw new Error('runtime: no rig data for "' + member.rig + '"');

      // Ids in the DOM are namespaced per actor by the page builder, so two
      // actors can share one rig without colliding.
      var prefix = member.id + '__';

      var parts = {};
      rig.parts.forEach(function (part) {
        var el = group.querySelector('#' + CSS.escape(prefix + part.id));
        if (!el) throw new Error('runtime: actor "' + member.id + '" is missing part "' + part.id + '"');
        parts[part.id] = { el: el, px: part.pivot[0], py: part.pivot[1], last: null };
      });

      // Flatten every swap variant across every slot into one lookup, plus a
      // per-slot list so we know what to hide when a slot changes.
      var slots = {};
      rig.swapSets.forEach(function (set) {
        var variants = {};
        set.variants.forEach(function (id) {
          var el = group.querySelector('#' + CSS.escape(prefix + id));
          if (!el) throw new Error('runtime: actor "' + member.id + '" is missing swap variant "' + id + '"');
          variants[id] = el;
          el.style.display = 'none';
        });
        slots[set.slot] = { variants: variants, shown: null };
      });

      actors[member.id] = {
        group: group,
        parts: parts,
        slots: slots,
        anchorX: rig.anchor[0],
        anchorY: rig.anchor[1],
        lastPlacement: null,
        lastVisible: null,
      };
    });

    ir = scene;
    window.__IR = scene;
    window.__frameCount = scene.frames.length;
    window.__fps = scene.meta.fps;
  }

  /**
   * Swap in a new scene without reloading the page.
   *
   * Only valid when the cast is unchanged — the actor markup is baked into the
   * document by the page builder, so a different cast needs different DOM.
   * Returns false in that case and the caller reloads the frame, rather than
   * silently rendering the wrong puppets.
   */
  window.__loadIR = function (scene) {
    if (ir && castKey(scene) !== castKey(ir)) return false;
    build(scene);
    return true;
  };

  function partTransform(rot, dx, dy, scale, px, py) {
    // Order matters: translate the part, then rotate and scale about its own
    // pivot. Parent groups are nested to match the rig tree, so a shoulder
    // rotation carries the forearm and hand along without us doing anything.
    var t = '';
    if (dx !== 0 || dy !== 0) t += 'translate(' + dx + ',' + dy + ') ';
    if (rot !== 0) t += 'rotate(' + rot + ',' + px + ',' + py + ') ';
    if (scale !== 1) t += 'translate(' + px + ',' + py + ') scale(' + scale + ') translate(' + -px + ',' + -py + ')';
    return t;
  }

  window.__seek = function (index) {
    if (!ir) throw new Error('runtime: no IR loaded');
    var frame = ir.frames[index];
    if (!frame) throw new Error('runtime: frame ' + index + ' out of range (0..' + (ir.frames.length - 1) + ')');

    var cam = frame.camera;
    root.setAttribute('viewBox', cam.x + ' ' + cam.y + ' ' + cam.w + ' ' + cam.h);

    for (var id in actors) {
      var actor = actors[id];
      var state = frame.actors[id];

      if (!state || !state.visible) {
        if (actor.lastVisible !== false) {
          actor.group.style.display = 'none';
          actor.lastVisible = false;
        }
        continue;
      }
      if (actor.lastVisible !== true) {
        actor.group.style.display = '';
        actor.lastVisible = true;
      }

      // Place the rig's anchor at the actor's set position.
      var sx = state.flip ? -state.scale : state.scale;
      var placement =
        'translate(' + state.x + ',' + state.y + ') ' +
        'scale(' + sx + ',' + state.scale + ') ' +
        'translate(' + -actor.anchorX + ',' + -actor.anchorY + ')';
      if (placement !== actor.lastPlacement) {
        actor.group.setAttribute('transform', placement);
        actor.lastPlacement = placement;
      }

      for (var partId in actor.parts) {
        var part = actor.parts[partId];
        var t = state.parts[partId];
        var value = t ? partTransform(t[0], t[1], t[2], t[3], part.px, part.py) : '';
        if (value !== part.last) {
          if (value === '') part.el.removeAttribute('transform');
          else part.el.setAttribute('transform', value);
          part.last = value;
        }
      }

      for (var slotName in actor.slots) {
        var slot = actor.slots[slotName];
        var want = state.swaps[slotName];
        if (want === slot.shown) continue;
        if (slot.shown && slot.variants[slot.shown]) slot.variants[slot.shown].style.display = 'none';
        if (want && slot.variants[want]) slot.variants[want].style.display = '';
        slot.shown = want || null;
      }
    }

    // A flag the harness polls, so a screenshot can never race a half-applied frame.
    window.__frame = index;
    return index;
  };

  if (!window.__IR) throw new Error('runtime: window.__IR was not set before the runtime loaded');
  build(window.__IR);
  window.__ready = true;
})();
