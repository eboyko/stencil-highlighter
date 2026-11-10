# Changelog

This project follows Semantic Versioning. The OMP package and the Tern plugin always carry the same version.

| Item                | Value                  |
| ------------------- | ---------------------- |
| OMP package version | `package.json`         |
| Tern plugin version | `tern/plugin.toml`     |
| Format              | Keep a Changelog 1.1.0 |

## [Unreleased]

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
