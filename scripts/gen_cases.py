#!/usr/bin/env python3
"""Generate requirements-file test cases for the pip differential.

    python scripts/gen_cases.py --seed 1 --count 10000 cases.json

Each case is {"id", "files": {name: text}, "main", "env", "constraint", "urls"}.
The generator is deterministic for a given seed. It does not import pip.
"""
import argparse
import json
import random

NAMES = ['requests', 'Django', 'flask_login', 'zope.interface', 'a', 'A1', 'x-y_z.w', 'pkg0',
         'Foo.Bar-baz_qux', 'PyYAML', 'ruamel.yaml', 'numpy', 'scikit-learn', 'a..b', 'A__B']
BAD_NAMES = ['-foo', 'foo-', '_x', '.x', 'foo!', '\u00e9', 'caf\u00e9', 'x\u20ac', 'foo:bar', 'foo@bar',
             '1', '', 'foo$', 'na\u00efve', '\u0661\u0662', 'a b', 'foo\u00a0bar', '\u212a']
EXTRAS = ['', '', '', '[security]', '[a,b]', '[ a , b ]', '[Foo_Bar]', '[a b]', '[]', '[a,]', '[a', 'a]',
          '[a,,b]', '[a][b]', '[a.b-c]', '[a,a]', '[B,a]', '[\u00e9]', '[ ]']
VERSIONS = ['1.0', '1.0.0', '2', '1.0a1', '1.0.post1', '1.0.dev0', '1!2.0', '1.0+local.1', '1.*', '1.0.*',
            'v1.0', '1.0rc1', '1.0-1', '01.02', '1.0.', '1..0', 'abc', '1.0.1.2.3', '1.0+', '1.0.dev',
            '1.0_post', '1.0.a', '3.8', '0', '1.0.0.0', '1.0B2', '2.0.0-rc.1', '1.0+Abc_1-2', '1.0.post',
            '1.0alpha', '1.0c1', '1.0pre2', '1.0preview', '1.0.rev3', '1.0r4', '99999999999999999999.1',
            '1.0+local!', '1 .0', '1.0 ', '\u0661.0', '1.0.*.1', '1!', '!1']
OPS = ['==', '>=', '<=', '<', '>', '!=', '~=', '===', '=', '=<', '!', '~', '==', '>=', '==', '>=']
VARS = ['python_version', 'python_full_version', 'os_name', 'sys_platform', 'platform_release',
        'platform_system', 'platform_version', 'platform_machine', 'platform_python_implementation',
        'implementation_name', 'implementation_version', 'extra', 'extras', 'dependency_groups',
        'python_implementation', 'os.name', 'sys.platform', 'platform.version', 'platform.machine',
        'platform.python_implementation', 'foo', 'Python_Version', 'python-version']
MVALS = ['"3.8"', "'linux'", '"win32"', '"3"', '"3.10.1"', '""', '"a\\"', '"\\x41"', '"\\n"', '"\\q"',
         "'it''s'", '"Foo_Bar"', '"CPython"', '"posix"', '"x86_64"', '"a b"', '"\\u00e9"', '"\\101"',
         '"\\x4"', '"caf\u00e9"', '3.8', 'x', '"unterminated', '"a" "b"']
MOPS = ['==', '!=', '<', '>', '<=', '>=', '~=', '===', 'in', 'not in', 'not  in', 'notin', '=', 'is', 'and']
URL_HOSTS = ['https://example.com', 'http://example.com:8080', 'https://user:pass@host.example', 'ftp://x.test',
             'file:///abs/dir', 'file://host/dir', 'FILE:///abs', 'git+https://github.com/x', 'git+ssh://git@github.com/x',
             'svn+http://svn.example/x', 'hg+file:///repo', 'bzr+lp:x', 'git://x.test/y', 'ssh://x/y',
             'https://${MYVAR}@host.example', 'https://${HOSTV}', 'https://[::1]', 'http://[bad', 'http://bad]',
             'https://[v1.x]', 'https://[1.2.3.4]', 'https://\uff03x', 'https://ex ample.com', 'https:///x', 'https:x']
