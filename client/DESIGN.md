# Sisyphus client design contract

## 0. Direction

The client is a warm, light-first voice console: calm neutrals carry the
surface, coral marks the primary voice action, sage marks healthy connection,
and amber marks work that is still being organized. The UI should feel like a
quiet session notebook rather than a generic task manager.

## 1. Source of truth

`src/design-system/tokens/tokens.css` is the token source for color, spacing,
radius, typography, shadow, and motion. Components must use semantic tokens or
the documented scale; new raw colors and arbitrary spacing values are not
allowed.

## 2. Typography

- Base: `--ds-font-family-base` (Nunito with system fallback).
- Titles: `--ds-font-size-sm` / `--ds-font-weight-bold`.
- Supporting copy: `--ds-font-size-xs` / `--ds-color-text-secondary`.
- Sentence case and natural CJK wrapping are preferred over forced uppercase or
  dense labels.

## 3. Session topic primitive

`TaskNestPanel` is a display-only Scribe ledger, not an execution-task inbox.
It presents the chronological topic list with a compact heading, count, and a
two-card viewport. Each card has:

1. a status icon and status tint,
2. the Scribe phrase as the primary title,
3. the Scribe summary as secondary copy,
4. a small state label (`进行中` or `已结束`).

The fixed two-card viewport uses named `--task-nest-*` component tokens in the
panel stylesheet for its cylinder/card geometry. These anatomy tokens are the
only permitted fixed values; spacing, typography, color, radius, and motion
must continue to use the shared `--ds-*` scale.

Spinner motion uses the shared `--ds-duration-spin` token rather than a local
component duration.

The data layer keeps phrase and summary separate; components must not reparse a
combined display string.

## 4. States

- Empty: `会话话题` heading and a concise “waiting for scribe” message.
- Active: amber/neutral pending treatment, no busy spinner because Scribe topic
  activity is not an executing task.
- Closed: sage treatment and `已结束` label.
- Failed/cancelled: danger or neutral treatment only for legacy task events;
  these must not change the Scribe topic vocabulary.

## 5. Motion and accessibility

- Topic rotation is a discovery aid, pauses on hover/focus, has an explicit
  keyboard/touch pause control, and must not be required to understand the
  current topic. It is disabled under `prefers-reduced-motion`.
- Spinner motion is disabled under `prefers-reduced-motion`.
- The panel uses a semantic section and descriptive labels; text is clipped
  with ellipsis only after preserving a readable title/summary hierarchy.

## 6. Accepted debt

- The existing app has no full visual reference packet; this contract preserves
  the established warm token system rather than introducing a new brand system.
- The topic ledger remains display-only until a separate interaction contract
  defines topic selection or navigation.
