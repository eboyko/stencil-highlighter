# Stencil Highlighter

One feature in two parts that ship under one version. The Tern window plugin captures a selection and its source. The OMP extension stores, edits and sends comments. The README is the user and behaviour reference. The specification is the design reference.

| Item                         | Value                                |
| ---------------------------- | ------------------------------------ |
| Tern window plugin           | `tern/`, Luau                        |
| OMP extension                | `omp/`, TypeScript                   |
| User and behaviour reference | [README.md](README.md)               |
| Specification                | [SPECIFICATION.md](SPECIFICATION.md) |

## Contracts

1. The parts communicate only through CaptureRecord v1 and one native composer button with three actions. Land a change on one side with the matching change on the other side, in the same commit.
2. Keep every stable identifier unchanged. The package name, the plugin id, the command id, the UI node ids and the storage directory derive from one name. Renaming any identifier breaks user bindings or data.
3. Captured quotes are immutable and sent byte-exact.
4. Treat every source attribute value in a batch fence's info string as untrusted. Replace control characters with spaces, collapse whitespace runs, trim and cap each value. Enclose attribute values in double quotes and escape backslashes and double quotes within them. Start the info string with the language and keep it on one line. Use a tilde fence when it contains a backtick, and make the fence longer than every run of its character in the quote.
5. Send only on explicit request, with steering when idle and a follow-up when busy. Never send on capture, start, session switch or shutdown.
6. Keep UI strings English and hard-coded. The repository contains no other language. Keep existing strings byte-identical unless the change is about them. User-facing text and the documents use one glossary, and no user message names an internal type.

| Contract item           | Value                                                  |
| ----------------------- | ------------------------------------------------------ |
| Button role and key     | `omp.btn`, `omp-comments`                              |
| Actions                 | `comments.add`, `comments.open`, `comments.sources`    |
| Shared name             | `stencil-highlighter`: OMP package and Tern plugin id  |
| Command id              | `plugin.stencil-highlighter.capture`                   |
| UI node ids             | `stencil-highlighter.*`                                |
| Storage                 | `<OMP profile>/data/stencil-highlighter/comments.db`   |
| Untrusted source values | path, cwd, host, chat title                            |
| Delivery                | `deliverAs: "steer"` when idle, `"followUp"` when busy |
| Glossary                | selection, comment, Comments, session                  |

## Visuals

1. Take fonts, colors, borders, shadows, materials and transparency from the Tern and OMP SDK.
2. Never hard-code a font family; reference SDK font tokens only. Never set a color, opacity or blur.
3. Apart from the font tokens and the source size, the Tern stylesheet controls layout only: 16-pixel side insets, 12 pixels above and below footer controls, aligned edges and optically centered labels.
4. Scope every selector to Stencil Highlighter.
5. Styling Tern-internal classes is a documented risk. List every new one in the Tern-internal classes list of the README's Appearance section.

| Item                  | Value                                        |
| --------------------- | -------------------------------------------- |
| Stylesheet            | `tern/layout.css`                            |
| SDK font tokens       | `var(--sans)`, `var(--tv-font, var(--mono))` |
| Tern-internal classes | inner `.sf-*` parts                          |

## Commands

Run the commands at the repository root. Bundled OMP builds without a Bun executable use the third column. The lint command runs Biome over the OMP sources, the Tern stylesheet, the JSON configuration and the Markdown documents.

| Task       | With Bun            | Bundled OMP without Bun              |
| ---------- | ------------------- | ------------------------------------ |
| Install    | `bun install`       | `env BUN_BE_BUN=1 omp install`       |
| Test       | `bun test`          | `env BUN_BE_BUN=1 omp test`          |
| Type-check | `bun run typecheck` | `env BUN_BE_BUN=1 omp run typecheck` |
| Lint       | `bun run lint`      | `env BUN_BE_BUN=1 omp run lint`      |
| Format     | `bun run format`    | `env BUN_BE_BUN=1 omp run format`    |

Run the Luau tests and the StyLua check in the Tern directory. StyLua finds the shared configuration from there only through the configuration path.

```sh
cd tern && luau selection-source.test.luau && luau file-selection.test.luau && stylua --config-path ../stylua.toml --check .
```

