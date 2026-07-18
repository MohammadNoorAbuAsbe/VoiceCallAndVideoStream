# GitHub Copilot — Code Illusion Agent Annotation Standard

This project uses the **Code Illusion De-tangler** VS Code extension. It shows a side-by-side
"De-cluttered View" of code: original on the left, collapsed semantic micro-cards on the right. The
cards are written by **you (the coding agent)**, not by a heuristic.

## Mandatory rule

Place an inline `@illusion` comment directly above every function, method, class, `try` block, and
significant loop you add or edit:

```
@illusion: <human-readable summary of what this block does>
```

- Describe **intent** in plain verbs / data flow: `fetch -> transform -> save`.
- One line, short. Comment sits directly above the block.

Language styles: `// @illusion:` (JS/TS/Java/C#/Go/Rust), `# @illusion:` (Python), `<!-- @illusion: -->` (HTML).

## When to annotate

1. **Adding code** — annotate every new block.
2. **Editing code** — update the annotation if behavior changed.
3. **Touching existing code** — if a block lacks `@illusion`, add one. Use
   `Code Illusion: Scaffold Annotations` / `Check Coverage` to find gaps, then fill in real wording.
   Never commit `<TODO ...>` placeholders.
4. **Never delete** an annotation unless the block is deleted too.

## Helper commands

- `Code Illusion: Open De-cluttered View`, `Check Coverage`, `Scaffold Annotations`, `Init Agent Rules`.

Full spec and examples: see `AGENTS.md`.
