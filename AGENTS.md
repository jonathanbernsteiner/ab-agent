# Tests — run before and after changing pipeline code

`npm test` runs the real import/matching/store/export pipeline against
`fixtures/` (in-memory Supabase stand-in, no Docker/network). `npm run typecheck`
must stay clean. See the "Automated tests" section in `README.md`. Six
extraction tests run the real Claude read and skip unless `ANTHROPIC_API_KEY` is
set — set it to verify the Hartmann prose-price finding end-to-end. Keep the
fixture ground truth (`fixtures/expected/*.json`) as the source of truth; never
hardcode extraction results.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Design system — read before building any page

This project has a design system. Before building or restyling any page or UI,
read `design-scaffold/DESIGN_PROMPT.md` and reuse the layout components in
`design-scaffold/components/` and `design-scaffold/lib/navigation.ts`.
Do not reinvent the layout, colors, spacing, or radii — match the scaffold.

Key facts (see the brief for the full spec):
- Brand/accent `#3D38FF` (press `#312EE0`), sidebar rail `#0B1628`, app bg
  `#F5F5F5`, cards `#FFFFFF`, borders `#E2E8F0`. Font DM Sans. Radius 8px
  buttons/inputs, 12px cards.
- Fixed 56px icon sidebar (left) + 56px top bar; pages render inside `<AppShell>`.
  Sidebar items live in `lib/navigation.ts`.
- Reuse `ui/Card.tsx`, `ui/PagePlaceholder.tsx`, `layout/SectionSidebar.tsx`;
  icons from `lucide-react`.

OPEN DECISION (resolve before the first real build): the scaffold is hand-rolled
Tailwind with **no** component library, but the app in `src/` was set up with
**shadcn/ui**. Pick one — port the scaffold's layout into `src/` (drop shadcn) or
adapt the design onto shadcn — before building pages, so the two don't diverge.
