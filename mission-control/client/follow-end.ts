/**
 * Whether a transcript is at its end: the one fact `useFollowEnd`
 * (`./use-follow-end`) keeps, from scroll events only. Pure.
 */

/** How close to the end still counts as being there, in points. */
const END_SLACK = 40;

/** Whether a scroll position is at the end of its content. */
export function isAtEnd(offsetY: number, viewportHeight: number, contentHeight: number): boolean {
  return offsetY + viewportHeight >= contentHeight - END_SLACK;
}
