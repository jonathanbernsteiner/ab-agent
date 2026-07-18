# AB Agent — design handoff prompt

Paste the block below to the AI/coding assistant in your new project. It tells
it exactly how the design works so it matches this scaffold when building pages.

---

You are building **AB Agent**, a web app on **Next.js (App Router) + Tailwind CSS**.
Follow this design system exactly. The base layout components already exist in
`components/` and `lib/navigation.ts` — reuse them, do not restyle them.

**Brand**
- Main / accent color: `#3D38FF` (used for active + hover states, primary
  buttons, key icons). Darker press state: `#312EE0`.
- Sidebar background (dark rail): `#0B1628`
- App background: `#F5F5F5` / surface `#F9FAFB`; cards are white `#FFFFFF`
- Borders: `#E2E8F0`. Primary text `#0F172A`, secondary text `#64748B`,
  muted `#94A3B8`.
- Font: **DM Sans** (already imported in `app/globals.css`).
- Corner radius: 8px for buttons/inputs, 12px for cards.

**Layout (fixed, do not change)**
- A **56px-wide icon sidebar** fixed on the left (`components/layout/Sidebar.tsx`),
  dark navy. Nav items are icon-only 40×40 buttons that fill with `#3D38FF` on
  hover/active; a small dark tooltip label appears to the right on hover (200ms
  delay) and hides on mouse-leave.
- A **56px-tall top bar** fixed across the top (`components/layout/TopBar.tsx`):
  page title on the left, centered search box, avatar on the right.
- Page content sits inside `<AppShell>` with `margin-left: 56px; padding-top: 56px`.
- Sidebar items live in `lib/navigation.ts`. To add a page: add an entry there,
  add its icon to `iconMap` in `Sidebar.tsx`, and create `app/<path>/page.tsx`.

**Two-level (section) layout — used by Settings**
- Reuse `components/layout/SectionSidebar.tsx`: a 240px inner sidebar, gray
  background, uppercase heading, active item = white card with a 2px `#3D38FF`
  left border + subtle shadow. Use this pattern for any page that needs sub-tabs.

**Components to reuse**
- `components/ui/Card.tsx` — white rounded card (radius 12, 1px `#E2E8F0` border).
- `components/ui/PagePlaceholder.tsx` — title + skeleton blocks; use for any page
  not yet built.
- Icons: `lucide-react`.

**Rules**
- Match the existing spacing, colors, radii, and font. Do not introduce a
  component library (no shadcn/MUI) — keep the hand-rolled Tailwind + inline-style
  approach already used in `components/`.
- Every new page must render inside `<AppShell>` (it already wraps everything via
  `app/layout.tsx`).

Now build: **[describe the page or feature you want here]**.

---

## How to use this prompt

1. Copy everything between the two `---` lines above into your new project's AI.
2. Replace the last line's `[describe the page...]` with what you actually want,
   e.g. "Build the Overview page with 4 stat cards and a recent-activity list."
3. Because the layout components are already in the repo, the AI will slot new
   pages into the existing sidebar/topbar design instead of reinventing it.
