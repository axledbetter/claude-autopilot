import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, formatDiffContent } from '../src/core/git/diff-hunks.ts';

const SAMPLE_DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
index abc1234..def5678 100644
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -10,7 +10,7 @@ export async function login(req: Request) {
   const user = await db.users.findOne({ email });
-  if (!user || user.password !== req.body.password) {
+  if (!user || !(await bcrypt.compare(req.body.password, user.passwordHash))) {
     return res.status(401).json({ error: 'Invalid credentials' });
   }
 }
diff --git a/src/utils/format.ts b/src/utils/format.ts
index 111aaaa..222bbbb 100644
--- a/src/utils/format.ts
+++ b/src/utils/format.ts
@@ -1,3 +1,4 @@
+import { sanitize } from './sanitize.ts';
 export function formatName(name: string): string {
-  return name.trim();
+  return sanitize(name.trim());
 }
`;

describe('parseUnifiedDiff', () => {
  it('parses two file sections', () => {
    const result = parseUnifiedDiff(SAMPLE_DIFF, ['src/auth/login.ts', 'src/utils/format.ts']);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.file, 'src/auth/login.ts');
    assert.equal(result[1]!.file, 'src/utils/format.ts');
  });

  it('counts additions and deletions', () => {
    const result = parseUnifiedDiff(SAMPLE_DIFF, ['src/auth/login.ts']);
    assert.equal(result[0]!.additions, 1);
    assert.equal(result[0]!.deletions, 1);
  });

  it('only includes requested files', () => {
    const result = parseUnifiedDiff(SAMPLE_DIFF, ['src/auth/login.ts']);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.file, 'src/auth/login.ts');
  });

  it('returns empty array for empty diff', () => {
    assert.deepEqual(parseUnifiedDiff('', ['src/foo.ts']), []);
  });

  it('hunk content starts at @@', () => {
    const result = parseUnifiedDiff(SAMPLE_DIFF, ['src/auth/login.ts']);
    assert.ok(result[0]!.hunks.startsWith('@@'));
  });

  it('does not include index/--- header lines in hunks', () => {
    const result = parseUnifiedDiff(SAMPLE_DIFF, ['src/auth/login.ts']);
    assert.ok(!result[0]!.hunks.includes('index abc1234'));
    assert.ok(!result[0]!.hunks.includes('--- a/'));
  });
});

describe('formatDiffContent', () => {
  it('wraps diffs in markdown code blocks with file headers', () => {
    const diffs = [{ file: 'src/auth/login.ts', hunks: '@@ -1,1 +1,1 @@\n-old\n+new', additions: 1, deletions: 1 }];
    const out = formatDiffContent(diffs);
    assert.ok(out.includes('## src/auth/login.ts'));
    assert.ok(out.includes('```diff'));
    assert.ok(out.includes('+new'));
  });

  it('omits files exceeding maxChars and appends a summary notice', () => {
    const bigHunks = 'x'.repeat(200);
    const diffs = [
      { file: 'a.ts', hunks: bigHunks, additions: 1, deletions: 0 },
      { file: 'b.ts', hunks: bigHunks, additions: 1, deletions: 0 },
    ];
    const out = formatDiffContent(diffs, 300);
    assert.ok(out.includes('omitted'), `expected omission notice, got: ${out}`);
    assert.ok(!out.includes('## b.ts'), `b.ts header should be absent, got: ${out}`);
  });

  it('returns empty string for empty diffs', () => {
    assert.equal(formatDiffContent([]), '');
  });
});
