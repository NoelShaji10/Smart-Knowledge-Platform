# DESIGN.md — Smart Knowledge Platform

**Status**: Active  
**Version**: 1.1  
**Last Updated**: August 2026  
**Scope**: T7 — UI Foundation, Authentication & Workspace Shell

---

## Design Decisions — T7

The following decisions define the visual and interaction direction for the T7 implementation. A coding agent should read this section first.

1. **Content-first, not chrome-first.** The main content area is the visual anchor. Topbar and sidebar recede.
2. **One accent color** (`--accent`). It appears on primary CTAs, active nav indicators, and links. No more than once per viewport.
3. **No gradients, no glassmorphism, no decorative shadows.** Surface hierarchy uses 2–4 LCH lightness steps. Shadows appear only on floating elements (dropdowns, drawers).
4. **Charter serif for document display.** Inter for all UI text. JetBrains Mono for code and metadata. Loaded via `next/font` — no manual Google Fonts `<link>` tags.
5. **15px base font size.** Slightly larger than browser default for reading comfort. 8px grid for all spacing.
6. **URL is authoritative for workspace state.** Active workspace lives at `/workspaces/[workspaceId]`. localStorage stores only UI preferences (sidebar collapsed state). Refresh tokens stay in httpOnly cookies — never localStorage.
7. **CSS custom properties, no framework.** A single global `globals.css` with design tokens. No Tailwind, no CSS-in-JS, no CSS modules for T7. Component classes use a `kp-` prefix.
8. **Sidebar is 240px on desktop, overlay on tablet, drawer on mobile.** Three breakpoints. Sidebar collapse to 48px icon-only mode is optional for T7.
9. **Auth pages are product pages.** Same typography, colors, and spacing. Centered form, no card border or shadow, no decorative elements. Validate on blur. Show inline errors.
10. **Empty workspace = blank page, not dashboard.** No stats, no activity feeds, no illustrations. A heading, a description, and a single CTA to create a document.
11. **"New Document" button is a T7 placeholder.** Visually present in the sidebar and empty state, but non-functional until T8. Implement as a styled button that shows a "coming soon" toast or is visually disabled.
12. **No unnecessary dependencies.** Reuse what the repository already provides: Next.js 14, React 18, TypeScript. Tiptap packages exist in `package.json` but are T8 concerns.
13. **Accessibility is structural, not decorative.** Visible focus rings on every interactive element. Semantic HTML. Keyboard navigation throughout. Reduced-motion support. Contrast ratios meet WCAG AA.
14. **T7 builds the shell. T8 fills it. T9 extends it.** The shell must accommodate document trees, editors, and right-side panels without structural changes, but none of those are built in T7.

---

## 1. Product Visual Direction

A focused document workspace that prioritizes reading and writing over decoration. The interface should feel calm, dense without being cramped, and disappear behind the content. Think of a well-built text editor that happens to have navigation — not a dashboard that happens to have documents.

**Reference qualities** (not visual copies):
- **Notion**: document-oriented workspace, content-first hierarchy
- **Linear**: navigation clarity, information density, keyboard-driven flow
- **Google Docs**: editing focus, minimal chrome around content

**Core feeling**: A serious tool for people who write and think for a living. Every pixel earns its place.

---

## 2. Design Principles

1. **Content dominates.** The main content area is the visual anchor. Navigation and chrome recede.
2. **Typographic clarity first.** Hierarchy comes from type size, weight, and spacing — not color, borders, or cards.
3. **Restraint over expression.** One accent color. No gradients. No glass. No shadows for decoration.
4. **Density with breathing room.** High information density, but generous line-height and padding prevent fatigue.
5. **Keyboard-first navigation.** Every interactive element is focusable. Focus rings are always visible.
6. **Earned complexity.** Add UI only when the user needs it. Empty states guide without decorating.

---

## 3. Color System

### Palette

A neutral-dominant palette with a single cool accent. Designed for long reading sessions — low contrast between surface layers, high contrast for text.

