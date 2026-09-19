# PersonaTools

A SillyTavern extension for enhanced persona management: folders, tags and a quick persona switcher — in one extension that plays nicely with SillyTavern's own pagination, search and sorting.

## Features

### 🎭 Quick Persona Switcher
- Circular avatar button next to the chat input for fast persona switching
- Instant search box (appears when you have more than a handful of personas)
- Folders shown as expandable groups; the folder holding your current persona auto-expands
- Full keyboard support: type to search, ↑/↓ to move, Enter to select, Esc to close
- Current persona highlighted with a checkmark
- Styled hover tooltips with persona name and title
- Avatar images follow native image updates, including slash-command updates

### 📁 Persona Folders
- Organize personas into folders with names and descriptions
- Folder cards at the top of the Persona Management panel, with stacked avatar previews and member counts
- Works *with* SillyTavern's pagination, search box, sorting and grid view — folder contents paginate natively, and searching always searches all personas
- Breadcrumb header inside a folder with back button and quick edit
- Rename folders (renaming onto an existing folder merges them), edit descriptions, add/remove personas
- Deleting is a two-click inline confirmation — no browser popups
- Failed list refreshes show a retry action while preserving the requested folder and page

### 🏷️ Persona Tags
- Create colored tags and assign them to personas
- Tag text automatically switches between dark and light for readability on any color
- Collapsible tag filter bar with usage counts and AND-filtering (shows personas matching *all* selected tags)
- Click a tag chip on any persona card to toggle that filter
- Explicit tag deletion (two-click confirm) — tags are never auto-deleted behind your back
- Random color generator with light/dark palette toggle

### ⚡ Fast
v2.0.0 is a ground-up rewrite. Instead of cloning and hiding SillyTavern's persona cards, PersonaTools now hooks into SillyTavern's own persona filter, so the native list stays native. No polling timers, no cache-busted avatar re-downloads, no retry ladders — everything reacts to SillyTavern's events and renders once.

## Installation

### Method 1: SillyTavern Extension Installer
1. Open SillyTavern
2. Go to Extensions > Install Extension
3. Paste this URL: `https://github.com/LukaTheHero/SillyTavern-PersonaTools`
4. Click Install

### Method 2: Manual Installation
1. Navigate to your SillyTavern extensions folder:
   - Third-party: `SillyTavern/public/scripts/extensions/third-party/`
   - Or user data: `SillyTavern/data/default-user/extensions/`
2. Clone or download this repository into that folder
3. Restart SillyTavern

Requires SillyTavern 1.18 or newer.

## Important: Disable Conflicting Extensions

If you have any of these extensions installed, **disable them** before using PersonaTools to avoid conflicts:

- **Quick Persona** (Extension-QuickPersona)
- **Personas** (SillyTavern-Personas)
- **Persona Tags** (PersonaTags)

PersonaTools replaces all three and will automatically migrate your existing folder groups and tags on first load.

## Data Migration

On first launch, PersonaTools automatically imports:
- **Folder groups** from the Personas (SillyTavern-Personas) extension
- **Tags and tag assignments** from the Persona Tags extension

Upgrading from PersonaTools 1.x keeps all your folders, tags and descriptions — the settings format is unchanged.

Existing PersonaTools tags and assignments are preserved. Legacy tags are imported only when both the PersonaTools tag list and assignment map are empty. The import prefers PersonaTags data in SillyTavern's extension settings, with historical root settings as a fallback, and keeps each source's tags and assignments together. Completed migrations are not run again.

## Development checks

The browser regression suite loads the actual `index.js` as a browser module, matching SillyTavern's extension loader, together with `style.css` in a minimal fixture. The fixture supplies host settings, filtering, pagination, persistence, native grid classes, drawer and keyboard behavior, and controlled asynchronous avatar requests. Synthetic cacheable avatar images test image updates through the browser's real HTTP cache. Background chat shortcuts only increment test counters. The suite does not require or modify an installed SillyTavern profile.

With a current Node.js LTS release installed, run:

```sh
npm ci
npx playwright install chromium
npm run check
npm test
```

`npm run check` checks every JavaScript file in the repository root, `tests`, and `scripts`, including the Playwright configuration and spec files. It uses Node's syntax checker and skips dependency and generated-output directories. Shared browser helpers handle fixture loading and paint waits without filling in omitted seed settings; tests also fail on uncaught browser exceptions. Expected request failures remain covered through the extension's error handling.

Playwright is a development-only dependency; normal extension installation does not require npm packages. Use `npm run test:headed` to watch the browser. The test server binds to `127.0.0.1:4179`; that port must be free. If Chromium is already installed in a custom Playwright browser cache, set `PLAYWRIGHT_BROWSERS_PATH` to that directory before running the tests instead of installing another copy.

Failure traces are saved in the ignored `test-results/` directory and can be opened with `npx playwright show-trace <trace.zip>`. Fixture tests cover migration, filtered-list updates, folder navigation, popover keyboard focus, quick-switcher request cancellation, and folder-description persistence. A browser smoke check in SillyTavern 1.18 or newer is still recommended for changes to native pagination, sorting, grid layout, persona lifecycle, or locks, because the fixture does not recreate the entire host application.

## Credits

PersonaTools is built upon the work of:
- [Extension-QuickPersona](https://github.com/SillyTavern/Extension-QuickPersona) by Cohee1207
- [SillyTavern-Personas](https://github.com/Furitaocanon/SillyTavern-Personas) by Desespoir
- [Persona Tags](https://github.com/Samueras/PersonaTags) by Samueras

## License

This project is licensed under the GNU General Public License v3.0 — see the [LICENSE](LICENSE) file for details.

## Author

**LukaTheHero** — [GitHub](https://github.com/LukaTheHero)

## Screenshots

Screenshots below V2.0.0

<img width="1914" height="1155" alt="image" src="https://github.com/user-attachments/assets/f810154b-80c9-45a3-b8c5-dc660e607183" />
<img width="880" height="872" alt="image" src="https://github.com/user-attachments/assets/e955e42d-dfe4-4a17-b21c-7416cb1c03fe" />
<img width="600" height="548" alt="image" src="https://github.com/user-attachments/assets/bc6b7d93-d3bf-4aee-9002-3fe7059e907b" />
<img width="535" height="715" alt="image" src="https://github.com/user-attachments/assets/f73aa3de-0b92-4d1e-8836-611201ec7131" />
<img width="587" height="413" alt="image" src="https://github.com/user-attachments/assets/1a9bc051-70c8-4b8e-be09-e5667a4073fa" />

