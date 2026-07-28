# Task document format

`/autopilot-plan` accepts **exactly four** task files. Each is a UTF-8 Markdown file with a
strict three-line header followed by a body.

This format is enforced by `drivers/src/planning/mod.rs::classify_task_document` and
`validate_task_input_set`. Every rule below is mechanically checked before any model is
invoked — a malformed pack is rejected with a typed error and costs nothing.

---

## The invocation

```
/autopilot-plan <workstream> <authority-1> <authority-2> <authority-3> <context>
```

Exactly four paths, in this order:

| Position | Required class |
|---|---|
| 1 | `[authority]` |
| 2 | `[authority]` |
| 3 | `[authority]` |
| 4 | `[context/non-authority]` |

Three authority documents + one context document. Not three, not five — **four**.

---

## File shape

```
[authority]
authority_set_id: my-task-2026-07-28

Mission
Build the thing.

Definition of Done
- it works
```

Line by line:

| Line | Rule |
|---|---|
| 1 | The class marker, alone on the line |
| 2 | Exactly `authority_set_id: <id>` — one space after the colon |
| 3 | **Empty** |
| 4+ | The body — must not be blank |

### Class markers

| Marker | Meaning | Usable in a pack? |
|---|---|---|
| `[authority]` | Operator intent. Binding. | ✅ positions 1–3 |
| `[context/non-authority]` | Supporting background. Not binding. | ✅ position 4 |
| `[historical/non-authority]` | Superseded/forensic material. | ❌ rejected |
| `[index/non-authority]` | Navigation/index file. | ❌ rejected |

`historical` and `index` markers are recognised so they can be **explicitly refused** —
they exist to stop stale or navigational documents being mistaken for authority.

### `authority_set_id`

- Identical across **all four** files. A mismatch rejects the whole pack.
- Non-empty, no leading or trailing whitespace.
- Any stable slug works; a dated task slug is a good habit
  (`schema-migration-2026-07-28`).

Its purpose is to bind four files into one deliberate set, so a stray file cannot be
silently swept into a run.

### Encoding

- UTF-8, **no BOM**
- **LF line endings only** — a single `\r` anywhere rejects the file
- Body must contain at least one non-whitespace character

### Paths

Repo-relative only. Rejected: absolute paths, `..`, `.`, backslashes, symlinked
ancestors, and non-regular files (directories, devices, sockets).

---

## Rejection reference

Every rejection names the exact file and reason.

### Header — `planning:TaskHeader("<reason>:<path>")`

| Reason | Meaning | Fix |
|---|---|---|
| `bom` | File starts with a UTF-8 BOM | Strip it |
| `crlf` | Contains `\r` | Convert to LF |
| `non-utf8` | Not valid UTF-8 | Re-save as UTF-8 |
| `missing-marker` | Empty file | Add the header |
| `missing-authority-set` | No line 2 | Add `authority_set_id:` |
| `missing-empty-line` | No line 3 | Add the blank line |
| `line3-not-empty` | Line 3 has content | Make it empty |
| `bad-authority-line` | Line 2 malformed | Use `authority_set_id: <id>` exactly |
| `bad-authority-id` | Empty or padded id | Remove surrounding whitespace |
| `unknown-marker` | Unrecognised marker | Use one of the four above |
| `empty-body` | Nothing after line 3 | Write the body |

### Pack — `planning:<Variant>`

| Error | Meaning |
|---|---|
| `TaskInputCount` | Not exactly four paths |
| `TaskInputOrder` | Wrong class at a position — reports the position and both classes |
| `TaskAuthoritySetMismatch` | The four `authority_set_id`s are not identical |
| `HistoricalTaskInput` | A `[historical/non-authority]` file was supplied |
| `IndexTaskInput` | An `[index/non-authority]` file was supplied |
| `NoTaskAuthority` | No authority document, or an authority body is blank |

### Path — `planning:TaskPath("<reason>")`

| Reason | Meaning |
|---|---|
| `absolute` | Path is absolute |
| `unsafe-component` | Contains `..`, `.`, or a root component |
| `backslash` | Contains `\` |
| `not-regular-file` | Not a regular file |
| `empty-path` | Path resolved to nothing |

---

## Worked example

```
task/
├── TASK-mission.md      [authority]
├── TASK-scope.md        [authority]
├── TASK-dod.md          [authority]
└── TASK-context.md      [context/non-authority]
```

`TASK-mission.md`:

```
[authority]
authority_set_id: add-health-endpoint-2026-07-28

Mission
Add a /health endpoint returning 200 with {"status":"ok"}.
```

`TASK-context.md`:

```
[context/non-authority]
authority_set_id: add-health-endpoint-2026-07-28

Context
The service uses axum. Routes live in src/routes.rs.
```

Run:

```
/autopilot-plan health-endpoint task/TASK-mission.md task/TASK-scope.md task/TASK-dod.md task/TASK-context.md
```

A ready-to-use pack ships at [`templates/task-pack/`](../templates/task-pack/).

---

## Why it is this strict

Three prior incidents (BUG-180/181/182) were caused by a validator silently accepting
input the producer had not really satisfied. The header is deliberately rigid so that a
malformed or accidental file is refused **before** any model spend, with a message naming
the file and the reason.

Authority and context are separated because they carry different weight: authority is
operator intent that must be honoured, context is background that may inform but never
overrides. Collapsing the two is how a plan silently drifts from what was asked.