```
--bg:            oklch(0.99 0.002 260)   /* near-white page background */
--surface:       oklch(0.97 0.003 260)   /* sidebar, topbar, elevated surfaces */
--surface-alt:   oklch(0.95 0.004 260)   /* hover states, alternating rows, code blocks */
--border:        oklch(0.91 0.005 260)   /* dividers, subtle boundaries */
--border-strong: oklch(0.85 0.006 260)   /* input borders, focused states */

--fg:            oklch(0.18 0.01 260)    /* primary text */
--fg-secondary:  oklch(0.42 0.01 260)    /* secondary text, labels, timestamps */
--fg-tertiary:   oklch(0.58 0.008 260)   /* placeholders, disabled text */

--accent:        oklch(0.55 0.17 255)    /* primary action, links, active states */
--accent-hover:  oklch(0.50 0.17 255)    /* accent hover — darker, not lighter */
--accent-subtle: oklch(0.95 0.04 255)    /* accent background tint */

--danger:        oklch(0.55 0.2  25)     /* destructive actions, errors */
--danger-subtle: oklch(0.95 0.04 25)     /* error backgrounds */
--success:       oklch(0.55 0.18 145)    /* success states */
--success-subtle: oklch(0.95 0.04 145)   /* success backgrounds */
--warning:       oklch(0.7  0.16 75)     /* warnings, pending states */
--warning-subtle: oklch(0.96 0.04 75)    /* warning backgrounds */
```

### Dark Mode (future-ready)

Define dark tokens as a `[data-theme="dark"]` override. Same hue relationships, inverted lightness. Not required for T7, but the token structure supports it.

### Usage Rules

- **One accent per screen.** Accent appears on: the primary CTA button, the active nav item indicator, and links. No more.
- **Surface hierarchy is subtle.** `--bg` → `--surface` → `--surface-alt` — differences are 2–4 LCH lightness steps, never more.
- **Danger is reserved.** Only for destructive actions (delete workspace, remove member, discard changes). Form validation errors use `--fg` text with a `--danger` border on the failed input — not `--danger` text backgrounds.
- **Never use color alone to convey meaning.** Pair with icon, text, or pattern.

---

## 4. Typography

### Font Stacks

```css
--font-display: 'Charter', 'Bitstream Charter', 'Sitka Text', Cambria, serif;
--font-body:    'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
--font-mono:    'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace;
```

- **Display (serif):** Used for document titles, page headings, and hero text in auth screens. Charter is the primary — a well-hinted serif optimized for screen reading. It is a system font on macOS/iOS and widely available elsewhere; no download required.
- **Body (sans):** Used for all UI text, navigation, labels, form fields. Inter for crisp rendering at UI sizes.
- **Mono:** Used for timestamps, version numbers, code blocks, API responses, and metadata labels.

### Font Loading

Use `next/font` (Next.js built-in optimization) for Inter and JetBrains Mono. Charter is a system font — no loading needed. Do not use manual `<link>` tags for Google Fonts.

```tsx
// In root layout.tsx
import { Inter, JetBrains_Mono } from 'next/font/google';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains' });
```

The `--font-body` and `--font-mono` CSS variables reference these loaded fonts, with the system fallback stacks above as safety nets.

### Type Scale

| Token | Size | Line Height | Weight | Use |
|---|---|---|---|---|
| `--text-xs` | 0.75rem (12px) | 1.5 | 400 | Metadata, timestamps, badges |
| `--text-sm` | 0.8125rem (13px) | 1.5 | 400 | Secondary text, labels, captions |
| `--text-base` | 0.9375rem (15px) | 1.6 | 400 | Body text, form inputs, navigation |
| `--text-lg` | 1.125rem (18px) | 1.5 | 500 | Section headings, sidebar items |
| `--text-xl` | 1.375rem (22px) | 1.4 | 600 | Page titles |
| `--text-2xl` | 1.75rem (28px) | 1.3 | 600 | Auth page headings |
| `--text-3xl` | 2.25rem (36px) | 1.2 | 700 | Document titles in editor (T8) |

**Base font size is 15px** — slightly larger than the 14px browser default for better readability in long-form content.

### Typography Rules

- Document titles use `--font-display`. Everything else uses `--font-body`.
- Never use font-weight below 400 for body text.
- Line-height tightens as font size increases (1.6 at body, 1.2 at display).
- Letter-spacing: normal for body, -0.01em for headings above `--text-xl`.

---

## 5. Spacing Scale

```css
--space-1:  0.25rem   /* 4px  — icon gap, inline spacing */
--space-2:  0.5rem    /* 8px  — tight group gap */
--space-3:  0.75rem   /* 12px — input padding, list item gap */
--space-4:  1rem      /* 16px — section padding, card padding */
--space-5:  1.25rem   /* 20px — between related groups */
--space-6:  1.5rem    /* 24px — section gaps */
--space-8:  2rem      /* 32px — major section breaks */
--space-10: 2.5rem    /* 40px — page-level padding */
--space-12: 3rem      /* 48px — hero spacing */
--space-16: 4rem      /* 64px — auth page vertical rhythm */
```

