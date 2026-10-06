import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { splitCommitOutput } from '../../src/ui/scc-commit-output.ts';

describe('splitCommitOutput', () => {
  it('keeps empty merge metadata without inventing a patch', () => {
    const parsed = splitCommitOutput('commit abc\nMerge: 111 222\nAuthor: Tester\nDate: Today\n\n    Merge branches\n');
    assert.equal(parsed.subject, 'Merge branches');
    assert.equal(parsed.patch, '');
  });
  it('parses git show header and strips stat summary before the diff', () => {
    const stdout = `commit 75b5458abc123def4567890abcdef1234567890
Author: Minnow Tester <test@example.com>
Date:   Sun Aug 2 12:00:00 2026 -0700

    fix history panel

 tracked.txt | 1 +
 1 file changed, 1 insertion(+)

diff --git a/tracked.txt b/tracked.txt
index 1111111..2222222 100644
--- a/tracked.txt
+++ b/tracked.txt
@@ -1 +1 @@
-old
+new
`;

    const parsed = splitCommitOutput(stdout);
    assert.equal(parsed.subject, 'fix history panel');
    assert.equal(parsed.author, 'Minnow Tester <test@example.com>');
    assert.match(parsed.date, /2026/);
    assert.match(parsed.patch, /^diff --git/);
    assert.doesNotMatch(parsed.subject, /files changed/);
  });
});
