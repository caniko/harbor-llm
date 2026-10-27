#!/usr/bin/env python3
"""Reconcile a dataset's metadata manifest against the files on disk.

Writes completeness.json, completeness.md and missing.csv to --out and exits
0 when every manifest row is present with the expected size, 2 otherwise.
Standard library only; run with `python3 -I`.
"""

import argparse
import collections
import csv
import json
import os
import sys
import tempfile
from pathlib import Path


def norm(path):
    # ponytail: always treats `\` as a separator (Windows exports); add a
    # --path-sep option if a POSIX dataset ever has backslashes in names.
    return path.replace("\\", "/").strip().lstrip("/")


def size_of(value):
    try:
        return int(value.replace(" ", "").replace(" ", ""))
    except (AttributeError, ValueError):
        return None


def reconcile(manifest, root, delimiter, path_column, size_column=None, group_column=None):
    manifest, root = Path(manifest).resolve(), Path(root).resolve()
    with manifest.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle, delimiter=delimiter))
    if rows and path_column not in rows[0]:
        raise SystemExit(f"reconcile: column {path_column!r} not in {sorted(rows[0])}")

    groups = collections.OrderedDict()
    seen = collections.Counter()
    missing, mismatches = [], []
    totals = collections.Counter()
    for row in rows:
        rel = norm(row[path_column])
        seen[rel] += 1
        group = groups.setdefault(row.get(group_column, "") if group_column else "", collections.Counter())
        expected = size_of(row.get(size_column)) if size_column else None
        target = root / rel
        group["rows"] += 1
        totals["rows"] += 1
        if expected is not None:
            group["expected_bytes"] += expected
            totals["expected_bytes"] += expected
        if target.is_file():
            actual = target.stat().st_size
            group["present"] += 1
            totals["present"] += 1
            group["present_bytes"] += actual
            totals["present_bytes"] += actual
            if expected is not None and actual != expected:
                mismatches.append({"path": rel, "expected": expected, "actual": actual})
        else:
            group["missing"] += 1
            totals["missing"] += 1
            if expected is not None:
                group["missing_bytes"] += expected
                totals["missing_bytes"] += expected
            missing.append({"group": row.get(group_column, "") if group_column else "", "path": rel, "bytes": expected})

    listed = set(seen)
    unlisted = sorted(
        rel
        for dirpath, _, files in os.walk(root)
        for name in files
        if (rel := (Path(dirpath) / name).relative_to(root).as_posix()) not in listed
        and Path(dirpath) / name != manifest
    )
    return {
        "manifest": str(manifest),
        "root": str(root),
        "columns": {"path": path_column, "size": size_column, "group": group_column},
        "totals": dict(totals) | {"unique_paths": len(listed)},
        "complete": not missing and not mismatches,
        "duplicate_paths": sorted(path for path, count in seen.items() if count > 1),
        "size_mismatches": mismatches,
        "unlisted_files": unlisted,
        "groups": {name: dict(counts) for name, counts in groups.items()},
    }, missing


def pct(part, whole):
    return f"{100 * part / whole:.1f}%" if whole else "n/a"


