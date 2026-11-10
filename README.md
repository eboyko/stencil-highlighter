# Stencil Highlighter

Stencil Highlighter collects comments on text selected in Tern and sends them to an OMP agent as one message. It is one feature in two parts. Both parts ship together under one version.

| Part               | Directory | Install on                              | Responsibility                                                       |
| ------------------ | --------- | --------------------------------------- | -------------------------------------------------------------------- |
| Tern window plugin | `tern/`   | The computer displaying the Tern window | Capture selected text and its source with Alt+C, then pass it to OMP |
| OMP extension      | `omp/`    | The host running OMP, local or remote   | Store, edit and explicitly send comments                             |

Adding comments from a selection requires both parts. The OMP extension alone still manages previously saved comments through the comments command. The Tern plugin alone reports a missing OMP extension on every capture. OMP has no standalone chat capture. Stencil Highlighter does not depend on any other extension.

| Item             | Value                                |
| ---------------- | ------------------------------------ |
| Comments command | `/comments`                          |
| Specification    | [SPECIFICATION.md](SPECIFICATION.md) |

Every label, hint, toast and error message is a hard-coded English string.

## Requirements

OMP supplies its SDK at run time. Storage uses the SQLite module built into Bun. No runtime dependency or agent tool is needed.

| Component | Version or module                                              |
| --------- | -------------------------------------------------------------- |
| Tern      | 0.9.12                                                         |
| OMP       | 18.18.3 or a later 18.x release; tests run against SDK 18.18.5 |
| SQLite    | `bun:sqlite`                                                   |

The development dependencies serve only tests, type checking and formatting. They pin the SDK, TypeScript, the Bun type definitions and Biome. Git ignores the installed dependency directory.

| Item                                            | Value           |
| ----------------------------------------------- | --------------- |
| `@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-tui` | 18.18.5         |
| `typescript`                                    | 7.0.2           |
| `@types/bun`                                    | 1.4.4           |
| `@biomejs/biome`                                | 2.6.6           |
| Ignored directory                               | `node_modules/` |

## Installation

### From a checkout

Run the commands from the repository root. On the computer running the Tern window, link the Tern part:

```sh
tern plugin link "$PWD/tern"
```

On the computer running OMP, link the package once for the current user:

```sh
omp plugin link "$PWD" --scope user
```

New OMP sessions load the extension automatically through the extensions entry of the package manifest.

| Manifest key     | Entry            |
| ---------------- | ---------------- |
| `omp.extensions` | `./omp/index.ts` |

A link follows changes in the checkout. Do not move or delete the checkout while using it.

After changing extension source, start a fresh OMP process. The OMP plugin reload command refreshes the plugin catalog but does not replace a module that is already imported. After changing Tern plugin files, reload the Tern plugin.

| Command                                  | Effect                                                       |
| ---------------------------------------- | ------------------------------------------------------------ |
| `/reload-plugins` in OMP                 | Refreshes the plugin catalog, keeps already imported modules |
| `tern plugin reload stencil-highlighter` | Reloads the Tern plugin files                                |

When OMP runs remotely, copy the Tern directory to the computer running the Tern window and link that local copy.

If Tern reports that Stencil Highlighter is already installed, do not overwrite that installation blindly. Use its existing plugin directory, or migrate it to the checkout explicitly before linking.

Installing creates a copy, while linking follows the checkout. Reloading a copied installation does not pick up later source changes. Update an existing managed copy explicitly:

```sh
tern plugin install "$PWD/tern" --force
```

Attached hosts also contribute global plugin sheets. When replacing an old stylesheet, update the Stencil Highlighter installation on those hosts as well.

### For one OMP run

The command below loads the extension for one OMP run only. Its first flag disables other extensions, which isolates this one. Omit that flag to compose the extension with other composer extensions.

```sh
omp --no-extensions -e "$PWD/omp/index.ts"
```

