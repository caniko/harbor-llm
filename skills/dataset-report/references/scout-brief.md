# Scout brief

Fill the placeholders and send this text as the subagent prompt.

---

You are a read-only scout for one partition of a dataset. Do not modify,
move or delete anything, and write no files. Your final message is your
notes, and the coordinator saves them.

- Dataset root: `{ROOT}`
- Manifest: `{MANIFEST}` (delimiter `{DELIMITER}`)
- Columns:
  - path `{PATH_COL}`
  - group `{GROUP_COL}`
  - type `{TYPE_COL}`
  - other descriptive columns `{OTHER_COLS}`
- Your partition: rows where `{GROUP_COL}` is one of `{GROUPS}`
- Sample to open: `{SAMPLE_PATHS}`

The manifest is direction, not ground truth. Your tasks:

1. Profile the partition's rows. Report the row count, the type distribution
   and the naming or numbering pattern of paths and identifiers. Report the
   title or description conventions, such as date prefixes or place and
   subject separators, and how consistently they hold.
2. Open every sampled file. Images: view them. Documents: read the first
   page. For each one, record what it actually shows and whether it matches
   its manifest row.
3. Note anything a report author must know. Examples: inconsistent
   identifiers, files that contradict their metadata, sensitive content, and
   recurring subjects, people, places or periods.

Return only this JSON, with no prose before or after:

```json
{
  "partition": "string",
  "groups": ["string"],
  "rows": 0,
  "type_distribution": {"type": 0},
  "naming": {"pattern": "string", "consistency": "string", "exceptions": ["string"]},
  "description_conventions": "string",
  "samples": [
    {"path": "string", "manifest_type": "string", "observed": "one sentence", "matches_manifest": true}
  ],
  "themes": ["string"],
  "anomalies": ["string"],
  "questions": ["string"]
}
```

Keep `observed` factual and short. Do not interpret beyond what the files
and metadata show.
