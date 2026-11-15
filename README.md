# Skill Tree

See yourself as an RPG character. Skill Tree turns plain checklists in your notes into skill trees and constellations — branches, prerequisites, what you know, what you are learning and what is unlocked next.

There is no XP, no levels and no scores. Real progress is not a number; the tree only shows *where you are* and *what is next*.

## Features

- **Main map**: every branch, its constellations and cross-branch *legendary* skills on one screen. Brighter constellations = more skills known.
- **Branch trees**: one tree per branch, either all at once or one constellation at a time.
- **Four layouts** shared by the map and the trees: ▲ up (Skyrim-like), ◎ star, ↓ top-down, → left-right.
- **Prerequisites without spaghetti**: a skill needs *all* (`A & B`) or *any* (`A | B`) of other skills. Hover a skill to highlight what it requires.
- **Available skills glow** when their requirements are met.
- Click any node to open the note at that line. Pan by dragging, zoom with the wheel.
- Remembers the last opened tree, layout and constellation.
- English and Russian interface (follows Obsidian's language).

## Quick start

1. Install and enable the plugin.
2. Run the command **Skill Tree: Create example tree** (or press the button in the empty view).
3. Open the view from the ribbon icon or **Skill Tree: Open**.

## Data format

```
Skills/                    ← skills folder (configurable)
├── Map.md                 ← map center + legendary skills (optional)
├── Programming/           ← a branch = a subfolder
│   ├── Programming.md     ← branch root note
│   ├── Backend.md         ← a constellation
│   └── Frontend.md
└── Physical/
    └── ...
```

### Branch root note

```markdown
---
type: branch
description: Everything about writing software
---
```

### Constellation note

Every checkbox is a skill. Plain bullets under a skill are its description and notes.

```markdown
---
type: branch
parent: "[[Skills/Programming/Programming|Programming]]"
---

- [x] SQL — I design schemas and write queries
- [x] PHP
- [/] Laravel
	- requires:: PHP
	- First plain bullet is the description
	- Other bullets show up as notes in the tooltip
- [ ] Performance tuning
	- requires:: SQL & Laravel
- [ ] Microservices
	- requires:: Laravel | Go

## Testing
- [ ] Unit tests
	- requires:: Laravel
```

- `requires:: A & B` — needs all of them; `requires:: A | B` — needs any of them (`требует::` works too).
- A skill hangs under its first requirement from the same constellation; requirements from other places are only highlighted on hover.
- `## Headings` inside a constellation make sub-groups.
- `Name — description` on the checkbox line is a shortcut for a description.

### Statuses

| Checkbox | Status |
| --- | --- |
| `- [x]` | ✅ known |
| `- [/]` | 🔥 learning |
| `- [>]` | ✨ want |
| `- [ ]` | 🔒 locked |
| `- [*]` | ⭐ mastered |

A locked or wanted skill whose requirements are known is shown as **🔓 available**.

### Map note

```markdown
---
type: map
center: "Me · Engineer"
---

- [ ] Full-stack Architect
	- Designs whole systems end to end
	- requires:: Performance tuning & Frontend:State management
```

Top-level checkboxes are legendary skills. Requirements are looked up across all branches; use `Branch:Skill` when two branches have a skill with the same name.

## Settings

- **Skills folder** — where branches live (default `Skills`).
- **Map file** — the map note inside that folder (default `Map.md`).

## Installation

Until the plugin is in the community list, install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat) or manually: download `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/skill-tree/`, then enable it in **Settings → Community plugins**.

## License

[MIT](LICENSE)