URL_PATHS = ['/pkg-1.0.tar.gz', '/pkg-1.0-py3-none-any.whl', '/y.git', '/y.git@v1.0', '/p.zip', '/p.tar', '/x.whl',
             '/a-1.0-1-py3-none-any.whl', '/a-1.0-py3-none-any.whl?x=1', '/my%20pkg-1.0-py3-none-any.whl',
             '/foo__bar-1.0-py3-none-any.whl', '/foo-1.0b-py3-none-any.whl', '/foo-x-py3-none-any.whl',
             '/foo-1-2-3-4-5-py3-none-any.whl', '/foo-1.0-py3.py2-none-any.whl', '/dir/', '/', '',
             '/p.tar.bz2', '/p.tgz', '/p.TAR.GZ', '/p.tar.xz', '/a.b.whl', '/x-1.0-py3-none-any.whl/',
             '/%zz.whl', '/\u00e9-1.0-py3-none-any.whl']
FRAGS = ['', '', '', '#egg=foo', '#egg=foo-bar_baz', '#egg=foo&subdirectory=sub', '&egg=x', '#sha256=abc',
         '#egg=foo>=1', '#egg=foo[bar]', '#egg=', '#egg=a b', '#egg=-x', '#egg=x#egg=y', '#subdirectory=z',
         '#egg=foo&egg=bar', '#egg=_', '#egg=A', '?egg=x', '#egg=\u212a', '#egg=\u0130x', '#egg=a\u017f', '#egg=\u0131']
PATHS = ['./proj', 'proj', './proj[extra]', 'pyproj', 'emptydir', './emptydir', 'sub/proj2', './pkg-1.0.tar.gz',
         'pkg-1.0.tar.gz', './missing-1.0.tar.gz', 'x-1.0-py3-none-any.whl', './nonexist.whl', 'sub/y-2.0.zip',
         'sub/../x-1.0-py3-none-any.whl', './sub/../proj', '/abs/path.whl', '.', 'sub/..', './', 'dirwithfile', './dirwithfile', '/',
         'missing/', './proj/', './proj[a b]', './proj[', 'C:\\dir\\pkg.whl', 'proj@1.0', 'name@./x.whl',
         './x@y.whl', 'foo.tar.gz', 'foo.zip', 'foo@bar.tar.gz', './a b/c.whl', '~/x.whl', './x.whl[extra]',
         './\u00e9.whl', 'dir\\file.whl', 'x.WHL', './x.tar.GZ']
EDITS = ['./proj', 'proj', './proj[a,b]', '.', 'sub/..', 'sub/proj2', 'emptydir', './missing', 'file:///abs/proj',
         'file:///abs/proj#egg=proj', 'file:///x[bad', 'git+https://github.com/x/y.git#egg=y',
         'git+ssh://git@github.com/x/y.git@main#egg=y&subdirectory=z', 'git://x/y.git#egg=y', 'git:x#egg=y',
         'svn+http://x/y#egg=a', 'hg+file:///x#egg=a', 'bzr:x#egg=a', 'https://x/y.zip', 'https://x/y.zip#egg=q',
         'name @ git+https://x/y.git', 'name[extra] @ file:///abs ; python_version>"3"', 'name @ https://x/y.zip',
         'name @ file:///abs/x', 'git+https://x/y.git', 'git+https://x/y.git#egg=a>=1', 'GIT+HTTPS://X/Y#egg=a',
         'git+https://[bad/x#egg=a', 'x @ file://host/x', 'requests', 'requests>=2', 'a b', 'name @', '',
         'file:///abs#egg=a', 'file:../x#egg=x', 'FILE:///x#egg=a', './proj ; python_version>"3"']
