#!/usr/bin/env python3
"""Fail if any ```python block in the vault is not valid Python.

    python3 tools/check-python.py
"""
import ast
import glob
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOTS = ('LLD', 'DSA')
BLOCK = re.compile(r'^```python[^\n]*\n(.*?)^```[ \t]*$', re.M | re.S)


def main() -> int:
    ok = failed = 0
    for root in ROOTS:
        for path in sorted(glob.glob(os.path.join(REPO, root, '**', '*.md'), recursive=True)):
            src = open(path, encoding='utf-8').read()
            for match in BLOCK.finditer(src):
                body = match.group(1)
                line_no = src[:match.start()].count('\n') + 1
                try:
                    ast.parse(body)
                    ok += 1
                except SyntaxError as err:
                    failed += 1
                    rel = os.path.relpath(path, REPO)
                    print(f'{rel}:{line_no}: block does not parse — {err.msg} (block line {err.lineno})')
                    offending = body.split('\n')[(err.lineno or 1) - 1] if err.lineno else ''
                    if offending.strip():
                        print(f'    {offending.strip()[:100]}')
    print(f'python blocks: {ok} valid, {failed} invalid')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
