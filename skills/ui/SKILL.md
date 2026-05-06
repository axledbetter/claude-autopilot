---
name: ui
description: Opinionated full-pass UI polish on an existing screen — audit, simplify, align, polish in one shot. Use when the user wants to condense, level, align, clean up, tighten, or "make it feel better." Trigger phrases include "condense the UI", "level these out", "clean up and condense", "waste of space", "align better", "feels cluttered", "tighten this up", "polish", "not a great use of space", "make it look right", "fix the alignment". Self-contained — runs all four lenses internally. For subtraction-only, use /simplify-ui. For correctness-only audit, use /ui-ux-pro-max. For craft/feel-only, use /make-interfaces-feel-better. For greenfield design, escalate to frontend-design:frontend-design.
---

# UI polish pass

You are doing a targeted polish of an **existing** UI, not a greenfield design. The user already has something on screen and wants it to feel better. Match their energy — if they send a screenshot with one complaint, fix that complaint first; don't redesign the whole thing.

Run the four steps below **in order**. Skip steps that don't apply — but never skip step 1 (audit).

## Scope contract — what this skill will and won't do

**Will:** improve hierarchy, spacing, alignment, copy density, interaction states, typographic balance, and visual finish on the existing screen. Touch the components that produce what's on screen and the styles they inherit.

**Won't:** redesign the entire flow, change the data model, restructure information architecture beyond the current screen, introduce a new visual identity, or add net-new features. Preserve the product's existing intent.

If the request needs any of the "won't" items, stop and route:
- New screen / no concept yet → `frontend-design:frontend-design`
- Subtraction-only ("just cut, don't polish") → `/simplify-ui`
- Correctness audit only ("what would a senior designer catch?") → `/ui-ux-pro-max`
- Craft/feel only ("feels off, doesn't lack soul") → `/make-interfaces-feel-better`

## 1. Audit — look at it, don't guess

Before touching code:
- **Look at the actual screen.** If the user sent a screenshot, use Read on it. Don't edit blind.
- **Measure the complaint.** Read the user's words precisely. "Condense" ≠ "redesign." "Level these out" = fix baseline alignment of specific fields, not every field on the page.
- **Trace the render path.** Find the component(s) that produced what's on screen. Don't assume — grep for the visible strings (section titles, labels, button text) to locate the exact file/line.
- **Capture the surrounding system.** Note what styles the component inherits: global input classes, grid wrappers, parent padding, font families. The bug is usually upstream of the visible element.

Common blind spots to probe:
- A "grid alignment issue" is almost always wrapper-margin mismatch, not the grid itself.
- A "wasted space" complaint is usually `maxWidth` + grid columns + single-field groups compounding.
- A "doesn't feel right" complaint usually points at typographic hierarchy, not color.

## 2. Simplify — subtract first, add never (almost never)

Before adding anything, ask: **what can I remove?**

Remove these first, in priority order:
1. **Redundant containers and wrappers.** One `<div>` can usually replace three.
2. **Subcategory headers for 1-item groups.** "LIABILITY COVERAGE" above a single field burns a row for zero signal. Collapse into the parent.
3. **Helper text that restates the label.** "Enter your email here" under an "Email" field is noise.
4. **Default-zero values displayed as content.** `$0` and `0` with grey styling look like empty state — just leave empty.
5. **Summary/status chips that say what the count already says.** "5 fields required" + a "5/5" badge = one of them goes.
6. **Decorative icons that don't map to action or meaning.** A briefcase next to "Company Information" is decoration; a checkmark next to "Complete" is meaning. Keep meaning, cut decoration.
7. **Multiple font sizes in the same row.** If a label and its chip are different sizes for no reason, they should match.

If something genuinely has to be added, it must carry its weight. A new indicator justifies itself by preventing a user mistake or accelerating a decision; otherwise it's noise.

## 3. Align — everything lives on a grid

Misalignment is mostly caused by **inconsistent margins**, not inconsistent grids. Audit these in order:

1. **Wrapper margins across sibling fields.** If `<DateInput>` returns a div with `mb-3` and `<CurrencyInput>` returns a div with `mb-1.5`, an `alignItems: 'end'` grid will put them at different baselines — by exactly the margin delta. Normalize wrappers before touching the grid.
2. **Input heights across field types.** Date, select, currency, text, and yes/no all need the same `py` value, same `border-width`, same font-size. One `py-3` among a row of `py-2`s looks like a bug to the eye even if the user can't name it.
3. **Label block heights.** Use `min-h-[20px]` on all labels so a 1-line label and a 1-line label-with-chip occupy the same vertical footprint. Labels that wrap to 2 lines *because they have to* are fine; labels that appear to wrap because the column is 20px too narrow are not.
4. **Grid column strategies in the same card.** Don't mix `repeat(3, 1fr)` and `repeat(auto-fill, minmax(260px, 1fr))` in sibling rows — column widths will jump between rows for no reason the user understands.
5. **`align-items`: prefer `end` for forms.** Anchoring inputs to the row's bottom means they line up regardless of how many lines the labels or helper texts above them take.