**8px grid.** All spacing derives from 4px base, with 8px as the dominant rhythm. Components snap to this grid.

---

## 6. Layout System

### App Shell Grid

```
┌──────────────────────────────────────────────────────────┐
│ Topbar (h: 52px)                                         │
├────────────┬─────────────────────────────────────────────┤
│            │                                             │
│ Sidebar    │         Main Content                        │
│ (w: 240px) │         (flex: 1)                           │
│            │                                             │
│            │                                             │
│            │                                             │
│            │                                             │
│            │                                             │
│            │                                             │
│            │                                             │
│            │                                             │
│            │                                             │
└────────────┴─────────────────────────────────────────────┘
```

The topbar spans the full width. The sidebar and main content fill the remaining height below it. Both the sidebar and main content scroll independently — the shell itself does not scroll.

### Content Area

Inside the main content area, document content uses a centered max-width container:

```css
.content-container {
  max-width: 780px;
  margin: 0 auto;
  padding: var(--space-8) var(--space-6);
}
```

This keeps document text at an optimal reading width (~70–80 characters per line). Non-document views (workspace creation, empty states) use the full content width.

---

## 7. Application Shell

### Topbar

```
┌──────────────────────────────────────────────────────────┐
│ [≡] Workspace Name ▾     [⌘K Search]        [Avatar] ▾  │
└──────────────────────────────────────────────────────────┘
```

- **Height**: 52px.
- **Left**: Hamburger (mobile/tablet only, toggles sidebar) + Workspace name with dropdown chevron for workspace switching.
- **Center**: Search trigger — a keyboard-shortcut-accessible search bar. Renders as a subtle pill (`⌘K`) that expands on click/focus. This is a placeholder in T7; the search overlay is a later phase.
- **Right**: User avatar (circle, initials or image) with dropdown for account menu (profile, logout, logout all).
- **Background**: `--surface` with bottom border `--border`. No shadow.
- **Font**: `--text-sm`, `--font-body`, weight 500.

### Sidebar

```
┌──────────────────────┐
│ Workspace Name       │  ← workspace identity
│ Workspace slug       │  ← monospace, --fg-tertiary
├──────────────────────┤
│ Documents            │  ← primary nav (active state)
│ Search               │  ← search nav (placeholder)
├──────────────────────┤
│                      │
│  Documents           │  ← section header
│  No documents yet.   │  ← T7 placeholder text
│                      │
│  + New Document      │  ← T7: visual placeholder (non-functional)
│                      │
├──────────────────────┤
│ [Avatar] Noel        │  ← user section
│   Editor             │    role badge
└──────────────────────┘
```

**Width**: 240px default.

**Sections** (top to bottom):
1. **Workspace identity** — workspace name in `--text-lg` weight 600 + workspace slug in `--font-mono --text-xs --fg-tertiary`. Clickable to open workspace switcher dropdown.
2. **Primary navigation** — Documents, Search. Icons + labels. Active state: left accent bar + `--accent-subtle` background. Settings link appears here in T9.
3. **Document area** — Section header ("Documents" in `--text-xs --fg-tertiary` uppercase) + empty message. In T7, shows "No documents yet." in `--fg-tertiary`. In T8, this becomes the document tree.
4. **New Document** — Ghost button, full width, below the document area. `+` icon + label. In T7, this is visually present but non-functional (see Implementation Guardrails). In T8, it creates a document.
5. **User section** — Avatar + display name + role badge. Fixed to bottom of sidebar. Clickable for account menu dropdown.

**Styling**:
- Background: `--surface`
- Right border: 1px `--border`
- Padding: `--space-3` vertical, `--space-4` horizontal
- Nav items: 32px height, `--space-2` horizontal padding, `--text-base` font
- Active item: left 2px accent bar, `--accent-subtle` bg, `--accent` icon, `--fg` text
- Hover: `--surface-alt` background, 6px border-radius
- Section headers: `--text-xs`, `--fg-tertiary`, uppercase letter-spacing 0.05em, `--space-4` bottom margin

### Content Area States

| State | What Shows |
|---|---|
| **No workspace (user has none)** | Workspace creation form (§10) |
| **Workspace selected, no documents** | Empty state: heading + description + "New Document" CTA (§10) |
| **Workspace with documents** | Document list (T8) |
| **Document open** | Tiptap editor (T8) |
| **Search active** | Search overlay (later phase) |

---

## 8. Sidebar Detail

### Collapsible Behavior

