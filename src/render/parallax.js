/**
 * Per-layer parallax offset.
 *
 * The camera is a single viewBox over one coordinate space, so by default every
 * set layer moves with it exactly. That is correct for a flat elevation and
 * wrong for anything with depth: a far wall and a near doorway should not track
 * a close-up by the same number of units. This computes the translation that
 * makes a layer lag (or lead) the camera.
 *
 * Plain JS on purpose, and deliberately not an ES module: the page injects it as
 * a classic script ahead of the runtime, and the tests evaluate these exact
 * bytes. One implementation, so the browser and the test suite cannot drift —
 * the same reasoning as runtime.js.
 */
(function (scope) {
  'use strict';

  /**
   * Translation for one set layer.
   *
   * `k` is the layer's tracking factor per axis: 1 moves with the camera (no
   * parallax), below 1 lags behind it (further away), above 1 leads it (nearer).
   * `bounds` is the layer's artwork rect, `neutral` the stage centre.
   *
   * Two properties this has to have, both of which the obvious formula misses:
   *
   * Offsets are measured from the camera's *centre*, not its origin. A centred
   * PUSH_IN shrinks the viewBox about its middle, so `cam.x` climbs from 0 to 58
   * while nothing actually moves sideways. Keying off the origin turns that into
   * a visible lateral drift of the background during every push — using the
   * centre it is exactly zero, which is what the shot looks like.
   *
   * Translation only, never scale. Scaling a <g> scales stroke-width with it, so
   * a push-in would quietly thin the far layer's ink relative to the foreground
   * and read as a rendering bug. It would also break the editor's drag maths,
   * which converts screen to world through the camera alone.
   */
  // Rounded for the same reason prop geometry is: this lands in an attribute on
  // every frame, and float noise makes it longer and less stable without moving
  // a pixel. `-0` is normalised away so the attribute never reads "translate(-0,…)".
  function round(v) {
    var r = Math.round(v * 100) / 100;
    return r === 0 ? 0 : r;
  }

  /**
   * Shorten a layer's travel so it cannot run off its own artwork.
   *
   * Deliberately one-directional: the result always lies between zero and the
   * requested offset, so this can only ever move a layer *less*, never more and
   * never the other way. That matters more than it looks. A plain clamp into
   * [lo, hi] also "corrects" a camera that was already past the edge of the set,
   * which would give a layer tracking at exactly 1 a non-zero offset — turning
   * the no-parallax case into a visible shift and breaking the one property
   * every existing scene depends on.
   *
   * Both limits round inward first. Rounding the result instead would be wrong
   * in the only case that matters: a clamped offset sits exactly on its limit,
   * and rounding an exact limit can carry it a further 0.005 past — precisely
   * the edge reveal this exists to prevent.
   */
  function limitTravel(value, lo, hi) {
    if (value === 0) return 0;
    if (value > 0) return Math.min(value, Math.max(0, Math.floor(hi * 100) / 100));
    return Math.max(value, Math.min(0, Math.ceil(lo * 100) / 100));
  }

  function parallaxOffset(cam, k, bounds, neutral) {
    var dx = round((cam.x + cam.w / 2 - neutral.x) * (1 - k.x));
    var dy = round((cam.y + cam.h / 2 - neutral.y) * (1 - k.y));

    // Clamp so a layer can never expose an edge that was not already exposed.
    //
    // Sets are drawn wider than the frame precisely so close-ups can move off
    // centre, but a lagging layer reaches its own edge sooner than the camera
    // reaches the set's. Rather than argue from margin arithmetic that this
    // never happens, make it impossible: at the extremes parallax attenuates
    // toward zero, which is invisible. The alternative failure is a hole at the
    // side of the picture.
    dx = limitTravel(dx, cam.x + cam.w - (bounds.x0 + bounds.width), cam.x - bounds.x0);
    dy = limitTravel(dy, cam.y + cam.h - (bounds.y0 + bounds.height), cam.y - bounds.y0);

    return [dx === 0 ? 0 : dx, dy === 0 ? 0 : dy];
  }

  scope.__parallaxOffset = parallaxOffset;
})(typeof globalThis !== 'undefined' ? globalThis : this);
