---
name: make-interfaces-feel-better
description: Craft-and-feel polish for an interface that already works correctly and is already simple. Use when the user says "feels off", "feels clunky", "not quite right", "doesn't feel polished", "lacks soul", "feels cheap", "add some life to it", "make it feel expensive", "feels like AI slop", or wants motion/typography/microcopy/color work that isn't about fixing bugs or alignment. This is the vibes layer — assumes correctness and subtraction are already handled. If the screen is broken or cluttered, route to /ui-ux-pro-max or /simplify-ui first. Complements frontend-design:frontend-design (creative vision) but is scoped to tuning what exists.
---

# Make interfaces feel better — the craft layer

This skill is for the pass where the interface already *works* and is already *simple*, but still feels mediocre. You are tuning emotion, not structure. If the user hasn't had the basics fixed yet, recommend `/ui-ux-pro-max` and `/simplify-ui` first; great feel on top of a broken layout is lipstick.

## The diagnostic

Before touching anything, ask yourself what specific feeling is off. Interfaces usually fail one of five feels:

1. **Cheap** — cramped, low-contrast, unbranded, no texture, inconsistent.
2. **Cold / clinical** — correct but soulless. Efficient but no character.
3. **Heavy / laggy** — transitions stutter, state changes snap, nothing feels alive.
4. **Disorganized** — elements fight for attention; no clear visual hierarchy.
5. **Nervous / fussy** — too many animations, too many chips, too many accent colors.

The fix for each is different. Name the feeling first, then apply the matching lever below.

## Levers — in order of impact-per-minute

### 1. Typography (highest leverage)

- **Pair a display face with a body face.** One distinctive (Playfair, Fraunces, Söhne, Tiempos, Inter Display) + one refined (Inter, Figtree, Söhne, IBM Plex, Geist). Don't use Inter for everything.
- **Use the display only at top levels** — page title, card titles ≥ 18px. Everything else body.
- **Tighten line-height on display** (1.1–1.2) and loosen on body (1.5–1.65).
- **Letter-spacing for uppercase** — eyebrows and section labels get `letter-spacing: 0.05em` or more.
- **One tabular-nums for numeric data** — `font-variant-numeric: tabular-nums` on any column of amounts makes them snap into alignment.

### 2. Color & contrast

- **One dominant color, one accent, one destructive. No fourth.**
- **Backgrounds are off-white or off-black, never pure.** `#F7F8F6`, `#0B0D0A` — feel warmer than `#FFFFFF` / `#000000`.
- **Shadows with color** — `box-shadow: 0 2px 12px rgba(brand-color, 0.08)` feels branded; `rgba(0,0,0,0.08)` feels generic.
- **Gradients only on one element at a time.** Usually the primary CTA or the hero. Gradients everywhere = AI-slop.

### 3. Motion

- **Page-load stagger is cheap delight.** 40–80ms stagger on cards/rows hitting the viewport; nothing fancier.
- **Easing: `cubic-bezier(0.22, 1, 0.36, 1)` for enter/exit.** Not `ease-in-out`.
- **200–280ms for small transitions, 400–600ms for modals/layouts.** Outside that range feels wrong.
- **Never animate what the user didn't cause.** Auto-pulsing "new" badges are hostile.
- **Respect `prefers-reduced-motion`** — drop transitions to 0.01s, keep only opacity/color changes.

### 4. Microcopy

- **Button verbs specific to the action.** Not "Submit" — "Send quote for review."
- **Empty states with personality.** "No quotes yet. Start one — it takes about 3 minutes." Beats "No data."
- **Error messages that acknowledge** — "That's not quite right — X needs to be Y" rather than "Invalid input."
- **Success states that celebrate proportionally.** Saved draft = small checkmark. Bound a policy = confetti-adjacent.
- **Loading copy that sets expectations.** "Matching you with carriers… usually 5 seconds" > spinner alone.

### 5. Texture & depth

Not every interface needs these, but they're how screens stop feeling generic:
- **Noise overlay at 2–4% opacity** on dark backgrounds. Kills the plastic look.
- **Subtle inner shadow on inputs** — `inset 0 1px 0 rgba(255,255,255,0.4)` on light themes suggests depth.
- **Asymmetric card padding** — e.g., `24px 24px 20px 24px` sometimes feels better than all-24 because humans scan top-to-bottom.
- **Left-align eyebrow decoration** — a 2px × 18px accent-color rule before a section label reads as editorial, not chrome.

### 6. The small details

- **Focus rings that feel on-brand** — `box-shadow: 0 0 0 3px rgba(brand, 0.2)` beats the default blue browser ring.
- **Checkmark animation on save** — 300ms stroke-dash reveal, not a static green dot.
- **Hover states that change border color**, not scale or shadow (which feel toy-like on dense forms).
- **Caret-color matched to brand.** `caret-color: var(--brand)`.
- **Chip alignment with inline icons** — baseline-align the icon to the text, don't center — centering looks off for small text.

## What to avoid (AI-slop tells)

- Purple-to-pink gradients on white.
- "Gradient text" for things that aren't hero titles.
- Emoji in UI chrome (buttons, headers).
- `font-family: 'Inter', sans-serif` as the only typeface.
- Drop-shadows the same size on cards, buttons, and modals (varied elevation is the whole point).
- Buttons with `border-radius: 9999px` that are 32px tall (pill at small scale reads as "claimed to be premium, actually built in 20 min").
- Glass-morphism backdrops without a real background image behind them.

## Workflow

1. **Name the feel.** In one sentence, write what's wrong. "Feels cheap because inputs have no shadow and everything is pure white on pure white." This grounds the rest.
2. **Apply at most 3 levers from the list above.** Do not touch everything — diminishing returns.
3. **Reload and look away and back.** Judge fresh, not against your memory of before.
4. **Name one thing you resisted adding.** This keeps you honest — feel upgrades are often about resisting maximalism, not piling it on.
5. **Show the user which levers you pulled** and invite them to push back on any that felt wrong.

## Red flags during the pass

If you catch yourself adding:
- A new color variable that isn't in the design system
- A third weight of the display font
- An animation > 600ms
- A shadow on a default-state button
- An emoji inside a form label

…stop. You're adding where you should be tuning.

## Interactions

- Runs best on a screen that already passed `/ui-ux-pro-max` and `/simplify-ui`.
- Can safely coexist with `/ui` for a combined sweep.
- If the user wants a redesign, escalate to `frontend-design:frontend-design`.