Never run Biome with the unsafe flag. The unsafe fix of Biome's important-styles rule deletes the deliberate important declarations in the Tern stylesheet as soon as their suppression markers stop covering them.

| Item                  | Value                             |
| --------------------- | --------------------------------- |
| Forbidden flag        | `--unsafe`                        |
| Protected declaration | `!important` in `tern/layout.css` |

## Code rules

Formatters own indentation, spacing inside lines and wrapping. After any edit, both formatters must report no changes. The rules below cover what the formatters do not decide.

| Formatter | Version | Config        | Settings                                                                 |
| --------- | ------- | ------------- | ------------------------------------------------------------------------ |
| Biome     | 2.6.6   | `biome.json`  | tabs at width 4, 120 columns, double quotes in TypeScript, single in CSS |
| StyLua    | 2.6.0   | `stylua.toml` | Luau, tabs, 120 columns, parentheses on every call                       |

### Blank lines

1. Split a body into intent groups separated by one blank line. Put no blank lines inside a group. Never put two blank lines in a row.
2. After a statement spanning several lines, leave one blank line before the next statement at the same depth. The exception is a conditional that checks only the variable just assigned.
3. Group homogeneous declarations by kind: imports, constants, types, state, registrations. Separate the groups by one blank line.
4. Put an explanatory comment directly above the code it explains, with no blank line.

### Order

1. Order a file as imports and requires, constants, types, module state, helper functions, classes, then the exported entry point and Tern registrations last.
2. Order a class body as fields with readonly fields first, constructor, public members, private members. Keep accessors next to their field.
3. Place helpers in order of first use. Delete unused helpers.
4. Order public methods along the user-visible process: open, select, edit, back, delete, send, close.
5. Keep one order for the same set of things everywhere: parameters, object literals, assignments and docs.

### Expressions

1. Keep each loop or conditional condition and each logical chain on one line. If the formatter would wrap it, split it into named booleans or an early return.
2. Never concatenate string literals. Long text is one literal.
3. Write no one-line block bodies. Concise arrow functions are fine.
4. Use no non-null assertions in TypeScript; narrow the type instead. Model variants as discriminated unions, not as bags of optional fields.

| Rule          | Forbidden                                  | Allowed        |
| ------------- | ------------------------------------------ | -------------- |
| Expressions 1 | wrapped `if`, `while`, `for`, `&&`, `\|\|` | named booleans |
| Expressions 2 | `+` or `..` between string literals        | one literal    |
| Expressions 3 | `{ return x; }`, `function() return x end` | `x => x.id`    |
| Expressions 4 | `value!`                                   | type narrowing |

### Comments and suppressions

1. Comments explain reasons and tradeoffs and never restate code. Prose comments are full sentences.
2. Prefer changing code to satisfy a lint rule over suppressing the rule or disabling it in configuration.
3. A justified suppression covers its whole declaration, sits directly above it and states the reason. A CSS block uses a start and end marker pair.

| Item              | Value                                    |
| ----------------- | ---------------------------------------- |
| CSS block markers | `biome-ignore-start`, `biome-ignore-end` |

## Tests

1. Bun test covers the OMP extension. The Luau tests run under the standalone Luau CLI, so the file-selection module receives the Tern API as an argument.
2. Tests pin user-visible behaviour: storage, deduplication, batch format and escaping, admission and deletion, delivery mode, dialog state, and composer chaining through the composer fixture. Do not test wording or wiring.
3. Tell failure reasons apart by their stable codes, never by message text.
4. The native sheet ids block in the extension test is the one sanctioned SDK-dependency guard. It pins the wiring that the outside-click close depends on.
5. Real-window checks follow the README's manual checklist. A unit test that calls the add action directly exercises neither capture nor window-to-OMP dispatch.

| Item                  | Value                                         |
| --------------------- | --------------------------------------------- |
| Luau tests            | `tern/*.test.luau`                            |
| File-selection module | `tern/file-selection.luau`                    |
| Composer fixture      | `omp/fixtures/composer-neighbor.ts`           |
| Add action            | `comments.add`                                |
| Failure codes         | `CaptureError.code`, Luau `{ code, message }` |
| SDK-dependency guard  | `native sheet ids` in `omp/index.test.ts`     |