HASH_OPTS = [' --hash=sha256:abc123', ' --hash sha256:def456', ' --hash=sha512:ab', ' --hash=sha384:cd',
             ' --hash=md5:abc', ' --hash=sha256', ' --hash=', ' --hash', ' --hash=SHA256:abc', ' --hash=sha256:',
             ' --hash="sha256:a b"', " --hash='sha256:x'", ' --hash=sha256:a --hash=sha256:b',
             ' --hash=sha256:a --hash=sha512:b', ' --has=sha256:x', ' --ha sha256:x', ' -C a=b', ' -Ca=b',
             ' --config-settings=k=v', ' --config-settings a', ' --config-settings=a=b --config-settings=a=c',
             ' -C a=b -C a=c -C a=d', ' -C =v', ' -C a=', ' --global-option="--x"', ' --install-option=x',
             ' --pre', ' --bogus', ' -x', ' --use-feature=fast-deps', ' --use-feature=nope', ' -r other.txt',
             ' -e ./proj', ' --hash=sha256:abc extra', ' extra --hash=sha256:abc', ' --hash=sha256:\\',
             ' --hash="sha256:abc', ' --', ' -- --hash=sha256:x', ' -', ' --hash=sha256:a\tb', ' -- foo',
             ' --index-url=x', ' --trusted-host h', ' --no-binary=:all:', ' --no-binary -x', ' --only-binary=-y',
             ' --hash=sha256:\u00e9', ' \t--hash=sha256:x', '\t--hash=sha256:x', ' --hash=sha256:x  ',
             '  --hash=sha256:x --hash=sha256:y']
OPT_LINES = ['--index-url https://x/simple', '-i https://x', '--index-url=', '--index-url', '--extra-index-url=https://x',
             '--extra-index-url https://a --extra-index-url https://b', '--no-index', '-f ./wheels', '--find-links=https://x',
             '-f', '--pre', '--prefer-binary', '--require-hashes', '--no-require-hashes', '--only-binary :all:',
             '--only-binary=:all:', '--no-binary :none:', '--no-binary=numpy,scipy', '--no-binary -x',
             '--only-binary=-x', '--all-releases :all:', '--only-final=foo', '--all-releases -a', '--trusted-host host:8080',
             '--use-feature=fast-deps', '--use-feature=bad', '--use-feature', '--use-feature venv-isolation',
             '--use-feature=truststore --use-feature=build-constraint', '--use-deprecated=legacy-resolver',
             '--ind x', '--no x', '--no-i', '--pre=1', '--pypi-url x', '--no-index x', '-i', '-ix', '-ei', '-ie',
             '-c cons.txt', '-r other.txt', '--requirement=other.txt', '--constraint cons.txt', '-rother.txt',
             '-cother.txt', '-r', '-r missing.txt', '-r other.txt -c cons.txt', '-c cons.txt -r other.txt',
             '-r other.txt --pre', '--hash=sha256:abc', '--', '-- foo', '-', '- x', '--=x', '---x', '--f x', '--p',
             '--index-url "https://x y"', "--index-url 'unclosed", '--index-url \\', '-i\t', '--trusted-host a --trusted-host b',
             '-C a=b', '--config-settings=x', '-r sub/nested.txt', '-r ./sub/../other.txt', '-r sub/loop.txt',
             '-r main.txt', '-r self.txt', '-r http://example.test/remote.txt', '-c http://example.test/remote.txt', '-r http\u017f://example.test/remote.txt', '-r HTTP://Example.test/remote.txt', '-c f\u0130le:///x',
             '--index-url=https://u:${MYVAR}@x/simple', '--index-url ${NOPE}', '--index-url=${EMPTYV}',
             '-r "other.txt"', "-r 'sub/nested.txt'", '-r other\\ file.txt', '-r  other.txt', '--pre --no-index --prefer-binary',
             '--pre -x', '-f a -f b', '-e ./proj', '-e ./proj --pre', '--editable=git+https://x/y#egg=y',
             '--requirement', '--constraint', '-c', '-rr', '-ic', '-i -c', '-i "" ', '--trusted-host', '--no-binary', '--only-binary',
             '--hash', '-C', '--all-releases', '--only-final', '--require-hashes=1', '-Ca=b', '-fx -fy',
             '--index-url=a=b', '--index-url==a', '--pre ', '  --pre', '--pre\t--no-index', '--pre\u00a0--no-index',
             '--\u00e9', '-\u00e9', '-i\u00e9', '--use-feature=\u00e9']