- **Desktop (≥1024px)**: Sidebar is persistent, 240px wide. Can optionally collapse to 48px icon-only mode (see below).
- **Tablet (768–1023px)**: Sidebar is hidden by default. Toggle via hamburger in topbar. Opens as an overlay — does not push content. Backdrop dims content when open.
- **Mobile (<768px)**: Sidebar is a full-height drawer, sliding in from the left over a backdrop overlay. Swipe left or tap backdrop to close.

### Desktop Sidebar Collapse (optional for T7)

The sidebar can be manually collapsed to 48px (icon-only mode) via a toggle button at the bottom of the sidebar. When collapsed:
- Icons remain visible at 48px width.
- Tooltips show labels on hover.
- Toggle button is always visible.

This is optional in T7. The persistent 240px sidebar is the default and sufficient.

### Keyboard Accessibility

- `Tab` order: skip link → topbar → sidebar nav items → main content
- Arrow keys navigate within sidebar nav group
- `Escape` closes sidebar on tablet/mobile
- `Cmd/Ctrl + \` toggles sidebar on desktop (when collapse is implemented)

### Document Area Placeholder (T7)

In T7, the document section shows:

```
Documents
─────────
No documents yet.
```

Plain text, no card. The empty message uses `--fg-tertiary`. The "New Document" button below is visually present but non-functional in T7.

---

## 9. Authentication Pages

### Design Philosophy

Auth pages are the first impression. They must feel like part of the product — not a template. The same typography, colors, and spacing apply. No decorative backgrounds, no gradient washes, no illustrations.

### Routes

- `/login` — Sign in
- `/register` — Create account

Both are public pages. The root layout renders without the app shell (no topbar, no sidebar).

### Layout

```
┌────────────────────────────────────────────────┐
│                                                │
│                                                │
│           ┌──────────────────────┐             │
│           │                      │             │
│           │   Knowledge Platform │  ← wordmark
│           │   ─────────────────  │  ← border divider
│           │                      │             │
│           │   Welcome back       │  ← heading
│           │   Sign in to continue│  ← subtext
│           │                      │             │
│           │   Email              │  ← input
│           │   Password           │  ← input
│           │                      │             │
│           │   [Sign In]          │  ← primary CTA
│           │                      │             │
│           │   Don't have an      │             │
│           │   account? Sign up   │  ← text link
│           │                      │             │
│           └──────────────────────┘             │
│                                                │
│                                                │
└────────────────────────────────────────────────┘
```

- **Centered**, max-width 380px, vertically centered in viewport.
- **No card border or shadow** — the form floats on `--bg`. Separation comes from whitespace.

### Login Page (`/login`)

- **Wordmark**: Product name in `--font-display`, `--text-xl`, `--fg`. Below it, a thin `--border` line, full width, `--space-6` bottom margin.
- **Heading**: `--text-2xl`, `--font-display`, `--fg`. "Welcome back"
- **Subtext**: `--text-base`, `--fg-secondary`. "Sign in to your workspace"
- **Inputs**: Full width. `--text-base` font. `--border-strong` border, 1px. `--space-3` vertical padding, `--space-4` horizontal. Border-radius: 6px. Height: 40px.
  - **Label**: `--text-sm`, `--fg-secondary`, weight 500. Above the input.
  - **Focus**: `--accent` border, `--accent` outline ring (2px, offset 2px).
  - **Error**: `--danger` border. Error message below in `--danger`, `--text-sm`.
  - **Disabled**: `--fg-tertiary` text, `--surface-alt` background.
- **Primary button**: Full width. `--accent` background, white text. `--text-base`, weight 500. `--space-3` vertical padding. Border-radius: 6px. Height: 40px.
  - **Hover**: `--accent-hover` background.
  - **Active**: Background darkens further (+0.10 LCH).
  - **Loading**: Replace text with spinner. Button opacity drops to 0.7. `aria-busy="true"`.
  - **Disabled**: Opacity 0.5, `cursor: not-allowed`.
- **Error state**: API errors (wrong password, network failure) display as inline message between the form fields and the button. `--danger` text, `--text-sm`. For rate-limited requests (HTTP 429), show "Too many attempts. Please try again later."
- **Link**: "Don't have an account? Sign up" — `--accent` text. "Sign up" is the clickable portion.

### Register Page (`/register`)

Same layout as login, with:
- **Heading**: "Create your account"
- **Subtext**: "Start collaborating with your team"
- **Fields** (in order): Display Name, Email, Password
- **Password requirements**: Shown below the password field as `--text-sm`, `--fg-secondary`. Lists: "At least 8 characters". Text turns `--success` when the requirement is met. Requirements update on blur, not on every keystroke.
- **Link**: "Already have an account? Sign in"

### Validation Behavior

- Validate on blur (not on every keystroke).
- Show error below the specific field that failed.
- On form submit, if any field is invalid, focus the first invalid field.
- Server-side errors (duplicate email, weak password) display as inline errors below the relevant field.
- Network errors display as a general message between form and button.

### Post-Auth Redirect

- Successful login → redirect to the user's most recent workspace. If the user has no workspaces, redirect to workspace creation (§10).
- Successful register → auto-login → same redirect logic as login.
- The redirect target is determined by the API response (which includes workspace membership data), not by localStorage.

---

## 10. Workspace Experience

### First Visit (No Workspace)

When a user has no workspace memberships:

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│           Knowledge Platform                         │
│           ─────────────────                          │
│                                                      │
│           Create your first workspace                │
│           to get started.                            │
│                                                      │
│           Workspace Name                             │
│           ─────────────────────────────────          │
│                                                      │
│           [Create Workspace]                          │
│                                                      │
└──────────────────────────────────────────────────────┘
```

