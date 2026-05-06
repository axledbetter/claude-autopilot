---
name: simplify-ui
description: Ruthless subtraction pass on an existing UI — visual/UX reduction only. Use when the user says "cut it down", "too much going on", "too cluttered", "remove noise", "pare down", "less is more", "it's too busy", or wants the page trimmed without rebuilding it. This is the "remove before adding" lens — complementary to /ui (full polish pass), /ui-ux-pro-max (correctness audit), and /make-interfaces-feel-better (craft layer). For code-level deduplication, use the plugin /simplify instead.
---

# Simplify — remove before you add

You are looking at a UI and cutting what doesn't earn its place. The default answer is **delete**. Every element has to justify why it survives. If you can't state its purpose in a short sentence, it goes.

## The guiding question

For every visible element on the screen, answer:

> "What would break for the user if this weren't here?"

If the answer is "nothing" or "aesthetics", delete it. If the answer names a concrete user failure, keep it — and then see if it can be smaller.

## What to cut, in priority order

### Tier 1 — cut without thinking

1. **Section headers above single-item sections.** "LIABILITY COVERAGE" over a single field is structural vanity.
2. **Helper text that restates the label.** "Enter your email address" under an "Email" field. Pick one.
3. **Placeholders that duplicate labels.** Ditto.
4. **Status pills identical to adjacent counts.** "5/5" badge next to a "5 of 5 complete" progress bar.
5. **Default-zero values displayed as content.** `$0`, `0%`, `null` — render as empty.
6. **Decorative icons** that don't carry meaning or affordance. Briefcase next to "Company" is ornament.
7. **Explanatory captions** for patterns the user already knows ("Click Submit to submit").
8. **"Powered by…" footers on internal tools.**
9. **Animated spinners on < 200ms operations.** They flash and look broken.

### Tier 2 — cut after a second look

1. **Duplicate buttons.** "Save" at top and bottom of a form — keep one, usually the bottom if the form is long.
2. **Multiple paths to the same action.** A "Create quote" primary button + a "+" FAB + a "New quote" menu item.
3. **Breadcrumbs on 2-level-deep pages.** Overkill; use a back button.
4. **Card shadows stacked on card borders.** Pick one.
5. **Grid lines *and* alternating row backgrounds.** Pick one.
6. **Count/progress indicators that update instantly.** If the user answered the field, they know.
7. **Summary sentences above tables** that restate what the table shows. ("This table shows quotes. There are 3 quotes.")
8. **Emoji or flag icons** next to text that already says the same thing.
9. **Confirmation dialogs for non-destructive actions.** "Save draft?" — just save.

### Tier 3 — cut with caution (verify with the user)

1. **Tooltips on self-explanatory controls.** If the icon is standard (× for close), no tooltip needed — unless a11y is the reason.
2. **Onboarding hints that persist after first use.**
3. **Tutorial steps that could be inferred from labels.**
4. **Analytics-only elements** that don't serve the user (tracking pixels belong in code, not chrome).

## What not to cut (hold the line)

- Labels, even when obvious — they are your a11y surface.
- Error messages — always keep; tune the copy under `/make-interfaces-feel-better`.
- Validation — never cut; maybe defer to blur instead of on-change.
- Skip links and screen-reader-only text.
- The single "Undo" or "Back" that lets users recover.

## Density rules after simplification

Once you've cut:
- **3–6 fields per card.** Fewer = sleepy; more = oppressive.
- **One accent color dominant per card.** Not one per chip.
- **At most 2 type sizes per card** (label + input/value). Title of the card is the third.
- **One CTA per screen region.** Multiple = the user has to choose, and they'd rather not.
- **Zero horizontal scroll.** If the layout forces it on common widths, the layout is wrong.

## Workflow

1. **Screenshot or open the screen.** Read every visible string. Don't cut blind.
2. **List every distinct element.** Cards, headers, chips, buttons, helper text, icons, images.
3. **Mark each: keep / cut / reduce.** "Reduce" means the element stays but smaller/shorter/less prominent.
4. **Cut Tier 1 items immediately.** No discussion.
5. **Surface Tier 2/3 cuts as proposals** to the user before applying.
6. **After the cut, measure.** Did vertical density improve? Did the primary action get more visible? If neither, you cut the wrong things.

## Micro-patterns

- **Collapse single-field sections into the parent card.** Don't delete the field, delete the section wrapper.
- **Merge two adjacent chips with the same color into one.** "Required + Auto-filled" → "Auto-filled (required)".
- **Replace "X of Y" with "Y - X remaining"** when remaining is what the user cares about.
- **Fold secondary actions into an overflow menu (⋯).** Don't show 5 buttons when 1 primary + ⋯ works.
- **Use whitespace as a divider** before reaching for a `<hr>` or border.

## Red flags that you're over-cutting

- Users can't tell which field is required.
- A keyboard-only user can't move through the form.
- A screen-reader user can't distinguish regions.
- The page looks like a wireframe, not a product.
- You removed something and then had to re-add it in the next session.

## Interactions

- Runs best after `/ui-ux-pro-max` (knows what's broken) and before `/make-interfaces-feel-better` (which adds back *quality*, not noise).
- Combine with `/ui` for a full pass in one shot.
- Do not run on a screen that's already minimalist — you'll cut into muscle.

## One rule above all

> Every element survives by earning its pixel count.

If you wouldn't fight to keep it at the next design review, delete it now.
