# Current landing character assets

`tab-hero-tug.png` was created with the built-in image tool from the approved
hero close-up (`codex-clipboard-ee3af883-2d79-4fbb-a729-94440c314b1e.png`).
Source: `exec-541669a8-783a-406f-a9c6-e0c9ce73d388.png`. Prompt: isolate the
reference tugging character, preserve its pose/face, remove the surrounding
UI and external cable, transparent background. This is generated extraction,
not a claim of pixel-identical tracing. It replaces the earlier hero pose.
The sole cable is now SVG and its endpoint follows the glove in the same
550×270 coordinate plane. No cable is baked into this hero asset.

`tab-official-identity.png` is copied byte-for-byte from
`C:/Users/abdua/.codex/skills/small-scrool-2d-characters/assets/tab-character-sheet.png`.
The current runtime crops its original pointing, cheering and peeking poses.

`tab-official-scenes-v2.png` was generated with the built-in image tool, using
`codex-clipboard-30d422f7-f737-41a5-83d6-990f3f3a6b3c.png` as the identity reference.
Source output: `exec-c859ec31-9dbb-45d1-b190-6730fd712e6c.png`.
Prompt: preserve the exact browser-window body, three header dots, original
oval eyes, navy limbs, white gloves and sneakers; no separate torso; six
transparent 512px cells in a 2-column/3-row sheet: cable tug, sitting pointer,
pointing, cheering, paper-plane rider, peeking. The runtime uses its sitting and paper-plane cells only. The exact generation prompt is preserved
in this chat's image tool call. No CLI/API fallback was used.

`tab-reference-scenes.png` and the earlier saved motion sheets are retained
but no longer referenced by ScrollCompanion. The hero panels/cables and gather
illustration are local DOM/SVG, not screenshots of the design reference.

# Tab 2D sprite assets

These three transparent atlases are copied without pixel changes from the
existing user-owned Tab reference implementation identified by the
`small-scrool-2d-characters` skill:

`C:/Users/abdua/Documents/Codex/2026-09-30/new-chat/outputs/tabweb-react/public/assets/`

- `tabweb-mascot-motion.png`: welcome/blink poses.
- `tabweb-mascot-run.png`: running loop.
- `mascot-wave-24.png`: wave loop.

Source crop coordinates are retained in
`src/features/landing/source-atlases.json` (only the three used actions).
The scheduler/rendering integration is local to this repository; no service,
third-party model request, or 3D asset is required at runtime.

## Product illustration panels — 2026-11-04

`reference-product-panels.png` (1024×1536) was generated using the built-in
image tool, source output `exec-a37cea74-26af-4e66-a4c2-ecf9992636aa.png`.
Reference: user-approved `codex-clipboard-ab7d4b0e-832b-4e72-b4a7-28e54eb869fa.png`.
Prompt: extract/restoratively reproduce the four original UI illustrations:
academy browser + overlapping phone, lesson graph + curriculum, weekly calendar
+ attendance, and homework + result bars; preserve composition, palette and
Arabic labels; omit surrounding marketing copy and mascots; transparent atlas.
No CLI fallback. Actual panel boundaries are recorded in ReferencePanel.tsx;
we do not assume equal rows because the generated composition differs.
These are visual reconstructions, not pixel-identical crops or real tenant data.

## Rejected full-section raster experiment — 2026-11-04

`approved-reference.png` is an unchanged copy of the user-supplied
`codex-clipboard-05c02056-3cf2-45f4-9c3f-36b541ae3f75.png` (1024×1536).
It is retained as reference evidence only. The full-section SVG image windows
were rejected and removed; no page sections render this file. Marketing text,
controls, section layout, gather backdrop and cables are HTML/CSS/SVG again.

## Vector panel replacement

The generated product atlas is no longer rendered. `ReferencePanel.tsx` now
contains locally authored SVG shapes and Arabic labels. They follow the approved
composition but are redrawn, not pixel-identical original artwork.

## Local display font

`fonts/BalooBhaijaan2-ExtraBold.ttf` is the 800-weight Baloo Bhaijaan 2 font
from Google Fonts (fonts.gstatic.com, family version v21). The accompanying
`fonts/OFL.txt` is the license from google/fonts/ofl/baloobhaijaan2. This font
is used only for the landing display headings and is served locally.

## tab-seated-v3.png
Generated with built-in imagegen on 2026-11-04 from tab-official-identity.png.
Purpose: transparent seated pose for academy browser ledge and pinned feature deck.
Prompt: Preserve the original top-left browser-tab mascot face, navy header and
three white dots, eyes, blue rim, white gloves and sneakers. One centered 2D
transparent character sitting on an invisible horizontal ledge, hands planted,
knees bent, short shins dangling, no rendered ledge, text, shadow or 3D styling.
Original generated file: C:/Users/abdua/.codex/generated_images/01a1214f-af59-7ad3-b048-c37bab938a72/exec-8d0cf718-ada9-4ce0-aff9-f979cb21747e.png.

## tab-peek-edge-v1.png
Generated with built-in imagegen on 2026-11-05 using the supplied mascot reference. Transparent 2D peeking pose with two white gloves gripping a vertical edge; no legs or horizontal crop. Used only on the final CTA, anchored by its grip line to the white card border.
