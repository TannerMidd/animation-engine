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
  var props = {};

  function castKey(scene) {
    return scene.cast
      .map(function (m) {
        return m.id + ':' + m.rig;
      })
      .join('|');
  }

  function propKey(scene) {
    return (scene.props || [])
      .map(function (prop) { return prop.id + ':' + prop.prop; })
      .join('|');
  }

  /**
   * Resolve every element we will touch, once. Per-frame work is then pure
   * attribute writes — no querying, no allocation in the hot path.
   */
  function build(scene) {
    actors = {};
    props = {};

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

    (scene.props || []).forEach(function (prop) {
      var setEl = document.getElementById('set-prop-' + prop.id);
      var dynamicEl = document.getElementById('dynamic-prop-' + prop.id);
      if (!setEl || !dynamicEl) {
        throw new Error('runtime: no rendered set instance for prop "' + prop.id + '"');
      }
      dynamicEl.style.display = 'none';
      setEl.style.display = '';
      props[prop.id] = {
        setEl: setEl,
        dynamicEl: dynamicEl,
        lastMode: null,
        lastVisible: null,
        lastPlacement: null,
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
    if (ir && (castKey(scene) !== castKey(ir) || propKey(scene) !== propKey(ir))) return false;
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

  /**
   * Temporary direct-manipulation pose used only by the editor while a handle
   * is held. It never mutates scene IR. The next __seek restores the authored
   * frame because touched cache entries are deliberately invalidated.
   */
  window.__previewParts = function (actorId, transforms) {
    var actor = actors[actorId];
    if (!actor) return false;
    for (var partId in transforms) {
      var part = actor.parts[partId];
      var t = transforms[partId];
      if (!part || !t) continue;
      var value = partTransform(t[0], t[1], t[2], t[3], part.px, part.py);
      if (value === '') part.el.removeAttribute('transform');
      else part.el.setAttribute('transform', value);
      part.last = null;
    }
    return true;
  };

  /**
   * Temporary actor-root placement used by the editor while the body handle is
   * held. Same contract as __previewParts: scene IR is never mutated, and the
   * next __seek restores the authored placement because the cache entry is
   * deliberately invalidated.
   */
  window.__previewRoot = function (actorId, x, y) {
    if (!ir) return false;
    var actor = actors[actorId];
    var frame = ir.frames[typeof window.__frame === 'number' ? window.__frame : 0];
    var state = frame && frame.actors[actorId];
    if (!actor || !state || !state.visible) return false;
    var sx = state.flip ? -state.scale : state.scale;
    actor.group.setAttribute('transform',
      'translate(' + x + ',' + y + ') ' +
      'scale(' + sx + ',' + state.scale + ') ' +
      'translate(' + -actor.anchorX + ',' + -actor.anchorY + ')');
    actor.lastPlacement = null;
    return true;
  };

  /**
   * Temporary set-prop nudge used by the editor while a prop handle is held.
   * Only the set-authored instance moves. __seek never touches set elements,
   * so restore is explicit: call with dx = dy = 0. Props without a set-prop id
   * (non-interaction decor) return false and the editor drags a ghost instead.
   */
  var propPreviewOriginals = {};
  window.__previewProp = function (id, dx, dy) {
    var el = document.getElementById('set-prop-' + id);
    if (!el) return false;
    if (!(id in propPreviewOriginals)) {
      propPreviewOriginals[id] = el.getAttribute('transform');
    }
    var original = propPreviewOriginals[id];
    if (dx === 0 && dy === 0) {
      if (original === null) el.removeAttribute('transform');
      else el.setAttribute('transform', original);
      delete propPreviewOriginals[id];
      return true;
    }
    el.setAttribute('transform', 'translate(' + dx + ',' + dy + ')' + (original ? ' ' + original : ''));
    return true;
  };

  var cardEls = { title: null, end: null };
  var shownCard = null;

  function applyCard(name) {
    if (name === shownCard) return;
    if (shownCard && cardEls[shownCard]) cardEls[shownCard].style.display = 'none';
    if (name && cardEls[name]) cardEls[name].style.display = '';
    shownCard = name;
    // The stage hides under a card so nothing half-set shows through the paper.
    root.style.visibility = name ? 'hidden' : '';
  }

  window.__seek = function (index) {
    if (!ir) throw new Error('runtime: no IR loaded');
    var frame = ir.frames[index];
    if (!frame) throw new Error('runtime: frame ' + index + ' out of range (0..' + (ir.frames.length - 1) + ')');

    applyCard(frame.card || null);

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

    var frameProps = frame.props || {};
    for (var propId in props) {
      var prop = props[propId];
      var propState = frameProps[propId];
      var visible = !propState || propState.visible;
      var mode = propState ? propState.mode : 'set';

      if (!visible) {
        if (prop.lastVisible !== false) {
          prop.setEl.style.display = 'none';
          prop.dynamicEl.style.display = 'none';
          prop.lastVisible = false;
        }
        continue;
      }

      if (prop.lastVisible !== true || prop.lastMode !== mode) {
        prop.setEl.style.display = mode === 'set' ? '' : 'none';
        prop.dynamicEl.style.display = mode === 'world' ? '' : 'none';
        prop.lastVisible = true;
        prop.lastMode = mode;
      }

      if (mode === 'world') {
        var propSx = propState.flip ? -propState.scale : propState.scale;
        var propPlacement =
          'translate(' + propState.x + ',' + propState.y + ') ' +
          (propState.rotation ? 'rotate(' + propState.rotation + ') ' : '') +
          'scale(' + propSx + ',' + propState.scale + ')';
        if (propPlacement !== prop.lastPlacement) {
          prop.dynamicEl.setAttribute('transform', propPlacement);
          prop.lastPlacement = propPlacement;
        }
      }
    }

    // A flag the harness polls, so a screenshot can never race a half-applied frame.
    window.__frame = index;
    return index;
  };

  cardEls.title = document.getElementById('card-title');
  cardEls.end = document.getElementById('card-end');

  if (!window.__IR) throw new Error('runtime: window.__IR was not set before the runtime loaded');
  build(window.__IR);
  window.__ready = true;
})();