COPT_LINES = ["--index-url https://x/simple", "-i https://x", "--index-url=", "--extra-index-url=https://x", "--extra-index-url https://a --extra-index-url https://b", "--no-index", "-f ./wheels", "--find-links=https://x", "--pre", "--prefer-binary", "--require-hashes", "--no-require-hashes", "--only-binary :all:", "--only-binary=:all:", "--no-binary :none:", "--no-binary=numpy,scipy", "--all-releases :all:", "--only-final=foo", "--trusted-host host:8080", "--use-feature=fast-deps", "--use-feature venv-isolation", "--use-feature=truststore --use-feature=build-constraint", "--ind x", "--no-i", "--pypi-url x", "-ix", "-ie", "-c cons.txt", "-r other.txt", "--requirement=other.txt", "--constraint cons.txt", "-rother.txt", "-cother.txt", "-r other.txt -c cons.txt", "-c cons.txt -r other.txt", "-r other.txt --pre", "--hash=sha256:abc", "--", "-- foo", "-", "- x", "--f x", "--index-url \"https://x y\"", "--trusted-host a --trusted-host b", "-C a=b", "-r sub/nested.txt", "-r ./sub/../other.txt", "-r sub/loop.txt", "-r self.txt", "-r http://example.test/remote.txt", "-c http://example.test/remote.txt", "--index-url=https://u:${MYVAR}@x/simple", "--index-url ${NOPE}", "--index-url=${EMPTYV}", "-r \"other.txt\"", "-r 'sub/nested.txt'", "-r  other.txt", "--pre --no-index --prefer-binary", "-f a -f b", "-e ./proj", "-e ./proj --pre", "--editable=git+https://x/y#egg=y", "-ic", "-i -c", "-i \"\" ", "-Ca=b", "-fx -fy", "--index-url=a=b", "--index-url==a", "--pre ", "  --pre", "--pre\t--no-index", "-i\u00e9"]
COMMENTS = ['', '', '', '', ' # c', '  # c', '\t# c', ' #c', ' # c \\', ' #', '#', '  #!', ' # -*- coding: latin-1 -*-']
NL = ['\n'] * 12 + ['\r\n'] * 3 + ['\r', '\u2028', '\x0b', '\x0c', '\x1c', '\x85', '\u2029', '\x1d', '\x1e']
SPECIAL = [' ', '\t', '"', "'", '\\', '$', '#', '{', '}', '[', ']', '(', ')', ';', ',', '=', '<', '>', '!', '~', '@',
           ':', '/', '&', '%', '?', '\u00e9', '\u00a0', '\u2028', '\ufeff', '\x85', '\x1f', '\x0b', '\x0c', '\u3000',
           '\U0001f600', '-', '--', '\\\n', ' #', '${', '${A}', '\x1c', '\u2029']
ENVS = [{}, {'MYVAR': 'pw', 'HOSTV': 'host.example'},
        {'MYVAR': 'a b', 'HOSTV': 'x', 'EMPTYV': '', 'NEST': '${MYVAR}', 'REQV': 'requests>=2', 'OPTV': '--pre',
         'HASHV': '--hash=sha256:abc', 'SEMI': ';', 'HASH': '#', 'BS': '\\', 'A': '${B}', 'B': 'bee'}]


CLEAN = False
FUZZ = False
VALID_RELEASES = ['1.0', '1.0.0', '2', '3.8', '0', '1.0.0.0', '01.02', '1.0.1.2.3', '99999999999999999999.1', '2.10', '1!2.0']
VALID_SUFFIX = ['', '', '', 'a1', '.post1', '.dev0', 'rc1', '-1', 'B2', '.post', 'alpha', 'c1', 'pre2', 'preview', '.rev3', 'r4',
                '.dev', '_post', 'b', '-rc.1', '.RC1', 'a', '.post1.dev2', 'a1.post2.dev3']
VALID_LOCAL = ['+local.1', '+Abc_1-2', '+ubuntu1', '+0']


