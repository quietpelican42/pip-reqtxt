#!/usr/bin/env python3
"""Pick a diverse subset of oracle-checked cases and write test/fixtures/differential.json.gz.

    python scripts/gen_cases.py cases.json --seed 1 --count 20000
    python scripts/oracle.py cases.json expected.json
    python scripts/make_fixture.py cases.json expected.json test/fixtures/differential.json.gz [N]

Cases are grouped by a signature (line kinds, requirement/error shape, error
type and message stem); the selection round-robins over signatures so rare
behaviors are kept.
"""
import gzip
import json
import random
import re
import sys


def signature(e):
    kinds = sorted({l['kind'] for l in e['lines']})
    err = e['error']
    stem = ''
    if err:
        stem = err['type'] + ':' + re.sub(r'[0-9]+', '#', err['message'].split('\n')[0])[:48]
    fields = sorted({k for r in e['reqs'] for k, v in r.items() if v not in (None, '', [], {}, False)})
    return (tuple(kinds), bool(e['reqs']), stem, tuple(fields))


def main():
    cases_path, expected_path, out_path = sys.argv[1:4]
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 2000
    cases = json.load(open(cases_path, encoding='utf-8'))
    expected = json.load(open(expected_path, encoding='utf-8'))
    rnd = random.Random(0)
    picked = []
    # half the fixture is files pip accepts, half is files it rejects
    for want_ok, quota in ((True, n // 2), (False, n - n // 2)):
        groups = {}
        for i, e in enumerate(expected):
            if (e['error'] is None) == want_ok:
                groups.setdefault(signature(e), []).append(i)
        for g in groups.values():
            rnd.shuffle(g)
        got = 0
        while got < quota and any(groups.values()):
            for g in sorted(groups.values(), key=len):
                if g and got < quota:
                    picked.append(g.pop())
                    got += 1
    picked.sort()
    import pip
    from pip._vendor import packaging
    out = {
        'pip': pip.__version__,
        'packaging': packaging.__version__,
        'cases': [cases[i] for i in picked],
        'expected': [expected[i] for i in picked],
    }
    for k, (c, e) in enumerate(zip(out['cases'], out['expected'])):
        c['id'] = e['id'] = k
    with gzip.GzipFile(out_path, 'wb', mtime=0) as f:
        f.write(json.dumps(out, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    acc = sum(1 for e in out['expected'] if e['error'] is None)
    print(f'{len(picked)} cases, {acc} accepted by pip')


if __name__ == '__main__':
    main()
