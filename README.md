# VimiumObs

A Vimium-FF–style keyboard layer for Obsidian. It gives you two modes:

- **Reading mode** (the Vimium layer — the default): every note opens in Reading view. Scroll with `j`/`k`, jump around with `f` click-hints, and never touch the mouse.
- **Editing mode**: press `i` to drop into the editor, where Obsidian's built-in **Vim** key bindings take over. **Double-press `Escape`** to come back to Reading mode.

![Click hints shown over links, tabs, and the file tree after pressing `f`](assets/hints.png)

## Keybindings (Reading mode)

| Key | Action |
| --- | --- |
| `f` | Show click hints; type the letters to click that element (links, buttons, tabs, ribbon, file tree, checkboxes…). |
| `Shift`+`F` | Same hints, but open the chosen link in a **new tab**. |
| `j` / `k` | Scroll down / up. |
| `d` / `u` | Scroll a half-page down / up. |
| `g g` / `Shift`+`G` | Jump to top / bottom. |
| `Shift`+`J` / `Shift`+`K` | Switch to the next / previous tab. |
| `o` | Open the quick switcher (jump to another note). |
| `p` | Open the command palette. |
| `i` | Enter editing mode (focus the editor; native Vim active). |
| `Esc` `Esc` | (In editing mode) return to Reading mode. |

While hints are showing: type the label to activate, `Backspace` to correct, `Esc` to cancel. Holding `Shift` on the **last** letter of a label opens that target in a new tab (even if you started with plain `f`).

## How the modes map to Obsidian

The plugin ties "command mode" to Obsidian's **Reading view** rather than a fragile focus heuristic. It forces every note to open in Reading view (toggleable in settings) and turns on Obsidian's native Vim key bindings, so `i` lands you in a real Vim editor. Both overridden settings are restored when you disable the plugin.

The double-Escape exit is timing-based: the first `Esc` is left for Vim (insert→normal); a second `Esc` within the timeout (default 400 ms, configurable) flips the note back to Reading view.

## Settings

Hint characters, hint font size, scroll step, force-Reading-view toggle, native-Vim toggle, double-Escape timeout, mode-indicator toggle, and the list of CSS selectors that become hint targets.

## Build

Requires Node.js (18+).

```bash
npm install
npm run dev      # esbuild watch → main.js
npm run build    # type-check + production bundle
```

## Install into a vault

Copy (or symlink) `manifest.json`, `main.js`, and `styles.css` into:

```
<your-vault>/.obsidian/plugins/vimium-obs/
```

Then enable **VimiumObs** under Settings → Community plugins (turn on community plugins first if needed).

For active development, symlink the repo so each rebuild is picked up:

```bash
ln -s "$(pwd)" "<your-vault>/.obsidian/plugins/vimium-obs"
```

…and reload Obsidian (or use the Hot-Reload plugin) after each build.

## Verify it works

1. Open any note → it appears in **Reading view**.
2. `j`/`k` scroll; `d`/`u` half-page; `gg`/`G` top/bottom; `Shift`+`J`/`Shift`+`K` switch tabs.
3. Press `f` → hint letters appear over links/buttons (in the note **and** on tabs/ribbon/file tree); type a label to click it; `Esc` cancels. `Shift`+`F` opens the link in a new tab.
4. Press `i` → the note switches to the editor, focused, with native Vim (`h j k l`, `i` to insert).
5. Double-press `Esc` → back to Reading mode.
6. Typing in the search box is **not** hijacked by `j`/`k`/`f`.
