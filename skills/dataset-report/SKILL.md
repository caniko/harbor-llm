---
name: dataset-report
description: Scout a local dataset (a folder of files plus an optional metadata or catalogue CSV) with cheap parallel subagents and write a LaTeX/PDF report about it. Use when a data delivery needs a completeness check, a structural and content inventory, or a written report; check completeness first and do not analyse an incomplete delivery unless the user asks for a partial report.
---

# Dataset report

The flow has gates. Finish each phase and record its output before starting
the next one. `SKILL_DIR` is this skill's directory. When the skill comes from
a Harbor bundle, `SKILL_DIR/env/bin` holds the pinned Python and TeX
toolchain.

## 0. Locate

- Find the dataset root and its metadata manifest (a CSV, TSV or JSON export).
  If several exist, ask which one is authoritative.
- Read the manifest header and a few rows. Identify these columns:
  - the file path
  - the expected size, if any
  - a grouping column (collection, fonds, series)
  - a type column (document type, medium)
- Agree on an output directory `OUT` **outside** the dataset. If the
  project's instructions name an evidence or report location, use it. Never
  use a Git repository or the Nix store. Outputs reproduce dataset content
  and inherit its confidentiality.

## 1. Completeness gate

```sh
"$SKILL_DIR/env/bin/python3" -I "$SKILL_DIR/scripts/reconcile.py" MANIFEST ROOT \
  --out OUT --delimiter ';' --path-column PATH_COL \
  --size-column SIZE_COL --group-column GROUP_COL
```

Use `python3` from `PATH` when there is no bundled `env`. The script writes:

- `completeness.json`, `completeness.md`
- `missing.csv`
- `groups.csv` (pgfplots input)

It exits 2 when rows are missing or sizes differ.

If the delivery is incomplete, report the gap and stop. Give the user the
missing row and byte share and the groups that are absent. Continue only when
the user explicitly asks for a partial report, and say so on the report's
title page. Rerun this phase whenever the delivery changes.

## 2. Scout

Split the manifest into partitions along the grouping column. Balance them by
file count, at about 300 to 800 files each, and merge small groups. Run one
read-only subagent per partition **in parallel** on the cheapest capable
model:

- Claude Code: `Explore` subagents with `model: haiku`.
- OpenCode, Codex and other harnesses: their small or fast model, read-only.

Give each scout the brief in `references/scout-brief.md`, filled in with
these inputs:

- its partition's manifest rows, or the path plus a filter
- the column mapping
- a stratified sample of 3 to 6 files per value of the type column

The manifest gives scouts direction and is not ground truth. Scouts confirm
or contradict it against the files. Each scout writes its notes to
`OUT/scout/<partition>.json`. Check every notes file against the schema in
the brief, and re-dispatch a scout whose notes are missing or malformed. Do
not patch its notes from memory.

## 3. Synthesize

Merge the scout notes and `completeness.json` into `OUT/outline.md`. The
outline has one bullet list per report section, and each claim cites the
partition notes it came from. Show the outline to the user and wait for
approval before writing TeX.

## 4. Write and build

```sh
mkdir -p OUT/report/data
cp "$SKILL_DIR/assets/report.tex" OUT/report/report.tex
cp OUT/groups.csv OUT/report/data/groups.csv
```

- Fill every `TODO` in `report.tex` from the outline. Set the babel language
  to the dataset's language.
- Keep the generated numbers traceable to `completeness.json` or the scout
  notes.
- Put sample images in `OUT/report/figures/` as downscaled copies, never the
  originals.

Build:

```sh
cd OUT/report && "$SKILL_DIR/env/bin/latexmk" -lualatex -interaction=nonstopmode -halt-on-error report.tex
```

If the project already ships a harbor-tex shell or a `mkTexlive` toolchain,
building with it is equivalent. Report the PDF path, and point out the open
questions the scouts raised.
