# Editor UX Fix

[한국어](README.ko.md)

Fold and unfold lines in the Obsidian editor with long-press, clicks, and the mouse wheel.

## Features

- **Long-press (0.4 s) a line to fold or unfold it.** On a line with no children, the nearest line above that contains it (parent list item or heading) folds. Moving more than 4 px while pressing starts a normal drag selection instead. A small ring next to the mouse fills up while you hold; it only appears where the long-press would do something.
- **Click exactly where the caret already is to fold or unfold that line.** Nothing happens on a line with no children. A click that brings focus back to the editor doesn't count.
- **Alt+wheel steps the line under the mouse one level at a time**: up unfolds, down folds. Each step unfolds the shallowest visible folded level, or folds the deepest visible unfolded level, within that line and its children; the last fold step folds the line itself. Nothing happens on a line with no children (its parent and siblings are left alone).
- **Right-button+wheel works like Alt+wheel** (Windows only). The context menu doesn't open when you release the button. macOS and Linux open the menu on press, so they aren't supported.
- **Wheel left of the text works like Alt+wheel without Alt.** "Left of the text" means the left margin, indentation, list markers, numbers, checkboxes, and heading `#`. The wheel never scrolls there (Shift+wheel still scrolls sideways).
- **Click left of the text to fold or unfold that line**, like the fold chevron: the caret and focus stay put, and nothing happens on a line with no children. No drag selection starts there.
- **Long-press left of the text to fold the line's parent**, even if the line has children (the line itself if it has no parent). This folds the block you're in even when its first line is scrolled out of view.
- Hovering left of the text tints the line and its children and shows a pointer cursor (while the left-of-text wheel or click setting is on).
- **Fold all / unfold all buttons in the view header** (next to the reading view toggle). Fold all folds every level, hidden ones included, so unfolding later still finds the inner levels folded. A button is dimmed when there is nothing to do; both are hidden in reading view.
- When the wheel, a long-press, or a click folds or unfolds, the line under the mouse stays at the same height on screen (or the folded line that now contains it).
- Moving the caret never unfolds anything. CodeMirror still unfolds when the caret lands inside hidden text (for example, from search).
- Each behavior can be turned off in the settings. The settings and buttons are in English, or Korean when Obsidian is set to Korean.
- Desktop only.

Folding needs Obsidian's **Fold indent** and **Fold heading** settings (Settings → Editor) turned on.

## Install

From Obsidian: Settings → Community plugins → Browse, search for "Editor UX Fix".

Manually: copy `main.js`, `manifest.json`, and `styles.css` from the latest release into `<vault>/.obsidian/plugins/editor-uxfix/`, then enable the plugin in Settings → Community plugins.

## Build

```
npm install
npm run build
```
