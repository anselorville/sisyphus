/**
 * Typed mirror of the numeric tokens in tokens.css, for JS-driven values
 * (inline transforms, requestAnimationFrame loops) that can't read CSS
 * custom properties directly. Colors stay CSS-only -- components read
 * `var(--ds-color-*)`, nothing here.
 */

export const dsSpace = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
} as const;

export const dsRadius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

export const dsDuration = {
  fast: 120,
  base: 200,
  slow: 400,
} as const;

export const dsEase = {
  standard: "cubic-bezier(0.4, 0, 0.2, 1)",
  bounce: "cubic-bezier(0.34, 1.56, 0.64, 1)",
} as const;
