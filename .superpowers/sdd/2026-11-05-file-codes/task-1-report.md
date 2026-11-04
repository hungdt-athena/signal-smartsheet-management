# Task 1 report
Implemented lib/short-code.ts (CODE_ALPHABET, generateCode, isCode, codeFromFileName) and __tests__/lib/short-code.test.ts.
RED: jest failed, module '@/lib/short-code' not found (suite failed, 0 tests).
GREEN: 1 suite, 11 tests passed.
Files: lib/short-code.ts, __tests__/lib/short-code.test.ts.
Self-review: alphabet verbatim; extension stripped once (/\.[^.]*$/), then one " (n)" suffix, trim, upper-case, then regex. All brief cases covered.
Concerns: none.
