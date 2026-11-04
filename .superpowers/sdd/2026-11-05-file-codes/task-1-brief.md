### Task 1: Code generator and file-name parser

**Files:**
- Create: `lib/short-code.ts`
- Test: `__tests__/lib/short-code.test.ts`

**Interfaces:**
- Produces: `CODE_ALPHABET: string`, `generateCode(): string`, `isCode(s: string): boolean`, `codeFromFileName(fileName: string): string | null` (returns the upper-cased code or `null`).

- [ ] **Step 1: Write the failing tests.** `generateCode` returns 6 chars, every char in `CODE_ALPHABET`, none of `0O1IL`; 1,000 calls give no malformed value. `codeFromFileName`: `'K7M2QX.mp4'`→`'K7M2QX'`, `'k7m2qx.MP4'`→`'K7M2QX'`, `'K7M2QX (1).mp4'`→`'K7M2QX'`, `'K7M2QX .mp4'`→`'K7M2QX'`, `'K7M2QX.mp4.mp4'`→`null`, `'K7M2QX_20mins.mp4'`→`null`, `'K7M2Q.mp4'`→`null`, `'K7M2QXA.mp4'`→`null`, `'K7M2O1.mp4'`→`null` (contains excluded chars), `'Racket.mp4'`→`'RACKET'` (this one is a code by form; Task 6 handles the miss).
- [ ] **Step 2: Run** `npx jest __tests__/lib/short-code.test.ts` — expected FAIL (module not found).
- [ ] **Step 3: Implement** the four exports in `lib/short-code.ts`. Use `crypto.randomInt` per character. Strip one extension, then one ` (n)` suffix, then trim, before testing the pattern.
- [ ] **Step 4: Run** the same command — expected PASS.
- [ ] **Step 5: Commit** `feat(codes): short code generator and file-name parser`.

