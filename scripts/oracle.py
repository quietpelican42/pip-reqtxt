#!/usr/bin/env python3
"""Run cases through pip's own requirements-file code and record what it does.

    python scripts/oracle.py cases.json expected.json [--work DIR]

Needs a Python with pip 26.x importable (pip._internal is used directly).
For every case it records each line pip's parser produced (classification and
option values), each requirement pip built from them (via
install_req_from_parsed_requirement, which applies packaging's Requirement
and Marker), and the first error with the file and line it happened on.

The working directory is created with the fixed tree in scripts/tree.json so
that local-path handling sees the same filesystem the JavaScript side assumes.
Absolute paths in the output are rewritten to /work.
"""
import argparse
import contextlib
import io
import json
import logging
import os
import re
import shutil
import sys

from pip._internal.exceptions import InstallationError
from pip._internal.network.session import PipSession
from pip._internal.req import req_file
from pip._internal.req.constructors import install_req_from_parsed_requirement
from pip._internal.req.req_file import ParsedLine, RequirementsFileParser, parse_requirements
from pip._vendor.packaging.utils import canonicalize_name

logging.disable(logging.CRITICAL)
sys.argv[0] = 'pip'

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = json.load(open(os.path.join(HERE, 'tree.json')))

CUR = {}
RECORD = []
URLS = {}
_orig_get = req_file.get_file_content


def fake_get(url, session, *, constraint=False):
    if re.match(r'^(https?|file):', url, re.I):
        if url in URLS:
            return url, URLS[url]
        raise InstallationError(f'Could not open {"constraint" if constraint else "requirements"} file: [Errno 2] No such file or directory: {url!r}')
    return _orig_get(url, session, constraint=constraint)


req_file.get_file_content = fake_get


def describe(pl):
    o = pl.opts
    if pl.requirement is not None:
        kind = 'requirement'
    elif o.requirements or o.constraints:
        kind = 'include'
    else:
        kind = 'option'
    return dict(
        kind=kind, file=pl.filename, lineno=pl.lineno, requirement=pl.requirement, constraint=pl.constraint,
        editables=list(o.editables), requirements=list(o.requirements), constraints=list(o.constraints),
        index_url=o.index_url, extra_index_urls=list(o.extra_index_urls), no_index=o.no_index,
        find_links=list(o.find_links), prefer_binary=o.prefer_binary, require_hashes=o.require_hashes,
        no_require_hashes=o.no_require_hashes, pre=o.pre, trusted_hosts=list(o.trusted_hosts),
        features_enabled=list(o.features_enabled), hashes=o.hashes, config_settings=o.config_settings,
    )


def patched_parse_file(self, filename, constraint):
    _, content = req_file.get_file_content(filename, self._session, constraint=constraint)
    for line_number, line in req_file.preprocess(content):
        # pip's --use-feature option shares one default list across every parser
        # (a functools.partial keyword), so values leak from line to line; reset it.
        req_file.cmdoptions.use_new_feature.keywords['default'].clear()
        CUR['file'] = filename
        CUR['lineno'] = line_number
        try:
            args_str, opts = self._line_parser(line)
        except req_file.OptionParsingError as e:
            raise req_file.RequirementsFileParseError(f'Invalid requirement: {line}\n{e.msg}')
        pl = ParsedLine(filename, line_number, args_str, opts, constraint)
        RECORD.append(describe(pl))
        yield pl


RequirementsFileParser._parse_file = patched_parse_file


def describe_req(pr, ireq):
    m = re.match(r'^line (\d+) of (.*)$', pr.line_source or '')
    req = ireq.req
    opts = pr.options or {}
    return dict(
        file=m.group(2), lineno=int(m.group(1)), requirement=pr.requirement, editable=pr.is_editable,
        constraint=pr.constraint, hashes=opts.get('hashes') or {}, config_settings=opts.get('config_settings') or {},
        name=req.name if req else None, normalized=str(canonicalize_name(req.name)) if req else None,
        extras=sorted(ireq.extras), specifier=str(req.specifier) if req else '',
        text=str(req) if req else None, url=ireq.link.url if ireq.link else None,
        marker=str(ireq.markers) if ireq.markers else None,
    )


def error_message(e):
    if hasattr(e, 'message') and e.__class__.__name__ == 'InvalidEggFragment':
        return e.message
    return str(e)


def run_case(case):
    RECORD.clear()
    CUR.clear()
    URLS.clear()
    URLS.update(case.get('urls', {}))
    made = []
    for name, text in case['files'].items():
        p = os.path.join(os.getcwd(), name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8', newline='') as f:
            f.write(text)
        made.append(p)
    saved = {k: os.environ.get(k) for k in case['env']}
    os.environ.update(case['env'])
    reqs = []
    error = None
    session = PipSession()
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            for pr in parse_requirements(case['main'], session, constraint=case.get('constraint', False)):
                loc = pr.line_source
                m = re.match(r'^line (\d+) of (.*)$', loc)
                CUR['file'], CUR['lineno'] = m.group(2), int(m.group(1))
                ireq = install_req_from_parsed_requirement(pr)
                reqs.append(describe_req(pr, ireq))
    except BaseException as e:  # noqa: BLE001 - every escape is a result
        error = dict(type=type(e).__name__, message=error_message(e), file=CUR.get('file'), lineno=CUR.get('lineno'))
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        for p in made:
            with contextlib.suppress(OSError):
                os.remove(p)
        for d in ('sub',):
            pass
    return dict(id=case['id'], lines=list(RECORD), reqs=reqs, error=error)


def scrub_all(x, real):
    """Rewrite the working directory to /work and drop every ancestor prefix.

    Dropping ancestors makes `..` above /work read as it does when a path is
    normalized lexically from the root, and keeps the real location out of the output.
    """
    x = _replace(x, real, '/work')
    parts = real.strip('/').split('/')
    for n in range(len(parts) - 1, 0, -1):
        x = _replace(x, '/' + '/'.join(parts[:n]), '')
    return x


def _replace(x, old, new):
    if isinstance(x, str):
        return x.replace(old, new)
    if isinstance(x, list):
        return [_replace(i, old, new) for i in x]
    if isinstance(x, dict):
        return {k: _replace(v, old, new) for k, v in x.items()}
    return x


def build_tree(work):
    if os.path.exists(work):
        shutil.rmtree(work)
    os.makedirs(work)
    for d in TREE['dirs']:
        os.makedirs(os.path.join(work, d), exist_ok=True)
    for f in TREE['files']:
        os.makedirs(os.path.dirname(os.path.join(work, f)), exist_ok=True)
        open(os.path.join(work, f), 'w').close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cases')
    ap.add_argument('out')
    ap.add_argument('--work', default=os.path.join(HERE, '..', '.work'))
    a = ap.parse_args()
    work = os.path.abspath(a.work)
    a.cases, a.out = os.path.abspath(a.cases), os.path.abspath(a.out)
    build_tree(work)
    os.chdir(work)
    real = os.getcwd()
    cases = json.load(open(a.cases, encoding='utf-8'))
    out = []
    for c in cases:
        out.append(scrub_all(run_case(c), real))
        # sub/ is created by cases; remove case files only, keep the fixed tree
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False)
    import pip
    from pip._vendor import packaging
    print(f'{len(out)} cases; pip {pip.__version__}, vendored packaging {packaging.__version__}')


if __name__ == '__main__':
    main()