The OMP package and the Tern plugin id share one name. The capture command id in the [keyboard section](#keyboard) contains it.

| Identifier     | Value                 |
| -------------- | --------------------- |
| OMP package    | `stencil-highlighter` |
| Tern plugin id | `stencil-highlighter` |

## Usage

### Capturing a selection

Select text and press the capture shortcut, or choose the capture command in Tern's command palette. The receiving OMP session must be in the same Tern tab. A selection made in an OMP session goes to that session. Otherwise the last focused OMP session of the tab receives it. Without such a session, a single available session receives it. Several available sessions produce a picker that lists them.

| Item                                           | Value                           |
| ---------------------------------------------- | ------------------------------- |
| Capture shortcut                               | Alt+C                           |
| Command palette entry                          | Comment on selection            |
| Session picker placeholder for a capture       | Which session gets the comment? |
| Session picker placeholder without a selection | Open Comments of which session? |

The capture shortcut without a selection opens the Comments dialog and leaves the layout unchanged. Only a capture moves a glimpse file preview into the layout, which keeps that preview open.

A session without the OMP extension produces an error, never a success notification. Only the OMP extension acknowledges that a comment is saved.

| Situation                                   | Toast text                                              |
| ------------------------------------------- | ------------------------------------------------------- |
| No OMP session in the tab                   | No OMP session available in this tab                    |
| The session runs without this OMP extension | Stencil Highlighter extension not found in this session |
| Passing a selection to the session fails    | Could not pass the selection to the session             |
| Opening the Comments dialog fails           | Could not open Comments                                 |

### Comment field

A capture opens a separate centered field. The field is an untitled overlay that contains only the comment placeholder. Saving creates a comment only from nonblank input. Cancelling, blank input or a session transition leave no comment. The composer draft stays unchanged, and only the comment count increases.

| Item         | Value                               |
| ------------ | ----------------------------------- |
| Overlay role | `stencil-highlighter.comment-input` |
| Placeholder  | Comment…                            |

A new valid capture replaces an open Comments dialog or detail view with the comment field. Existing comments and edits are saved first, and no manual close is needed. Invalid or already saved captures leave the dialog open.

A second capture while the comment field is open does not replace the field. Tern shows an info toast to finish that comment first. Tern shows an info toast as well when the capture shortcut is pressed while a file capture is still reading its source. A second capture that reaches OMP while the field is open produces a warning.

| Situation                                        | Level   | Toast text                                                             |
| ------------------------------------------------ | ------- | ---------------------------------------------------------------------- |
| Capture while the comment field is open          | info    | Finish the current comment                                             |
| Capture while a file capture reads its source    | info    | The selection is still being captured                                  |
| Capture that reaches OMP while the field is open | warning | Finish the current comment: Enter saves, Esc cancels                   |
| Capture that is already saved                    | info    | This selection is already saved. Press Alt+C again for another comment |

### Comments dialog

The comment count on the message icon, the comments command, and the capture shortcut without a selection each open the Comments dialog. The dialog is a stock SDK overlay. Opening it while it is already open does nothing.

Files are in the left column, with per-file counts. The center column has exactly one row per comment, with its file and line location inline and no second quote line. Both columns use the same native list and item primitives, so their heights and top insets match. Paths and remote hosts identify distinct sources. Terminal and chat captures have their own groups. At narrow widths the columns wrap instead of overflowing.

The native header has a standalone clickable Esc keycap at the right. A press anywhere outside the card closes the dialog, like Esc. Presses inside the card, including its head and padding, never close it. The [outside-click dependencies](#outside-click-dependencies) section lists what this behaviour relies on.

While a send is pending, every footer button is disabled with the sending reason as its tooltip.

| Element                     | Label                                             |
| --------------------------- | ------------------------------------------------- |
| Dialog title                | Comments                                          |
| First source entry          | All sources                                       |
| Empty guidance              | No comments yet. Make a selection and press Alt+C |
| Buttons                     | Delete, Edit, Close, Send all                     |
| Header keycap title         | Close (Esc)                                       |
| Tooltip while sending       | Sending                                           |
| Tooltip without a selection | No comment selected                               |
| Tooltip without comments    | No comments to send                               |

### Detail view

Clicking a comment, pressing Enter or choosing Edit opens the detail view. The detail view is a full, modal SDK sheet across the pane width. The sheet sits in the session's own layer. The composer's Comments button, which the capture shortcut addresses, therefore stays live while the detail view is open.

The source title is at the top left, and a standalone Esc keycap is at the top right. A muted line below names an unsaved file, a remote host and a clipped selection. The immutable source comes next, followed by the comment editor. The editor has a three-line minimum and scrolls after eight lines. All quotes use the same native code block. Chat quotes have no invented line numbers. Quotes expand from an eight-line preview.

For a local, clean file up to 1 MiB, the source shows two surrounding lines after exact, unambiguous verification. The selected lines are marked. This preview reads the original file and never changes storage or the sent batch. Dirty, remote, clipped, unavailable or changed sources show the exact captured quote.

Typing saves automatically. Esc or the header keycap returns to the list with the same file filter. The back-to-list text exists only as the keycap's tooltip and accessibility label. A comment cleared to blank is removed on navigation or return. The delete control at the right of the sheet's bottom footer bar deletes the selected comment and returns to the list.

| Item                              | Value                                     |
| --------------------------------- | ----------------------------------------- |
| Sheet size                        | `size: "full"`                            |
| Muted line labels                 | Unsaved file, the host, Selection clipped |
| Header keycap tooltip             | Back to list (Esc)                        |
| Header keycap accessibility label | Back to list                              |
| Footer delete label               | delete                                    |

### Source names

Chat quotes are captured exactly as Tern copies the rendered selection. The SDK supplies no originating message or author id, so a capture record carries no author. Capture neither searches raw Markdown nor guesses an author. An unknown author does not prevent capture.

A terminal capture carries no command. The pane's running or last command need not be the one whose output is selected. Its list row shows the generic terminal label.

Chat names in the detail header, the list and the batch attributes resolve the source's pane id against live window metadata. Only captures made in the running OMP process use the live names. A stored pane id from an earlier process can name another pane now, so older captures keep their captured title. The user's tab name wins over the live pane title. A blank live name falls back to the captured nonblank title, then to the generic chat label. A title is not evidence of authorship. Renaming changes display only. It neither resets the comment editor nor rewrites stored captures.

| Item           | Value          |
| -------------- | -------------- |
| Chat label     | Chat           |
| Terminal label | Terminal       |
| Captured title | `source.title` |

The Tern plugin publishes pane display names before each transfer and on a retained one-second SDK timer, because the SDK has no tab-rename event. The timer schedules its next tick before it works, so a budget pause of one tick cannot end it. Each tick builds the payload from tab and pane metadata alone. A tick reads a pane's OMP surface only when the payload changed, the pane has not received it yet, or the pane's program, busy state or command history changed. The last condition catches an OMP restart in the same pane, because the first surface of every OMP process reuses the same id. A surface read covers ids and props only, never text.

A pane whose surface has no Comments button, such as a plain shell, is read again only after a retry interval or as soon as its program, busy state or command history changes. A transfer to a pane drops that pane's retry wait, so the receiving session gets the names at once.

| Item                      | Value      |
| ------------------------- | ---------- |
| Reused surface id         | `s:1`      |
| Surface read limit        | 500 nodes  |
| Retry interval for a miss | 10 seconds |

### Sending

Only the send controls of the Comments dialog send. They send the entire session batch, including comments outside the current file filter. The send shortcuts do not send from the detail editor. Delivery is explicit: steering when the agent is idle, and a follow-up when it is busy. Idle steering also starts processing a fresh session's queue.

| Item          | Value                   |
| ------------- | ----------------------- |
| Button        | Send all                |
| Shortcuts     | Ctrl+Enter, ⌘+Enter     |
| Idle delivery | `deliverAs: "steer"`    |
| Busy delivery | `deliverAs: "followUp"` |

With these explicit delivery modes, a resolved send promise means queue admission, not completion of the agent turn. The dialog then deletes only the unchanged comments of its snapshot and closes without waiting for a response. Without an explicit delivery mode, an idle send awaits the whole turn instead. An enqueue rejection keeps the comments and the dialog open, and shows the reason after a not-sent prefix. A rejection the extension raises itself carries its own instruction. A later turn or provider failure belongs to OMP, not to this admission. An older pending admission cannot delete new or edited comments.

| Item                          | Value                                                                     |
| ----------------------------- | ------------------------------------------------------------------------- |
| Send call                     | `sendUserMessage()`                                                       |
| Rejection message             | Not sent: \<reason\>                                                      |
| Reason after a session change | The session changed. Open Comments in the original session and send again |

No comments are sent automatically on acceptance, startup, session switch or shutdown.

### Terminal fallback

Outside Tern, the same independent editor and the stock select list render in the terminal with keyboard controls. The source quote comes before the comment. Before wrapping, the fallback strips ANSI and OSC escape sequences and C0 and C1 control characters from quotes, labels and comments. It also normalizes CR and CRLF line endings. Stored captures and sent batches keep the exact text.

| Item       | Value                  |
| ---------- | ---------------------- |
| Components | `Editor`, `SelectList` |

## Keyboard

The capture shortcut is a Tern shortcut. OMP has no separate chat-capture shortcut. To change the shortcut, bind the capture command to another chord in Tern's keyboard settings. A user binding or keymap preset can take the default chord, and the command palette entry stays available.

| Item             | Value                                |
| ---------------- | ------------------------------------ |
| Default shortcut | Alt+C                                |
| Settings page    | Settings › Keyboard                  |
| Command          | Comment on selection                 |
| Action id        | `plugin.stencil-highlighter.capture` |

| Context         | Keys                               | Effect                                                         |
| --------------- | ---------------------------------- | -------------------------------------------------------------- |
| Tern            | Alt+C                              | Capture the selection, or open the Comments dialog without one |
| Comment field   | Enter                              | Save a nonblank comment                                        |
| Comment field   | Shift+Enter                        | Insert a newline                                               |
| Comment field   | Esc                                | Cancel                                                         |
| Comments list   | ↑, ↓, Tab, Shift+Tab, Alt+↓, Alt+↑ | Move between visible comments                                  |
| Comments dialog | Enter                              | Open the selected comment                                      |
| Comments dialog | Ctrl+Enter, ⌘+Enter                | Send all                                                       |
| Comments dialog | Esc                                | Close                                                          |
| Detail view     | Enter                              | Insert a newline                                               |
| Detail view     | Esc                                | Return to the list                                             |
| Detail view     | Ctrl+D                             | Delete the comment and return to the list                      |

## Wire contract

The Tern plugin dispatches actions to a native button in the OMP composer of the same tab. The add action carries one capture record as JSON. The open action opens the Comments dialog. The sources action carries a JSON array of live pane display names. Only the OMP extension stores comments and sends explicitly requested batches.

| Item                   | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| Button role            | `omp.btn`                                                 |
| Button key             | `omp-comments`                                            |
| Add action             | `comments.add` with JSON CaptureRecord v1                 |
| Open action            | `comments.open`                                           |
| Sources action         | `comments.sources` with a JSON array of `{ pane, title }` |
| Record fields          | `v`, `id`, `source`, `text`, `clipped`                    |
| Fields of every source | `kind`, `pane`, `title`, `cwd`                            |
| File-only fields       | `path`, `lines`, `lang`, `dirty`, `host`                  |
| File range             | `source.lines = { from, to }`                             |

Captured quotes are immutable. The capture parser bounds the capture id to at most 256 characters. It requires the source pane to be a nonnegative safe integer. Both values become storage and native node keys. Every source string field is bounded as well. A rejected record yields a stable reason code, and the error toast shows the reason's message after the Comments prefix. An add action without a record is rejected before parsing.

| Reason code or case        | Message                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `invalid-record`           | The selection was not received intact. Press Alt+C again                                                 |
| `selection-too-long`       | The selection exceeds 64,000 characters. Make a shorter selection                                        |
| `unknown-source`           | The selection comes from an unknown source. Install the same Stencil Highlighter version in Tern and OMP |
| `invalid-source`           | The selection's source details are invalid. Press Alt+C again                                            |
| Add action without a value | The selection was not received. Press Alt+C again                                                        |
| Source string field limit  | 4,096 characters                                                                                         |

The extension module default-exports the extension factory. On the first main-session session start, the extension wraps the prior editor factory, native layout and event handler exactly once. OMP keeps that factory for the life of the process. New, resumed, forked and branched sessions therefore only cancel open dialogs and refresh the count. They never add another wrapper or another comment button. Event handlers read the latest session context instead of the one captured at installation. The extension never reads, replaces or sends the composer draft.

| Item             | Value                      |
| ---------------- | -------------------------- |
| Entry module     | `omp/index.ts`             |
| Install event    | `session_start`            |
| Session commands | `/new`, `/resume`, `/fork` |

## File and selection capture

File selection ownership is independent of the tab's keyboard focus. A chat selection in the focused pane wins. Otherwise the plugin checks live file-block ranges in the same tab. It focuses the uniquely selected file through the SDK before capture. Parked and exited panes and other tabs are excluded. Several selected files are rejected rather than guessed. File capture reads the pane's own buffer, including remote and unsaved content.

Line-ending reconstruction uses only byte-proven LF and CRLF endings. Mixed prefixes, ambiguous reversed multiline ranges and oversized lines fall back to native Copy and the local clipboard helper. This fallback overwrites the clipboard. Focus, source identity, selection, byte size and dirty state are checked again before transfer. A capture whose window closes while a clipboard helper runs still finishes, so the next capture is not blocked. Every file-capture failure carries a stable reason code beside its message, and the tests check the codes.

The macOS helper reads the clipboard with a UTF-8 locale. Without a locale, as in a Tern started from the Dock, it would use the C encoding, and non-ASCII text would fail the byte-length check.

| Platform | Clipboard helper | Environment          |
| -------- | ---------------- | -------------------- |
| macOS    | `pbpaste`        | `LC_ALL=en_US.UTF-8` |
| Wayland  | `wl-paste`       | inherited            |
| X11      | `xclip`          | inherited            |
| Windows  | PowerShell       | inherited            |

Tern exposes no buffer revision. Same-size edits to an already dirty buffer therefore cannot be detected reliably. The clipboard fallback compares byte length, not cryptographic content equality.

Compact sidebar Peek is not supported by this capture path. The public SDK selection contract exposes selected text and ranges for blocks. It has no separate source or selection API for that compact preview. Support requires Tern SDK access to the preview's source identity and selection. Opening the Comments dialog from compact Peek is not verified. No DOM or control-endpoint workaround is used.

| Link                          | URL                                                               |
| ----------------------------- | ----------------------------------------------------------------- |
| Public SDK selection contract | https://docs.stencil.so/tern/reference/api-window.html#session-cx |

## Batch format

The sent message contains every comment of the session in creation order. One blank line separates entries. Each entry contains a fenced quote followed directly by the unchanged comment, with no separate source header.

````text
```ts file="src/app.ts:12-14" unsaved
quoted text
```
comment

```text terminal="/work/tools" clipped
quoted output
```
comment

```text chat="Review session"
quoted text
```
comment
````

The opening fence starts with the language, followed by space-separated source attributes. Tern displays only the language in its code head and uses it for syntax highlighting. The agent receives the attributes in raw Markdown.

| Source   | Info string pattern                                         |
| -------- | ----------------------------------------------------------- |
| File     | `<lang> file="<path><range>" host="<host>" unsaved clipped` |
| Terminal | `text terminal="<directory>" clipped`                       |
| Chat     | `text chat="<name>" clipped`                                |

Attributes appear in the order shown. Unknown or empty values are omitted. The clipping flag is always last.

| Part      | Present when                                  | Value                                                                                             |
| --------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Language  | Always                                        | The file capture's language matching `^[\w+.-]+$`, otherwise `text`; terminal and chat use `text` |
| Path      | The file path is nonempty after cleaning      | Relative to the OMP session's directory for a local file strictly inside it, otherwise absolute   |
| Range     | The file capture has a line range             | `:5` for one line, `:3-4` for several                                                             |
| Host      | The file is remote                            | The host name                                                                                     |
| Unsaved   | The file buffer is dirty                      | `unsaved`                                                                                         |
| Directory | The terminal pane reports a working directory | The directory                                                                                     |
| Name      | The chat has a live or captured name          | The name resolved by the Source names rules                                                       |
| Clipped   | The quote is clipped                          | `clipped`                                                                                         |

Every source value is untrusted. Control characters become spaces, whitespace runs collapse to one space, and the value is trimmed. Values above the limit end with an ellipsis before escaping. Each attribute value is enclosed in double quotes. Within those quotes, backslashes and double quotes are escaped as follows.

| Character    | Encoded form |
| ------------ | ------------ |
| Backslash    | `\\`         |
| Double quote | `\"`         |

Backticks in the info string require a tilde fence because CommonMark forbids them in a backtick fence's info string. Otherwise the fence uses backticks. The fence has at least three characters and is one character longer than the longest run of its character in the quote. The quote follows byte-exact, with a newline added before the closing fence only when the quote lacks one.

Other punctuation and entity references remain unchanged. The attributes are for the agent, not the displayed code head. The source labels in the Comments list and detail header remain unchanged.

| Item                      | Value                              |
| ------------------------- | ---------------------------------- |
| Separator between entries | one blank line                     |
| Source value limit        | 256 characters                     |
| Minimum fence length      | three characters                   |
| Source                    | `formatBatch` in `omp/comments.ts` |

## Storage

Accepted nonblank comments live in the comment database inside the OMP profile data. The database uses SQLite write-ahead logging. The directory is owner-only. The database file, its write-ahead log and its shared-memory file are readable and writable by the owner only. The OMP extension tightens existing files when it first opens them.

| Item                              | Value                                                |
| --------------------------------- | ---------------------------------------------------- |
| Database                          | `<OMP profile>/data/stencil-highlighter/comments.db` |
| Profile directory                 | `getAgentDir()`                                      |
| Journal mode                      | WAL                                                  |
| Directory mode                    | `0700`                                               |
| Database, WAL, shared-memory mode | `0600`                                               |

Comments are scoped by the active session id. They survive restart and are not copied to branches. Capture ids are deduplicated within a session, including after deletion or send, so retries do not recreate old comments. Each intentional capture gets a fresh id, so the same quote may receive several comments. Only accepted captures get deduplication entries. Cancelled or blank input leaves neither a comment nor an id entry.

The database contains source text and comments in plain text. Delete or archive it with normal profile-data hygiene while no OMP process with the extension is running.

## Appearance

The SDK supplies colors, backgrounds, borders, shadows, materials, blur, opacity and transparency. Font families come only from SDK font tokens. The Tern stylesheet controls only Stencil Highlighter geometry and the faces of the comment field and the detail view. Font sizes stay inherited. Every selector is scoped to Stencil Highlighter, so unrelated controls and user settings are untouched. Theme, materials, transparency settings, quick-input geometry and styling, capsule dimensions and list-row metrics remain unchanged. Tern's UI zoom scales every value below.

| Item       | Value             |
| ---------- | ----------------- |
| Stylesheet | `tern/layout.css` |

Human text in the comment field and the detail view uses Tern's configured UI font token, so a comment is typed and edited in one face. The source uses the pane's terminal face. Both apply whatever face the surrounding surface or overlay card sets, because overlay cards otherwise draw everything in the UI face. Keycaps keep SDK typography. No font family is hard-coded.

| Text                                     | Font                          |
| ---------------------------------------- | ----------------------------- |
| Comment field and detail view human text | `var(--sans)`                 |
| Detail view source                       | `var(--tv-font, var(--mono))` |

The detail sheet uses the sheet's own insets and group gaps. From top to bottom, it holds the header, the editor, the source and the footer bar. The header carries the source title at the left and the Esc keycap at the right. The footer bar carries the delete keycaps at the right, without enclosing pills. The source's line boxes and native line marks share one line height, so they scale together. Footer labels are raised optically. Field carets follow the field's font size, with an optical offset.

| Detail metric      | Value             |
| ------------------ | ----------------- |
| Sheet insets       | 16px and 18px     |
| Group gaps         | 16px              |
| Source line height | 1.25              |
| Footer label lift  | 1.5 design pixels |
| Caret height       | `1em`             |
| Caret offset       | `0.15em`          |

The Comments dialog's header, list bounds and outer footer buttons share one native-density side inset. The footer bar's negative side margins derive from that inset. Footer controls have equal space above and below. The footer overrides are scoped and marked important, because native OMP pins its action-bar margins and padding. No button dimensions or materials are overridden. The dialog's button labels use single-line metrics with zero vertical displacement, independently of the detail footer's lift. Capsule geometry is untouched. The header's standalone Esc keycap occupies the native end slot. Empty guidance uses the same row height, line height and optical offset as the first source row. These metrics copy the SDK list row as font-relative values, so the empty row keeps matching the source rows at any font size. An SDK change to list rows needs the same change in the stylesheet.

| Dialog metric                         | Value            |
| ------------------------------------- | ---------------- |
| Side inset                            | 16 design pixels |
| Space above and below footer controls | 12px             |
| Footer override flag                  | `!important`     |
| Header keycap slot                    | `end`            |
| Empty row height                      | `32em / 13`      |
| Empty row line height                 | `18em / 13`      |
| Card metrics behind these units       | 13px and 18px    |

### Tern-internal classes

The stylesheet styles parts of Tern's markup that the Tern docs mark as inner and liable to change, or describe as Tern's structure. A Tern update that renames them restores the native defaults. Only the outside-click close then stops working, because it depends on the dim class.

| Item              | Value               |
| ----------------- | ------------------- |
| Tern docs wording | "inner, may change" |
| Dim class         | `.sf-ov-dim`        |

```text
.sf-ov-card
.sf-ov-head
.sf-ov-body
.sf-ov-title
.sf-ov-dim
.sf-btn-label
.sf-button > .kbds
.sf-item-label
.sf-item-detail
.sf-item-value
.sf-list-empty
.sf-code-lines
.sf-code-body
.sf-ln
.sf-gut
.sf-lt
.sf-caret
```

### Outside-click dependencies

Tern documents backdrop-press-to-close only for OMP's read-only panel sheets. Otherwise a modal backdrop swallows the press. Outside-click close therefore depends on four undocumented details:

1. The Comments dialog reports itself as a native sheet whenever the host supports overlays. The backend therefore puts the component directly in the layer, as Tern documents for picker and preferences sheets. OMP also treats the component as a side sheet for pointer focus and skips the narrow-pane fill.
2. The reconciler hoists an overlay described inside a component out of the full-layer close column into the layer. Nodes placed directly in the layer are not hoisted.
3. The header end id copies the reconciler's private id format for hoisted overlays.
4. The stylesheet makes Tern's inner dim pointer-transparent and raises the sheet above the close target.

| Detail                 | Literals                                               |
| ---------------------- | ------------------------------------------------------ |
| Read-only panel sheets | `omp.overlay.report`, `.context`, and others           |
| 1                      | `Collection.nativeSheet()`, `layer`, `picker`, `prefs` |
| 2                      | `overlay`, `stencil-highlighter.collection.dismiss`    |
| 3                      | `<component>.^sheet/collection-close`                  |
| 4                      | `.sf-ov-dim`                                           |

The extension test reconciles the dialog's description in the layer. It fails if the sheet stops being hoisted out of the close target, or if the end id no longer names the Esc keycap. It checks the detail's foot id the same way. This block is the one test that pins SDK wiring on purpose, as a guard for these dependencies. If Tern renames the dim class, outside clicks stop closing the card. Removing these dependencies requires Tern to extend backdrop-press-as-Escape to the comments overlay, or to add a backdrop-dismiss overlay prop.

| Item                   | Value                              |
| ---------------------- | ---------------------------------- |
| Test file              | `omp/index.test.ts`                |
| Reconciled description | `Collection.describe()` in `layer` |
| Detail foot prop       | `foot`                             |
| Comments overlay role  | `omp.overlay.comments`             |

## Checks

### OMP extension

The comment module exports the capture parser and its error, the comment store, the line-range, chat-name and source-label helpers, the batch formatter, the batch sender and the record, source, chat-name and comment types. It has no SDK runtime imports.

| Module            | Exports                                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `omp/comments.ts` | `parseCapture`, `CaptureError`, `CaptureErrorCode`, `CommentStore`, `lineRange`, `chatName`, `sourceLabel`, `formatBatch`, `sendBatch`, `CaptureRecord`, `CaptureSource`, `LineRange`, `ChatTitles`, `Note` |

| Test file               | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `comments.test.ts`      | Absence of cancelled and blank comments; id deduplication versus intentional repeats; session isolation; durable exact text; admission failure; delayed admission and snapshot deletion; rejection reason codes at the wire boundary, including malformed JSON, a non-string kind and oversized fields; the id and pane bounds; language and attributes for every source kind with relative and unchanged paths, ranges, hosts and clipping; language fallback; fence safety; hostile values kept inside parseable quoted attributes; capped values; live chat names only for captures of this process                                                                                                                                                                                                           |
| `quote-context.test.ts` | Verified partial-line context; CRLF and file boundaries; immutable captures; rejection of ambiguous, stale, dirty and remote context; fallback for FIFOs and directories without blocking, because the source opens with `O_NONBLOCK` before its `fstat` check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `index.test.ts`         | Loads the extension through OMP's own extension loader, alone and with the composer-wrapping fixture in both orders; the composer keeps exactly one comment button and one neighbour control across session switches and branches; a session switch cancels an open field; a new capture replaces the Comments dialog and keeps its edits; edit, return and blank removal through the dialog's keys; deletion inside a source filter moves to the next comment of that filter; a capture made during a pending send survives the admitted batch; steering when idle and a follow-up when busy; a rejected send keeps the dialog, its error and every comment; live chat names from the sources action reach the sent header; the native sheet ids from [outside-click dependencies](#outside-click-dependencies) |

The fixture chains the composer factory the way the English tutor does.

| Item    | Value                               |
| ------- | ----------------------------------- |
| Fixture | `omp/fixtures/composer-neighbor.ts` |

With Bun available, run the checks at the repository root:

```sh
bun install
bun test
bun run typecheck
bun run lint
```

On bundled OMP builds without a Bun executable, run these at the repository root instead:

```sh
env BUN_BE_BUN=1 omp install
env BUN_BE_BUN=1 omp test
env BUN_BE_BUN=1 omp run typecheck
env BUN_BE_BUN=1 omp run lint
```

The TypeScript configuration is strict and reports unused locals and parameters. The lint script runs Biome formatting, recommended lint rules and import ordering over the whole package. That covers the OMP sources, the Tern stylesheet, the JSON configuration and the Markdown documents. The format script applies the same fixes. The shared Biome configuration sits at the repository root. Intentional exceptions are suppressed inline with a reason.

| Item              | Value                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| TypeScript config | `tsconfig.json`: `strict`, `noUnusedLocals`, `noUnusedParameters`                                             |
| Biome config      | `biome.json`: tabs at width 4, 120 columns, double quotes in TypeScript, single quotes in CSS, two-space JSON |
| Lint scope        | `omp/`, `tern/layout.css`, JSON configuration, Markdown documents                                             |
| Scripts           | `lint`, `format`                                                                                              |

### Tern plugin

Run the focused tests with the Luau CLI in the Tern directory. The Luau CLI gives each required module its own globals. The file-selection module therefore takes the Tern API as its first argument. The window module passes the global, and the test passes a stub.

```sh
luau selection-source.test.luau
luau file-selection.test.luau
```

| Test file                    | Coverage                                                                                                                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selection-source.test.luau` | A selected file outside keyboard focus; chat precedence; excluded panes; ambiguous file selections                                                                                                                                                              |
| `file-selection.test.luau`   | Exact LF, CRLF and Unicode quotes; distant selections; mixed and reversed fallback; long lines; clipping; rejected source, selection and focus changes by reason code; a capture abandoned when its window closes; the UTF-8 locale of the macOS clipboard read |

Type-check the plugin with luau-lsp against the definitions of the installed Tern. Git ignores the generated definitions file. Regenerate it after upgrading Tern. In the Tern directory, run:

```sh
tern plugin types .
luau-lsp analyze --platform=standard --definitions=@tern=tern.d.luau window.luau file-selection.luau selection-source.luau
```

Handlers and helpers carry type annotations, so the check catches API misuse such as an unsupported toast level.

| Item                  | Value                                           |
| --------------------- | ----------------------------------------------- |
| Generated definitions | `tern/tern.d.luau`                              |
| Annotations           | `cx: WindowCx`, `PaneInfo`, event payload types |

Format the Luau sources with StyLua and the shared configuration at the repository root: Luau syntax, tabs, 120 columns and double quotes. StyLua searches for its configuration only from each file's directory up to the working directory. Run from the Tern directory, it therefore needs the configuration path. Install it, then run the check and the formatter in the Tern directory:

```sh
brew install stylua
stylua --config-path ../stylua.toml --check .
stylua --config-path ../stylua.toml .
```

| Tool or config | Value                                              |
| -------------- | -------------------------------------------------- |
| StyLua config  | `stylua.toml`                                      |
| Luau CLI       | https://github.com/luau-lang/luau/releases         |
| luau-lsp       | https://github.com/JohnnyMorganz/luau-lsp/releases |
| StyLua         | https://github.com/JohnnyMorganz/StyLua            |

### Manual checklist

Run these checks in a real Tern window. A complete run of this checklist in a Tern window is not confirmed. The specification's implementation verification lists the parts that ran.

1. Launch the one-run command from [Installation](#for-one-omp-run) in a Tern pane, and type a distinctive unsent composer draft. The message-icon button with count 0 must appear in the native dock.
2. Capture a file quote with remote or dirty metadata, a terminal selection, and an agent or user message. Inspect the one-field centered layer, and save multiline comments. The count must increment without changing the draft or starting a turn.
3. Cancel typed and whitespace-only comments, repeat the capture shortcut while typing, and switch sessions with an open field. No pending capture may survive, and the previous session's comments must remain isolated.
4. Open the Comments dialog by the icon, by the comments command and by the capture shortcut without a selection. Check file grouping with two comments on the same file, counts, filtering and the empty state.
5. Click or press Enter on a comment, edit it, then press Esc to return to the same file filter. Inspect the full-path tooltip and long-quote expansion.
6. Clear or delete the last comment in a file, and confirm that the removed scope does not strand the view. Repeat the dialog checks in light and dark themes and in a narrow window. Close, then restart or resume, to confirm persistence.
7. Send explicitly while idle and while the agent is busy, including from a filtered file list. All session comments must be included. The send shortcut in the detail view must send nothing.
8. Inspect the single admitted user message, including embedded backticks, quote indentation, CRLF and source metadata.
9. Delay the agent turn. The popup must close after queue admission, before any response. Idle delivery must use steering, and busy delivery must queue a follow-up.
10. Verify that an enqueue rejection keeps the comments and shows the reason after the not-sent prefix. Do not treat a later cost or provider failure as an admission rejection.
11. Load the extension with another composer extension, such as the English tutor, in both extension orders. Then use the new, resume and fork commands. Exactly one comment button must remain. Both controls, the native handlers and the existing draft must keep working.
12. Repeat a comment-field and Comments dialog pass in a plain terminal for the fallback controls.
13. Open a detail view and press the capture shortcut on a new selection. The detail view must close, and the comment field must open.
14. Open the Comments dialog, select a rendered file heading, and leave the tab's keyboard focus on OMP. Press the real capture shortcut. The dialog must become the comment field. Save, then inspect the exact file quote and path and the previously stored comment. Calling the OMP add handler directly exercises neither source selection nor window-to-OMP dispatch.
15. On macOS, start Tern from the Dock and capture non-ASCII text through the clipboard fallback, for example from a file with mixed line endings. The capture must succeed.
16. Make two ranges in one file and press the capture shortcut. The capture must be rejected with the one-continuous-selection reason.
17. Capture a line near the end of a file with several hundred thousand lines. The capture must succeed without a budget pause of the capture command.
18. Inspect the detail sheet's side insets and footer padding against the Comments dialog.

| Step | Literal        |
| ---- | -------------- |
| 1    | `message` icon |
| 14   | `comments.add` |

## Version-pinned SDK contracts

| Contract                                                  | Source                                                                                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension UI and send options                             | [types.ts](https://cdn.jsdelivr.net/npm/@oh-my-pi/pi-coding-agent@18.18.5/src/extensibility/extensions/types.ts)                              |
| Explicit queue admission versus default full-turn sending | [agent-session.ts](https://cdn.jsdelivr.net/npm/@oh-my-pi/pi-coding-agent@18.18.5/src/session/agent-session.ts)                               |
| Custom overlay cleanup and draft restoration              | [extension-ui-controller.ts](https://cdn.jsdelivr.net/npm/@oh-my-pi/pi-coding-agent@18.18.5/src/modes/controllers/extension-ui-controller.ts) |
| Editor native edits, undo and terminal keys               | [editor.ts](https://cdn.jsdelivr.net/npm/@oh-my-pi/pi-tui@18.18.5/src/components/editor.ts)                                                   |
| Composer layout and native event chaining                 | [custom-editor.ts](https://cdn.jsdelivr.net/npm/@oh-my-pi/pi-tui@18.18.5/src/prompt/custom-editor.ts)                                         |
| Native list and overlay composition                       | [overlay.ts](https://cdn.jsdelivr.net/npm/@oh-my-pi/pi-tui@18.18.5/src/native/overlay.ts)                                                     |
| Native overlay component contract                         | [tui.ts](https://cdn.jsdelivr.net/npm/@oh-my-pi/pi-tui@18.18.5/src/tui.ts)                                                                    |
| Wire props and events                                     | [tsp.ts](https://cdn.jsdelivr.net/npm/@oh-my-pi/pi-wire@18.18.5/src/tsp.ts)                                                                   |

## License

Stencil Highlighter is released under the MIT license.

| Item    | Value              |
| ------- | ------------------ |
| License | [LICENSE](LICENSE) |