def write(report, missing, out):
    out.mkdir(parents=True, exist_ok=True)
    (out / "completeness.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    with (out / "missing.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["group", "path", "bytes"])
        writer.writeheader()
        writer.writerows(missing)
    # pgfplots input for the report's completeness chart.
    with (out / "groups.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["group", "rows", "present", "missing", "expected_bytes", "missing_bytes"])
        for name, g in report["groups"].items():
            writer.writerow([name or "-", *(g.get(key, 0) for key in ("rows", "present", "missing", "expected_bytes", "missing_bytes"))])
    t = report["totals"]
    lines = [
        f"# Completeness: {'complete' if report['complete'] else 'INCOMPLETE'}",
        "",
        f"- Manifest: `{report['manifest']}`",
        f"- Root: `{report['root']}`",
        f"- Rows: {t.get('rows', 0)} ({t['unique_paths']} unique paths, {len(report['duplicate_paths'])} duplicated)",
        f"- Present rows: {t.get('present', 0)}; missing rows: {t.get('missing', 0)} ({pct(t.get('missing', 0), t.get('rows', 0))})",
        f"- Expected bytes: {t.get('expected_bytes', 0)}; missing bytes: {t.get('missing_bytes', 0)} ({pct(t.get('missing_bytes', 0), t.get('expected_bytes', 0))})",
        f"- Size mismatches: {len(report['size_mismatches'])}; files not in manifest: {len(report['unlisted_files'])}",
        "",
        "| group | rows | present | missing | missing bytes |",
        "|---|---:|---:|---:|---:|",
    ]
    for name, g in report["groups"].items():
        if g.get("missing"):
            lines.append(f"| {name or '-'} | {g.get('rows', 0)} | {g.get('present', 0)} | {g.get('missing', 0)} | {g.get('missing_bytes', 0)} |")
    complete_groups = sum(1 for g in report["groups"].values() if not g.get("missing"))
    lines += ["", f"{complete_groups} of {len(report['groups'])} groups are complete and omitted from the table.", ""]
    (out / "completeness.md").write_text("\n".join(lines), encoding="utf-8")


def self_test():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp, "data")
        (root / "A" / "A-1").mkdir(parents=True)
        (root / "A" / "A-1" / "x.jpg").write_bytes(b"1234")
        (root / "A" / "A-1" / "bad.jpg").write_bytes(b"12")
        (root / "extra.txt").write_text("x")
        manifest = root / "meta.csv"
        manifest.write_bytes(
            "﻿fonds;chemin;taille\r\n"
            "A;A\\A-1\\x.jpg;4\r\n"
            "A;A\\A-1\\x.jpg;4\r\n"
            "A;A\\A-1\\bad.jpg;3\r\n"
            "B;B\\B-1\\gone.jpg;10\r\n".encode()
        )
        report, missing = reconcile(manifest, root, ";", "chemin", "taille", "fonds")
        t = report["totals"]
        assert (t["rows"], t["unique_paths"], t["present"], t["missing"]) == (4, 3, 3, 1), t
        assert t["missing_bytes"] == 10 and t["expected_bytes"] == 21, t
        assert report["duplicate_paths"] == ["A/A-1/x.jpg"]
        assert report["size_mismatches"] == [{"path": "A/A-1/bad.jpg", "expected": 3, "actual": 2}]
        assert report["unlisted_files"] == ["extra.txt"], report["unlisted_files"]
        assert report["groups"]["B"] == {"rows": 1, "expected_bytes": 10, "missing": 1, "missing_bytes": 10}
        assert not report["complete"] and missing == [{"group": "B", "path": "B/B-1/gone.jpg", "bytes": 10}]
        write(report, missing, Path(tmp, "out"))
        assert "INCOMPLETE" in Path(tmp, "out", "completeness.md").read_text()
        assert Path(tmp, "out", "groups.csv").read_text().splitlines()[2] == "B,1,0,1,10,10"
    print("reconcile self-test passed")


def main():
    if sys.argv[1:] == ["--self-test"]:
        return self_test()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest")
    parser.add_argument("root")
    parser.add_argument("--out", required=True, type=Path, help="output directory outside ROOT")
    parser.add_argument("--path-column", required=True)
    parser.add_argument("--size-column")
    parser.add_argument("--group-column")
    parser.add_argument("--delimiter", default=",")
    args = parser.parse_args()
    if args.out.resolve().is_relative_to(Path(args.root).resolve()):
        parser.error("--out must lie outside ROOT")
    report, missing = reconcile(args.manifest, args.root, args.delimiter, args.path_column, args.size_column, args.group_column)
    write(report, missing, args.out)
    t = report["totals"]
    print(f"{'complete' if report['complete'] else 'INCOMPLETE'}: {t.get('present', 0)}/{t.get('rows', 0)} rows present, "
          f"{t.get('missing', 0)} missing, {len(report['size_mismatches'])} size mismatches -> {args.out}")
    return 0 if report["complete"] else 2


if __name__ == "__main__":
    sys.exit(main())