def valid_spec_piece(r):
    op = r.choice(['==', '>=', '<=', '<', '>', '!=', '~=', '===', '==', '>=', '=='])
    ws = r.choice(['', '', '', ' ', '  ', '\t'])
    rel = r.choice(VALID_RELEASES)
    if op == '===':
        return f'==={ws}' + r.choice(['1.0', 'foo', 'abc.def', 'anything!', '1.0+x', '1,2'.replace(',', '')])
    if op in ('==', '!=') and r.random() < 0.25:
        return f'{op}{ws}' + r.choice(['1.*', '1.0.*', '2.10.*', 'v1.*', '1!2.*', '0.*'])
    if op == '~=' and '.' not in rel:
        rel = rel + '.0'
    v = rel + r.choice(VALID_SUFFIX)
    if op == '~=' and r.random() < 0.2:
        v = v.replace('+', '')
    if op in ('==', '!=') and r.random() < 0.2:
        v += r.choice(VALID_LOCAL)
    if r.random() < 0.1:
        v = 'v' + v
    return f'{op}{ws}{v}'


def spec_piece(r):
    if CLEAN:
        return valid_spec_piece(r)
    v = r.choice(VERSIONS)
    op = r.choice(OPS)
    ws = r.choice(['', '', '', ' ', '  ', '\t'])
    return f'{op}{ws}{v}'


def specifier(r):
    k = r.choice([0, 0, 1, 1, 1, 2, 2, 3])
    if k == 0:
        return ''
    parts = [spec_piece(r) for _ in range(k)]
    sep = r.choice([',', ',', ', ', ' , ', ' ,', ',,', '']) if not CLEAN else r.choice([',', ', ', ' , ', ' ,', ','])
    s = sep.join(parts)
    if not CLEAN and r.random() < 0.08:
        s += r.choice([',', ' ,', ' '])
    if r.random() < 0.12:
        s = '(' + s + ')'
    if not CLEAN and r.random() < 0.03:
        s = '(' + s
    return r.choice(['', '', ' ', ' ']) + s


CVARS = ['python_version', 'python_full_version', 'os_name', 'sys_platform', 'platform_release', 'platform_system',
         'platform_version', 'platform_machine', 'platform_python_implementation', 'implementation_name',
         'implementation_version', 'extra', 'extras', 'dependency_groups', 'python_implementation', 'os.name',
         'sys.platform', 'platform.version', 'platform.machine', 'platform.python_implementation']
CVALS = ['"3.8"', "'linux'", '"win32"', '"3"', '"3.10.1"', '""', '"\\x41"', '"\\n"', '"\\q"', "'it'", '"Foo_Bar"', '"CPython"',
         '"posix"', '"x86_64"', '"a b"', '"\\u00e9"', '"\\101"', '"caf\u00e9"', '"a.b"', "'a'", '"tests"', '"Dev-Tools"']
COPS = ['==', '!=', '<', '>', '<=', '>=', '~=', '===', 'in', 'not in', 'not  in']


def marker_item(r):
    if CLEAN:
        if r.random() < 0.15:
            return f'{r.choice(CVALS)} {r.choice(COPS)} {r.choice(CVARS)}'
        return f'{r.choice(CVARS)}{r.choice(["", " "])}{r.choice(COPS[:8])}{r.choice(["", " "])}{r.choice(CVALS)}' \
            if r.random() < 0.5 else f'{r.choice(CVARS)} {r.choice(COPS)} {r.choice(CVALS)}'
    if r.random() < 0.15:
        return f'{r.choice(MVALS)} {r.choice(MOPS)} {r.choice(VARS)}'
    return f'{r.choice(VARS)}{r.choice(["", " "])}{r.choice(MOPS)}{r.choice(["", " ", " "])}{r.choice(MVALS)}'


