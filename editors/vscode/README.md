# Szigyr VS Code Extension (Minimal Viewer)

Minimal zero-dependency VS Code extension for viewing and navigating `.szigyr` files:

- TextMate syntax highlighting (`source.szigyr`, including `"use rt"` / `"use owned"` / `"use unsafe"` directives, numeric/ownership/FFI types, contracts, and `// szigyr-equivalent` annotations)
- Live `szigyr lsp` client providing diagnostics, type/capability hover, go-to-definition (including across imports), document symbols, and quick-fix code actions

## Usage

### Run in Extension Development Host

```bash
code --extensionDevelopmentPath=/path/to/szigyr/editors/vscode
```

### Install Locally (Symlink)

```bash
ln -s /path/to/szigyr/editors/vscode ~/.vscode/extensions/szigyr
```

If `szigyr` is not on `PATH` and you open a project outside the `szigyr` repository, set `"szigyr.lsp.command"` in VS Code settings (for example `"/path/to/szigyr/packages/compiler/src/cli.ts"` or a wrapper script in `PATH`).
