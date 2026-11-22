#!/usr/bin/env python3
"""Compare two phase 2 stats snapshots (scripts/phase2-stats-snapshot.sql).

    python3 -I scripts/phase2-stats-diff.py stats-A.csv stats-B.csv [expected.csv]

Prints every (metric, person, month, category, key) whose n differs: a, b, delta = b - a.
Without expected.csv: exit 0 only when the two snapshots are identical.
With expected.csv (scripts/phase2-expected-diff.sql): exit 0 only when the differences are
exactly the expected deltas (same keys, same values, summed over the reasons) and nothing else.
It prints the expected total per reason (assigned_ab, platform_b, demo_link), then every
unexpected or missing difference. This is the gate of the phase 2 runbook.
Reads local files only; no database access.
"""
import csv
import sys
from collections import defaultdict


def load(path, value_col):
    out = {}
    with open(path, newline='') as f:
        for row in csv.DictReader(f):
            k = (row['metric'], row['person'], row['month'], row['category'], row['key'])
            if k in out:
                sys.exit(f'{path}: duplicate key {k}')
            out[k] = int(row[value_col])
    return out


REASONS = {'assigned_ab': {'assigned', 'assigned_cur'}, 'platform_b': {'os'}, 'demo_link': {'drive_link'}}


def load_expected(path):
    """Expected deltas summed per key, and (keys, total) per reason. A reason outside REASONS, or
    a reason on a metric it does not cover, is an error: the gate allows nothing else."""
    out = defaultdict(int)
    per_reason = defaultdict(lambda: [0, 0])
    with open(path, newline='') as f:
        for row in csv.DictReader(f):
            reason, metric = row['reason'], row['metric']
            if metric not in REASONS.get(reason, ()):
                sys.exit(f'{path}: reason {reason!r} does not cover metric {metric!r}')
            k = (metric, row['person'], row['month'], row['category'], row['key'])
            d = int(row['delta'])
            out[k] += d
            per_reason[reason][0] += 1
            per_reason[reason][1] += d
    return {k: d for k, d in out.items() if d}, per_reason


def main():
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    a = load(sys.argv[1], 'n')
    b = load(sys.argv[2], 'n')
    diff = {}
    for k in sorted(set(a) | set(b)):
        d = b.get(k, 0) - a.get(k, 0)
        if d:
            diff[k] = d
    per_metric = defaultdict(lambda: [0, 0])
    for k, d in diff.items():
        per_metric[k[0]][0] += 1
        per_metric[k[0]][1] += d
    print(f'rows: A {len(a)}, B {len(b)}; keys that differ: {len(diff)}')
    for metric, (nk, total) in sorted(per_metric.items()):
        print(f'  {metric}: {nk} keys, total delta {total:+d}')

    if len(sys.argv) == 3:
        w = csv.writer(sys.stdout)
        w.writerow(['metric', 'person', 'month', 'category', 'key', 'a', 'b', 'delta'])
        for k, d in diff.items():
            w.writerow([*k, a.get(k, 0), b.get(k, 0), d])
        print('IDENTICAL' if not diff else 'DIFFERENT')
        sys.exit(0 if not diff else 1)

    exp, per_reason = load_expected(sys.argv[3])
    unexpected = {k: d for k, d in diff.items() if exp.get(k) != d}
    missing = {k: d for k, d in exp.items() if k not in diff}
    for reason in REASONS:
        nk, total = per_reason.get(reason, [0, 0])
        print(f'  expected {reason} ({"/".join(sorted(REASONS[reason]))}): {nk} rows, total delta {total:+d}')
    w = csv.writer(sys.stdout)
    if unexpected:
        print(f'UNEXPECTED differences ({len(unexpected)}): metric,person,month,category,key,a,b,delta,expected')
        for k, d in unexpected.items():
            w.writerow([*k, a.get(k, 0), b.get(k, 0), d, exp.get(k, 0)])
    if missing:
        print(f'MISSING expected differences ({len(missing)}): metric,person,month,category,key,expected')
        for k, d in missing.items():
            w.writerow([*k, d])
    ok = not unexpected and not missing
    print('MATCHES EXPECTED' if ok else 'DOES NOT MATCH EXPECTED')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
