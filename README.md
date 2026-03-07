# Skir Language Support for Visual Studio Code

This extension provides language support for the Skir language - a declarative language for representing data types, constants and APIs (similar to Protocol Buffer).

**Website:** https://skir.sh

## Features

- **Syntax highlighting** for `.skir` files
- **Diagnostics** — lexical, parse, type and breaking-change errors shown inline
- **Go to definition** — navigate to any symbol or imported module
- **Hover documentation** — shows the doc comment of a record, field, method or constant
- **Find all references** — lists every usage of a symbol across the workspace
- **Rename symbol** — renames a symbol and all its references in one step (local symbols only)
- **Auto-completion** — context-aware suggestions for field names, types, constants and more
- **Automatic imports** — suggests symbols from other modules and inserts the import statement automatically
- **Format on save** and on-demand formatting
- **Import updates on file rename/move** — when a `.skir` file is renamed or moved, the extension offers to update all import statements that reference it
- **Comment toggling** — line (`//`) and block (`/* */`) comments
- **Bracket matching and auto-closing pairs**

## Skir Language

Skir is a language for representing data types, constants and APIs. It is designed for systems where different services are written in different languages but need to exchange structured data.

Example:

```skir
// shapes.skir

struct Point {
  x: int32;
  y: int32;
  label: string;
}

struct Shape {
  points: [Point];
  /// A short string describing this shape.
  label: string;
}

const TOP_RIGHT_CORNER: Point = {
  x = 600,
  y = 400,
  label = "top-right corner",
};

/// Returns true if no part of the shape's boundary curves inward.
method IsConvex(Shape): bool = 12345;
```

## Go to Definition

Navigate to the definition of any symbol or import path:

- Place the cursor on a symbol name or an import path and press **F12** (or right-click → *Go to Definition*).
- Works across files within the same Skir workspace.

## Hover Documentation

Hovering over a record, field, method or constant shows the doc comment attached to that declaration.

## Find All References

Place the cursor on any symbol and press **Shift+F12** (or right-click → *Find All References*) to see every location in the workspace that references it.

## Rename Symbol

Place the cursor on a symbol name and press **F2** (or right-click → *Rename Symbol*) to rename it and all its references atomically. Renaming is only supported for symbols defined in the current workspace; symbols from external dependencies cannot be renamed.

## Diagnostics

The extension continuously validates your files and reports errors in the Problems panel:

- **Lexical and parse errors** — syntax mistakes in `.skir` files.
- **Type errors** — unknown types, missing fields, etc.
- **Breaking changes** — when a `skir-snapshot.json` is present, any change that would break existing consumers (e.g. removed fields, changed types) is highlighted as a warning.
- **Dependencies out of sync** — a warning on `skir.yml` when the installed packages do not match the declared versions; run `npx skir gen` to fix.

## Auto-Completion

Press **Ctrl+Space** (or **⌃Space** on macOS) at any point in a `.skir` file to get context-aware suggestions:

- Field names and their expected types inside struct or constant literals.
- Type names (records, enums) visible in the current scope.
- Import paths when writing an `import` statement.

Suggestions are derived from the current state of all modules in the workspace, so they stay up to date as you edit.

## Automatic Imports

When you press **Ctrl+Space** on an unqualified symbol name, the extension also suggests symbols from modules that are not yet imported in the current file. Selecting such a suggestion automatically inserts the corresponding import statement at the top of the file:

```skir
import { Point } from "geometry.skir";
```

## Formatting

Documents are formatted automatically on save. You can also trigger formatting manually with **Shift+Alt+F** (or right-click → *Format Document*).

## Import Updates on File Rename / Move

When you rename or move one or more `.skir` files (for example via the VS Code Explorer), the extension detects that other files in the same workspace may have import statements pointing to the old path. It then shows a prompt:

> **Update imports in N file(s)?** — *Update Imports* / *Skip*

Choosing **Update Imports** rewrites the import block in every affected file so that paths reflect the new file location. The update is applied atomically as a single workspace edit, so it can be undone in one step with **Ctrl+Z**.

This also handles bulk operations: if several files are moved together (e.g. an entire directory), cross-references between the moved files are updated correctly, in addition to references from files that stayed in place.

## Requirements

No special requirements for this extension.
