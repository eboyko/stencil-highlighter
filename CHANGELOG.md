# Changelog

This project follows Semantic Versioning. The OMP package and the Tern plugin always carry the same version.

| Item                | Value                  |
| ------------------- | ---------------------- |
| OMP package version | `package.json`         |
| Tern plugin version | `tern/plugin.toml`     |
| Format              | Keep a Changelog 1.1.0 |

## [0.3.0] - Unreleased

### Changed

- Supports OMP `^19.2.0` (19.2.0 to below 20.0.0). The Comments button is a right-aligned keyed widget below the editor, so other extensions can add controls without replacing it or the composer.
- Tern 0.9.35 is the verified version for this migration, not an established minimum requirement.

### Fixed

- Restored the Comments button and capture in the original session when another extension cancels a session switch, regardless of extension order.
- Preserved Tern's native pinned action row in the Comments dialog.
- Preserved the Edit and Send all shortcut hints and used the host's key formatter for their tooltips.
- Lowered the labels on the Comments footer buttons to center them within their outlines.

## [0.2.1] - 2026-11-18

### Fixed

- Alt+C uses the physical C key, so switching keyboard layouts no longer changes the capture shortcut.

## [0.2.0] - 2026-11-15

### Added

- The Tern plugin captures a selection from a git view. The batch names the open file, the selected commit and a diff flag, and the comment joins the Comments group of that file.

## [0.1.0] - 2026-11-10

First public release.

### Added

- The Tern plugin captures a selection from a file, a terminal or an agent chat with Alt+C and passes it to the OMP extension in the same tab.
- File capture reads the pane's own buffer, including remote and unsaved files. It falls back to the clipboard only when exact line endings cannot be proven.
- The OMP extension stores comments per session in a local SQLite database that only the owner can read.
- The Comments dialog lists comments by source, filters them, and opens a detail view to edit or delete a comment.
- The detail view shows the original quote first and the comment after it.
- Sending is explicit. The whole session batch goes to the agent as one message: steering when the agent is idle, a follow-up when it is busy.
- Each note in the batch is a fenced quote followed by the comment. The fence's info string carries the language and the source attributes for the agent.