def marker(r, depth=0):
    n = r.choice([1, 1, 1, 2, 3])
    parts = []
    for _ in range(n):
        if depth < 2 and r.random() < 0.2:
            parts.append('(' + marker(r, depth + 1) + ')')
        else:
            parts.append(marker_item(r))
        parts.append(r.choice([' and ', ' or ', ' AND ', ' and', 'and ', '\tor\t']))
    parts.pop()
    s = ''.join(parts)
    if r.random() < 0.04:
        s += r.choice([')', '(', ' or', ' and'])
    return s


CEXTRAS = ['', '', '', '[security]', '[a,b]', '[ a , b ]', '[Foo_Bar]', '[a.b-c]', '[a,a]', '[B,a]', '[ ]', '[a , b,c]']


def named_req(r):
    name = r.choice(NAMES) if (CLEAN or r.random() < 0.9) else r.choice(BAD_NAMES)
    s = name + r.choice(['', '', '', ' ', '\t']) + r.choice(CEXTRAS if CLEAN else EXTRAS) + specifier(r)
    if r.random() < 0.3:
        s += r.choice([' ; ', ';', ' ;', '; ', '\t;\t']) + marker(r)
    if not CLEAN and r.random() < 0.02:
        s += ' ;'
    return s


CHOSTS = ['https://example.com', 'http://example.com:8080', 'https://user:pass@host.example', 'ftp://x.test', 'file:///abs/dir',
          'git+https://github.com/x', 'git+ssh://git@github.com/x', 'svn+http://svn.example/x', 'hg+file:///repo', 'bzr+lp:x',
          'https://${MYVAR}@host.example', 'https://${HOSTV}', 'https://[::1]', 'https://[v1.x]:80', 'file://localhost/x']
CPATHS = ['/pkg-1.0.tar.gz', '/pkg-1.0-py3-none-any.whl', '/y.git', '/y.git@v1.0', '/p.zip', '/p.tar', '/x-1.0-py3-none-any.whl',
          '/a-1.0-1-py3-none-any.whl', '/my%20pkg-1.0-py3-none-any.whl', '/foo-1.0.post1-py3.py2-none-any.whl', '/dir/', '/',
          '/p.tar.bz2', '/p.tgz', '/Foo_Bar-2.0.dev1+local-py3-none-any.whl', '/A.b-C-1-py3-none-any.whl']
CFRAGS = ['', '', '', '#egg=foo', '#egg=foo-bar_baz', '#egg=foo&subdirectory=sub', '&egg=x', '#sha256=abc', '#egg=A', '#subdirectory=z',
          '#egg=a.b', '?x=1#egg=y']


def url_ref(r):
    if CLEAN:
        return r.choice(CHOSTS) + r.choice(CPATHS) + r.choice(CFRAGS)
    host = r.choice(URL_HOSTS)
    return host + r.choice(URL_PATHS) + r.choice(FRAGS)


def direct_req(r):
    name = r.choice(NAMES) + r.choice(['', '', '', r.choice(EXTRAS)])
    s = name + r.choice([' @ ', ' @ ', '@', ' @', ' @  ', '\t@\t']) + url_ref(r)
    if r.random() < 0.3:
        s += r.choice([' ; ', ';', ' ;', '  ; ']) + marker(r)
    return s


def bare_url(r):
    s = url_ref(r)
    if r.random() < 0.15:
        s += r.choice([' ; ', ';', ' ;', ' ; ']) + marker(r)
    return s


CPATH_REQS = ['./proj', 'proj', './proj[extra]', 'pyproj', './pkg-1.0.tar.gz', 'pkg-1.0.tar.gz', './missing-1.0.tar.gz',
              'x-1.0-py3-none-any.whl', './nonexist.whl', 'sub/y-2.0.zip', 'sub/proj2', './sub/../proj', '/abs/path.whl',
              './proj/', './x@y.whl', 'foo.tar.gz', 'foo.zip', 'foo@bar.tar.gz', './x.whl[extra]', './x-1.0-py3-none-any.whl[a,b]']


def path_req(r):
    s = r.choice(CPATH_REQS if CLEAN else PATHS)
    if r.random() < 0.1:
        s += r.choice([' ; ', ';']) + marker(r)
    return s


