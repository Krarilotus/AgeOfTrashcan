# Repository Agent Rules

## UI Encoding Safety

- Preserve all existing UI emoticons and special symbols in labels/buttons/cards.
- Never run bulk text rewrites on UI source files (`src/App.tsx`, `src/ui/*.tsx`) that re-encode content.
- Prefer minimal diffs with exact string preservation for UI text.
- After UI edits, verify no mojibake artifacts exist (for example: `Ã`, `â`, `ðŸ`, `Â` in rendered strings).