- Centered, same card-free layout as auth.
- Wordmark + divider (same as auth pages).
- Heading: `--text-xl`, `--font-display`.
- Single input: workspace name (same styling as auth inputs).
- Single CTA: "Create Workspace" (primary button).
- Validation: name required, max 100 characters (matching backend schema).
- On success → redirect to `/workspaces/[newWorkspaceId]`.
- No workspace templates, no onboarding wizard.

### Workspace Landing (T7)

When a workspace exists but has no documents:

```
┌──────────────────────────────────────────────────────────┐
│ Topbar                                                   │
├────────────┬─────────────────────────────────────────────┤
│            │                                             │
│ Sidebar    │       Your workspace is ready.              │
│            │                                             │
│            │       Create your first document to         │
│            │       start writing.                        │
│            │                                             │
│            │       [New Document]                        │
│            │                                             │
│            │                                             │
└────────────┴─────────────────────────────────────────────┘
```

- **Not a dashboard.** No stats, no activity feeds, no card grids, no onboarding checklist.
- **Message**: `--text-lg`, `--fg`, weight 500. Centered vertically and horizontally in the content area.
- **Description**: `--text-base`, `--fg-secondary`. Below the heading.
- **CTA**: Primary button, centered below the description. In T7, this is non-functional (see Implementation Guardrails). In T8, it creates a document.
- **Max-width**: The content is inside a centered container, max-width 480px, so the text doesn't stretch across the full width.

### Workspace Routing

The active workspace is determined by the URL:

```
/workspaces/[workspaceId]
```

- On login, if the user has exactly one workspace, redirect directly to it.
- If the user has multiple workspaces, redirect to the most recently accessed one.
- If the user has no workspaces, redirect to workspace creation (which renders at `/` or `/workspaces/new`).
- The workspace switcher in the topbar navigates between workspaces by changing this URL segment.

---

## 11. Responsive Behavior

### Breakpoints

| Name | Width | Sidebar | Topbar |
|---|---|---|---|
| Mobile | <768px | Drawer (slides over content) | Hamburger, name (truncated), avatar |
| Tablet | 768–1023px | Overlay (240px, left-anchored) | Hamburger, name, search, avatar |
| Desktop | ≥1024px | Persistent (240px) | Full layout, no hamburger |

### Mobile (<768px)

- **Sidebar**: Full-height drawer from left. 280px max-width (85% of viewport). Backdrop overlay. Swipe left or tap backdrop to close.
- **Content**: Full width with `--space-4` horizontal padding (reduced from desktop `--space-6`).
- **Auth pages**: Same centered layout. Input font-size 16px (prevents iOS auto-zoom on focus).

### Tablet (768–1023px)

- **Sidebar**: Hidden by default. Opens as overlay (240px wide, left-anchored, full height, subtle shadow on right edge). Backdrop dims content. Does not push content.
- **Content**: Full width when sidebar closed.

### Desktop (≥1024px)

- **Sidebar**: Persistent, 240px, border-separated from content.
- **Content**: Fills remaining width.

---

## 12. Component Language

### Buttons

| Variant | Use | Styling |
|---|---|---|
| **Primary** | One per viewport. Main CTA (Sign In, Create). | `--accent` bg, white fg, `--text-base` weight 500, 6px radius, 40px height, 16px horizontal padding. |
| **Secondary** | Alternative actions (Cancel). | `--surface` bg, `--fg` text, 1px `--border` border, same dimensions as primary. |
| **Ghost** | Inline actions, sidebar items, tertiary actions. | Transparent bg, `--fg` text. Hover: `--surface-alt` bg. |
| **Danger** | Destructive actions only (delete workspace, remove member). | `--danger` bg, white fg. Same dimensions as primary. Used exclusively in confirmation dialogs. |