When a "leveling" complaint comes in, the fix is almost always one of (1) or (2). Check those before rewriting the grid.

## 4. Polish — small things that disproportionately matter

These are low-effort, high-payoff tweaks. Apply them in this order:
- **Sentence-case labels.** "Requested Effective Date" → "Requested effective date" unless the product strongly prefers title case.
- **Tighten the padding scale.** `py-2 px-3` for inputs, `p-3` / `p-4` for cards, `gap-2` / `gap-3` for flex rows. Don't invent new values.
- **Right-size interactive affordances.** Yes/No buttons should match adjacent input heights (same `py`). "Submit" buttons should be one step larger, not three.
- **Consistent green/red semantics.** One accent color for success (`#40C288` / green-100 bg), one for destructive — don't introduce a third.
- **Chip restraint.** If multiple chips can appear on one label ("Auto-filled", "Suggested", "Required"), reserve one color per meaning and hide conflicting combinations (e.g., a "Suggested" chip disappears the moment "Auto-filled" applies).
- **Hover states that mean something.** Border color shift > shadow shift > scale transform. Don't use animation where color communicates the change.
- **Motion only for state changes the user caused.** Page-load staggers are cheap delight; surprise-wiggle on data arrival is usually annoying.

## Opinionated defaults

When the user hasn't specified, default to these and move on:
- **Content width:** 1200px max. Sidebar + main = 220 + 980 with 24–32px gutters. Wider reads as "enterprise app with too many fields"; narrower cramps.
- **Card padding:** `px-4 py-3`. Cards tighter than this feel underbaked; looser feels sleepy.
- **Grid gap between fields:** `12px` horizontally, `12px` vertically. Don't exceed 16px unless there's a strong reason.
- **Typography scale:** label 11–12px semibold, input text 14px regular, body 13px regular, section title 14–15px semibold. Avoid introducing a 4th or 5th size.
- **Borders:** `1px solid` at all times. `border-2` reads as "please notice me" — reserve it for selected/active states, not defaults.
- **Corner radius:** `rounded-lg` (8px) for inputs and cards, `rounded-full` only for pills/avatars.

## Anti-patterns — flag these on sight

- A single-field "section" with its own uppercase header.
- `maxWidth` > 1280 on a form-heavy page.
- `gap: 4` next to `gap: 16` inside the same card.
- `mb-3` on some wrappers and `mb-1.5` on others, in the same grid.
- `border-2` on non-selected default states.
- Helper text that is grammatically a sentence but visually the same size as the label.
- "Auto-filled" and "Suggested" chips shown simultaneously on one field.
- Yes/No buttons noticeably taller than neighboring selects.
- Progress bar counts that include optional fields in the denominator. "X of Y required" is what users actually want.
- Content that expands to fill whatever width it's given (currency inputs stretched to 600px for a 6-digit number).

## Workflow the user sees

1. **Restate the complaint in one sentence** so the user knows you understood. ("Fields don't line up in Coverage Details" — not "let me analyze the UI.")
2. **Diagnose out loud.** Say what's causing it. ("Date wrapper has `mb-3`, currency wrapper has `mb-1.5` — that's the 6px offset.")
3. **Make the minimum edit that fixes it.** Don't bundle unrelated cleanup.
4. **Say what was left alone and why**, if there are obvious nearby things you chose not to touch.
5. **Don't commit** unless the user asked.

## When to escalate

Hand off to a different skill when:
- Request is "design a new X from scratch" → `frontend-design:frontend-design`
- Request is "write a comprehensive spec for the redesign" → `superpowers:writing-plans`
- Request is "this feels bad, but I don't know why" and you've already done a polish pass → ask targeted questions before another round.

## Verification

After edits, state which complaint was addressed and which were not. If the user sent one screenshot showing one row of fields misaligned, don't report "condensed the whole page" — they'll suspect you did more than asked.

If you can run the dev server and re-check visually, do. If you can't (backend-only session, no browser access), say so explicitly: "I can't verify visually — please reload and confirm."