def req_body(r):
    x = r.random()
    if x < 0.5:
        return named_req(r)
    if x < 0.65:
        return direct_req(r)
    if x < 0.78:
        return bare_url(r)
    if x < 0.9:
        return path_req(r)
    return r.choice(['${REQV}', '${MYVAR}', '${NEST}', 'pkg==$MYVAR', 'pkg==${NOPE}', '${MYVAR}pkg', 'pkg${EMPTYV}',
                     'pkg==${A}', 'pkg ${OPTV}', 'pkg${SEMI}python_version>"3"', 'pkg ${HASHV}', 'pkg ${HASH} c',
                     'pkg ${BS}', 'requests==2.0 ${OPTV}', '${nonupper}', '${MIXED_case}', '$${MYVAR}', '${MYVAR', '${}', '$MYVAR'])


CHASH = [' --hash=sha256:abc123', ' --hash sha256:def456', ' --hash=sha512:ab', ' --hash=sha384:cd', ' -C a=b', ' -Ca=b',
         ' --config-settings=k=v', ' --config-settings=a=b --config-settings=a=c', ' -C a=b -C a=c -C a=d', ' -C a=',
         ' --hash=sha256:a --hash=sha256:b', ' --hash=sha256:a --hash=sha512:b', ' --pre', ' --use-feature=fast-deps',
         ' -r other.txt', ' --hash="sha256:a b"', " --hash='sha256:x'", ' --hash=sha256:', ' --hash=sha256:x  ', ' \t--hash=sha256:x',
         ' --index-url=x', ' --trusted-host h', ' --no-binary=:all:']


def req_line(r):
    s = req_body(r)
    k = r.choice([0, 0, 0, 1, 1, 2])
    for _ in range(k):
        s += r.choice(CHASH if CLEAN else HASH_OPTS)
    return s


CEDITS = ['./proj', 'proj', './proj[a,b]', '.', 'sub/proj2', 'file:///abs/proj', 'file:///abs/proj#egg=proj',
          'git+https://github.com/x/y.git#egg=y', 'git+ssh://git@github.com/x/y.git@main#egg=y&subdirectory=z',
          'git://x/y.git#egg=y', 'svn+http://x/y#egg=a', 'hg+file:///x#egg=a', 'bzr:x#egg=a', 'name @ git+https://x/y.git',
          'name[extra] @ file:///abs ; python_version>"3"', 'name @ https://x/y.zip', 'name @ file:///abs/x',
          'file:///abs#egg=a', './proj ; python_version>"3"', 'git+https://x/y.git#egg=a-b_c', 'GIT+HTTPS://X/Y#egg=a']


def edit_line(r):
    flag = r.choice(['-e ', '-e ', '--editable ', '--editable=', '-e', '-e\t', '-e  '])
    s = flag + r.choice(CEDITS if CLEAN else EDITS)
    if r.random() < 0.25:
        s += r.choice(CHASH if CLEAN else HASH_OPTS)
    return s


def one_line(r, allow_include=True):
    x = r.random()
    if x < 0.55:
        s = req_line(r)
    elif x < 0.68:
        s = edit_line(r)
    elif x < 0.86:
        s = r.choice(COPT_LINES if CLEAN else OPT_LINES)
        if not allow_include and (' -r' in ' ' + s or ' -c' in ' ' + s or 'requirement' in s or 'constraint' in s):
            s = '--pre'
    elif x < 0.93:
        s = ''
    else:
        s = r.choice(['\\', ' \\', 'foo \\', 'foo\\', 'foo \\ ', 'a\\b', '\\\\', 'foo \\\\', '# only comment', '   ',
                      'foo # c \\', '\t', ' # x', '#', 'foo\\\\\\'])
    s += r.choice(COMMENTS) if s and r.random() < 0.3 else ''
    if r.random() < 0.25 and s.strip():
        s = r.choice(['', '', '  ', '\t', ' ']) + s + r.choice(['', ' ', '  ', '\t'])
    if r.random() < 0.10:
        s += r.choice([' \\', '\\', ' \\'])
    return s