**Button states**:
- **Default** → **Hover** (bg darkens +0.06 LCH) → **Active** (bg darkens +0.10 LCH) → **Focus** (accent ring, 2px, offset 2px) → **Disabled** (opacity 0.5, `cursor: not-allowed`)
- Primary button hover darkens the accent — never lightens. This prevents the "wash out" effect.

### Inputs

- **Height**: 40px.
- **Padding**: 12px horizontal, 8px vertical.
- **Font**: `--text-base`, `--font-body`.
- **Border**: 1px `--border-strong`, 6px radius.
- **Focus**: 1px `--accent` border + `--accent` outline ring (2px, offset 2px).
- **Error**: 1px `--danger` border. Error text below in `--danger`, `--text-sm`.
- **Disabled**: `--surface-alt` bg, `--fg-tertiary` text.
- **Label**: Above the input. `--text-sm`, `--fg-secondary`, weight 500. `--space-2` bottom margin.
- **Helper text**: Below the input. `--text-sm`, `--fg-tertiary`. Replaced by error text on validation failure.

### Dropdowns / Menus

- Trigger: Button or clickable element.
- Panel: `--surface` bg, 1px `--border` border, 8px radius, `--space-1` shadow (0 4px 12px oklch(0 0 0 / 0.08)).
- Items: 32px height, `--space-3` horizontal padding, `--text-base` font. Hover: `--surface-alt` bg.
- Active item: `--accent-subtle` bg, `--accent` text.
- Dividers: 1px `--border`, `--space-2` vertical margin.
- Keyboard: Arrow keys navigate, Enter selects, Escape closes. Focus returns to trigger on close.

### Dialogs / Modals

- Backdrop: `oklch(0 0 0 / 0.4)`. No blur.
- Panel: `--surface` bg, 12px radius, max-width 440px, centered.
- Header: `--text-lg`, weight 600, `--space-6` horizontal padding, `--space-4` top padding.
- Body: `--text-base`, `--fg-secondary`, `--space-6` horizontal padding.
- Footer: Right-aligned button group. `--space-6` horizontal padding, `--space-4` vertical padding, top border `--border`.
- Focus trap: First focusable element receives focus on open. Tab cycles within dialog. Escape closes. Focus returns to trigger on close.

### Avatars

- Circle. 32px default (24px small, 40px large).
- Background: `--accent-subtle`. Initials: `--accent`, `--text-sm` weight 600.
- Image: `object-fit: cover`.
- Presence indicator (future): 8px circle, bottom-right, offset 2px. `--success` for online.

### Badges

- Small inline labels. `--text-xs`, weight 500.
- Background: `--surface-alt`. Text: `--fg-secondary`. Border-radius: 4px. `--space-1` horizontal padding, `--space-0.5` vertical.
- Role badges (Owner, Admin, Editor, Viewer): Same style, content-driven.

### Tooltips

- Background: `--fg` (dark), white text.
- `--text-sm`, 200ms delay on hover, 100ms on subsequent moves.
- Max-width: 240px, 8px radius.
- Tooltips are supplementary — never the sole carrier of essential information.

### Loading Skeletons

- `--surface-alt` base with a subtle shimmer animation (left-to-right gradient sweep, 1.5s infinite).
- Rectangular blocks matching the shape of the content they replace.
- Height matches the line-height of the content being replaced.
- Border-radius: 4px.
- For full-page loading, use a centered spinner (24px, `--accent` color) — not a full-page skeleton.

### Empty States

- Centered vertically and horizontally in the content area.
- Heading: `--text-lg`, weight 500, `--fg`.
- Description: `--text-base`, `--fg-secondary`, max-width 360px.
- CTA: Primary button below description.
- No illustrations, no decorative icons.

### Error States

- **Page-level error**: Centered. `--text-lg` heading ("Something went wrong"), `--text-base` description, "Try again" primary button.
- **Inline error**: `--danger` text, `--text-sm`. Placed below the failed element.
- **Network error toast**: Bottom-right. `--danger-subtle` bg, `--danger` icon + text. Auto-dismiss after 5s.

### Toast Notifications

