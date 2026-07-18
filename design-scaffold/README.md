# AB Agent — portal design scaffold

A self-contained Next.js (App Router) + Tailwind scaffold that reproduces the
core UI for the **AB Agent** platform. Everything here is
design/layout only — pages are placeholders you fill in later.

## What's inside

- **Icon sidebar** — fixed, 56px wide, dark navy (`#0B1628`). Icon buttons
  highlight in the brand color on hover/active and a **tooltip label appears on
  hover** (200ms delay) and disappears when you move away.
- **Top bar** — fixed, 56px tall, page title + centered search box + avatar.
- **Pages** — Overview (homepage), Page Two, Page Three, Upload, Settings.
- **Settings** — same two-level layout as the original app: a 240px section
  sidebar with tabs (Personal preferences, Profile, Integrations, Email
  Templates, Data Fields, Users), each showing placeholder content.
- **Brand color** — `#3D38FF` (change once in `tailwind.config.ts` +
  the components that use it inline; see "Change the brand color" below).

## Run it

```bash
npm install
npm run dev
# open http://localhost:3000  → redirects to /overview
```

## File map

```
app/
  layout.tsx          # wraps every page in <AppShell>
  page.tsx            # "/" redirects to /overview
  overview/page.tsx   # homepage (placeholder)
  page-two/page.tsx   # placeholder
  page-three/page.tsx # placeholder
  upload/page.tsx     # placeholder drop zone
  settings/page.tsx   # renders <SettingsShell>
  globals.css         # fonts + scrollbar
components/
  AppShell.tsx            # sidebar + topbar + content offset
  layout/Sidebar.tsx      # the 56px icon rail + hover tooltips
  layout/TopBar.tsx       # top bar
  layout/SectionSidebar.tsx # reusable 2nd-level sidebar
  layout/SettingsShell.tsx  # settings tabs + placeholder content
  ui/Card.tsx
  ui/PagePlaceholder.tsx  # reusable "title + skeleton blocks" body
lib/
  navigation.ts       # <-- edit sidebar items here
```

## Add / rename a sidebar page

1. Add an entry to `lib/navigation.ts` (`key`, `label`, `path`, `icon`).
2. If you used a new icon name, import it and add it to `iconMap` in
   `components/layout/Sidebar.tsx`.
3. Create `app/<path>/page.tsx`.

## Change the brand color

The brand color `#3D38FF` lives in:
- `tailwind.config.ts` → `colors.accent`
- inline in `components/layout/Sidebar.tsx` (active/hover background)
- inline in `components/layout/SectionSidebar.tsx` (active left border)
- inline in `app/upload/page.tsx` and `components/layout/SettingsShell.tsx`

Find/replace `#3D38FF` across the project to change it everywhere.