def mutate(r, text):
    if not text:
        return text
    for _ in range(r.choice([1, 1, 2, 3, 4]) if FUZZ else r.choice([1, 1, 2])):
        i = r.randrange(len(text) + 1)
        k = r.random()
        if k < 0.6:
            text = text[:i] + r.choice(SPECIAL) + text[i:]
        elif k < 0.85 and i < len(text):
            text = text[:i] + text[i + 1:]
        elif i < len(text):
            text = text[:i] + r.choice(SPECIAL) + text[i + 1:]
    return text


def make_file(r, depth=0, allow_include=True):
    n = r.choice([1, 1, 2, 3, 3, 4, 5, 8])
    lines = [one_line(r, allow_include) for _ in range(n)]
    if r.random() < (0.9 if FUZZ else 0.35 if CLEAN else 0.12):
        i = r.randrange(len(lines))
        lines[i] = mutate(r, lines[i])
        if FUZZ and r.random() < 0.5:
            j = r.randrange(len(lines))
            lines[j] = mutate(r, lines[j])
    nl = r.choice(NL)
    if r.random() < 0.1:
        nl = '\n'
    text = nl.join(lines)
    if r.random() < 0.6:
        text += nl
    if r.random() < 0.03:
        text = '\ufeff' + text
    if r.random() < 0.05:
        # mixed separators
        text = text.replace('\n', r.choice(NL), 1)
    return text


def make_case(r, i):
    global CLEAN
    CLEAN = r.random() < 0.5
    files = {}
    text = make_file(r)
    files['main.txt'] = text
    inc_used = any(k in text for k in ('other', 'cons', 'sub/', 'main.txt', 'self.txt', 'remote'))
    urls = {}
    if inc_used:
        files['other.txt'] = make_file(r, 1, allow_include=r.random() < 0.2)
        files['cons.txt'] = make_file(r, 1, allow_include=False)
        files['sub/nested.txt'] = r.choice(['-r ../other.txt\n', 'nested-pkg==1\n-c ../cons.txt\n', '-r nested2.txt\n', make_file(r, 1, False)])
        files['sub/nested2.txt'] = r.choice(['n2\n', '-r ../main.txt\n', '-r nested.txt\n'])
        files['sub/loop.txt'] = r.choice(['-r loop.txt\n', '-r ../sub/loop.txt\n', 'x\n-r nested.txt\n'])
        files['self.txt'] = r.choice(['-r self.txt\n', 'ok\n-r other.txt\n', '-c self.txt\n'])
        urls['http://example.test/remote.txt'] = r.choice(['remote-pkg\n', '-r other2.txt\n', '-r /abs.txt\n', '-r http://example.test/deep/x.txt\n', '-r sub/../y.txt\n'])
    main = 'main.txt'
    constraint = r.random() < 0.08
    if r.random() < 0.04:
        main = 'http://example.test/dir/main.txt'
        urls[main] = files.pop('main.txt')
        urls['http://example.test/dir/other.txt'] = 'urlpkg==1\n'
        urls['http://example.test/other.txt'] = 'urlpkg2\n'
        urls['http://example.test/dir/sub/x.txt'] = 'urlpkg3\n'
    if r.random() < 0.02:
        files.pop('other.txt', None)
    env = r.choice(ENVS)
    return {'id': i, 'files': files, 'main': main, 'env': env, 'constraint': constraint, 'urls': urls}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--count', type=int, default=10000)
    ap.add_argument('--fuzz', action='store_true', help='mutate almost every case')
    a = ap.parse_args()
    global FUZZ
    FUZZ = a.fuzz
    r = random.Random(a.seed)
    seen = set()
    cases = []
    i = 0
    while len(cases) < a.count:
        c = make_case(r, i)
        i += 1
        key = json.dumps([c['files'], c['main'], c['env'], c['constraint'], c['urls']], sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        c['id'] = len(cases)
        cases.append(c)
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(cases, f, ensure_ascii=False)
    print(f'wrote {len(cases)} cases (seed {a.seed})')


if __name__ == '__main__':
    main()