- Bottom-right corner. Max-width 380px.
- Background: `--surface`, 1px `--border`, 8px radius, `--space-1` shadow.
- Content: Icon (16px) + message text (`--text-sm`).
- Variants: Success (`--success` icon), Error (`--danger` icon), Info (no icon, `--fg-secondary` text).
- Auto-dismiss: 5s for success, 8s for error, persistent for info.
- Stacking: New toasts push old ones up. Max 3 visible at once.

---

## 13. Interaction States

### Focus

Every focusable element must have a visible `:focus-visible` ring:

```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

- Never use `outline: none` without providing an alternative focus indicator.
- Focus ring color is `--accent`, 2px, offset 2px — consistent across all elements.
- For elements inside `--surface` backgrounds, the accent ring provides sufficient contrast.

### Hover

- Background shifts by +0.06 on the OKLch L channel (darkens on light surfaces).
- Border color may darken by one step.
- Never change foreground to `--fg-tertiary` or lighter on hover — this reduces contrast.

### Active / Pressed

- Background shifts by +0.10 on L channel.
- No scale transform — keep buttons stable.

### Disabled

- Opacity: 0.5.
- `cursor: not-allowed`.
- No hover/active visual states.
- Reduced contrast is acceptable only for disabled elements.

### Loading

- Button: Replace label text with a 16px spinner. Maintain button dimensions. `aria-busy="true"`.
- Page: Centered spinner (24px, `--accent` color) with optional "Loading…" text below.
- Content replacement: Use skeleton blocks matching the shape of the expected content.

---

## 14. Accessibility

### Keyboard Navigation

- All interactive elements are focusable in logical DOM order.
- Skip link: "Skip to main content" — first focusable element on page. Visually hidden until focused.
- `Tab` moves forward, `Shift+Tab` moves backward.
- Arrow keys navigate within composite widgets (sidebar nav, dropdown menus).
- `Escape` closes overlays (dialogs, dropdowns, sidebar on mobile/tablet). Focus returns to the trigger element.
- `Enter`/`Space` activates buttons and links.

### Focus Management

- On page navigation: focus moves to the new page's `<h1>` or main heading.
- On dialog open: focus moves to the first focusable element inside the dialog.
- On dialog close: focus returns to the element that opened the dialog.
- On sidebar open (mobile/tablet): focus moves into the sidebar. On close, focus returns to the hamburger button.

### ARIA

- `role="navigation"` with `aria-label` on sidebar and topbar nav.
- `role="main"` on content area.
- `aria-label` on all icon-only buttons (hamburger, search, close).
- `aria-expanded` on collapsible sidebar toggle.
- `aria-current="page"` on active sidebar nav item.
- `aria-live="polite"` on toast container and form error regions.
- `aria-describedby` linking inputs to their helper/error text.
- `aria-busy="true"` on buttons during loading state.

### Contrast Ratios

| Element | Minimum Ratio |
|---|---|
| Body text (`--fg`) on `--bg` | 7:1 (AAA) |
| Secondary text (`--fg-secondary`) on `--bg` | 4.5:1 (AA) |
| Tertiary text (`--fg-tertiary`) on `--bg` | 3:1 (AA Large) |
| Accent text on `--bg` | 4.5:1 (AA) |
| Border on `--bg` | 3:1 (AA Large) |
| Focus ring on any background | 3:1 (AA Large) |

### Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

### Screen Reader

- All images have `alt` text. Decorative images use `alt=""`.
- Form inputs have associated `<label>` elements (not placeholder-only labels).
- Error messages are linked via `aria-describedby` and announced via `aria-live`.
- Page transitions are announced via an `aria-live` region.

---

## 15. Future UI Considerations

### T8 — Document Tree & Tiptap Editor

- **Document tree** replaces the placeholder text in the sidebar document area. Nested list with expand/collapse.
- **Tiptap editor** fills the content area. Toolbar appears above the editor. Document title is editable, using `--font-display` at `--text-3xl`.
- **Breadcrumbs** may appear above the editor for nested documents: `Workspace > Folder > Document`.
- **The shell accommodates T8 without structural changes.** The sidebar document area and main content area are designed for these additions.

### T9 — Version History, Permissions & Archive

- **Version history**: Slide-out panel from the right of the content area. 320px width. Timeline of versions with restore buttons.
- **Permission management**: Modal dialog for setting document-level permissions. User search + role selector.
- **Archive**: "Archived" badge on documents. Archive section in sidebar (collapsible). Restore action in document context menu.
- **The shell accommodates T9 without structural changes.** Right-side panels and modals are standard patterns already defined in §12.

### Later Phases

- **Real-time presence**: Cursor indicators in the editor, user avatars in the topbar.
- **Search overlay**: `⌘K` opens a centered search modal (command palette style).
- **AI assistant**: Slide-out panel or inline suggestions in the editor.

---

## 16. T7 / T8 / T9 Scope Boundaries

### T7 — What Gets Built

- Design system tokens (CSS custom properties in `globals.css`)
- Root layout with topbar and sidebar shell
- `/login` page with form, validation, error states
- `/register` page with form, validation, error states
- Authentication state (JWT access token in memory, httpOnly refresh cookie managed by API)
- API client (fetch wrapper with auth headers, automatic token refresh, redirect on 401)
- Workspace context and URL-based routing (`/workspaces/[workspaceId]`)
- Workspace creation page (`/workspaces/new` or `/` when user has no workspaces)
- Sidebar with navigation, document placeholder, user section
- Workspace switcher dropdown (topbar)
- User/account menu dropdown (topbar) — profile info, logout, logout all
- Empty states (no workspace, workspace with no documents)
- Loading states (page spinner, button spinners, skeleton blocks)
- Error states (page-level error, inline form errors, toast notifications)
- Responsive layout (mobile drawer, tablet overlay, desktop persistent)
- Focus management and keyboard navigation
- Reusable UI primitives: Button, Input, Dropdown, Avatar, Badge, Toast, Skeleton

### T7 — "New Document" Button Scope

The "New Document" button appears in two places in T7:
1. **Sidebar**: Ghost button below the document area placeholder.
2. **Empty workspace content area**: Primary button as the empty-state CTA.

In T7, **both buttons are non-functional**. They are visually styled and keyboard-focusable, but they do not create documents. When clicked in T7, they should either:
- Be visually disabled (`opacity: 0.5`, `cursor: not-allowed`, `aria-disabled="true"`), or
- Show a toast notification indicating the feature is coming soon.

The implementation agent should choose the simpler approach (disabled state) unless there is a strong reason for the toast.

### T8 — What Does NOT Get Built in T7

- Document tree component
- Tiptap editor integration
- Document CRUD UI (create, rename, delete)
- Document editing interactions
- Breadcrumbs
- Editor toolbar
- Yjs/CRDT client integration

### T9 — What Does NOT Get Built in T7

- Version history panel
- Permission management dialog
- Archive/restore UI
- Audit log viewer
- Workspace settings page

---

## 17. Implementation Guardrails

The following constraints apply to the T7 implementation. Violating any of these requires explicit user approval.

### Must Not

- **Do not create a dashboard-style homepage.** The workspace landing is a document workspace, not a analytics dashboard.
- **Do not add gradients, glassmorphism, or decorative shadows.** The visual language is flat and restrained.
- **Do not invent new backend API endpoints.** Use the existing API routes in `apps/api-server/src/routes/` as-is. The frontend must work with the existing auth, workspace, and document endpoints.
- **Do not implement T8 or T9 functionality.** No document CRUD, no editor, no version history, no permission management UI.
- **Do not store refresh tokens in localStorage.** Refresh tokens are managed exclusively via httpOnly cookies set by the API server.
- **Do not store the active workspace ID in localStorage as the source of truth.** The URL (`/workspaces/[workspaceId]`) is authoritative. localStorage may store UI preferences only (e.g., sidebar collapsed state).
- **Do not introduce unnecessary dependencies.** No new npm packages unless absolutely required. The existing stack (Next.js 14, React 18, TypeScript) is sufficient for T7.
- **Do not modify backend code.** The backend (API server, auth, database, workers) is complete and must not be altered.
- **Do not create UI components solely for decorative purposes.** Every component must serve a functional role.
- **Do not use emoji as functional icons.** Use inline SVG icons or a minimal icon set.
- **Do not implement OAuth/social login.** The backend supports email/password only at this stage.

### Must

- **Use `next/font` for font loading.** Do not use `<link>` tags for Google Fonts.
- **Use CSS custom properties for all design tokens.** Define tokens in `globals.css`, reference them everywhere.
- **Use the `kp-` prefix for all component class names.** This prevents collisions and makes the design system discoverable.
- **Maintain the single accent color discipline.** One accent per viewport — CTA, active nav, links.
- **Support keyboard navigation throughout.** Every interactive element must be focusable and operable via keyboard.
- **Handle all API error states.** Network errors, 401 (redirect to login), 403 (forbidden message), 429 (rate limit message), 500 (generic error).
- **Make the T7 empty state feel like a blank page**, not an empty dashboard.

---

## Next Step

Review this document. Once approved, this becomes the source of truth for building the T7 UI in a subsequent task.
