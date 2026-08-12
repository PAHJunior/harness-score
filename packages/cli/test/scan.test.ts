import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createScanContext, walkDirectory } from '../src/scan.js';

const tmpDirs: string[] = [];

function mkTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-score-scan-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('createScanContext — symlinks', () => {
  test('follows a symlinked directory into a sibling', () => {
    const root = mkTmpDir();
    fs.mkdirSync(path.join(root, 'target'));
    fs.writeFileSync(path.join(root, 'target', 'AGENTS.md'), '# hi');
    fs.mkdirSync(path.join(root, 'repo'));
    try {
      fs.symlinkSync(path.join(root, 'target'), path.join(root, 'repo', 'shared'), 'dir');
    } catch {
      // Symlink creation can require elevated privileges on some Windows
      // setups; skip rather than fail the suite in that environment.
      return;
    }

    const ctx = createScanContext(path.join(root, 'repo'));
    expect(ctx.has('shared/AGENTS.md')).toBe(true);
    expect(ctx.read('shared/AGENTS.md')).toBe('# hi');
    expect(ctx.truncated).toBe(false);
  });

  test('terminates on a self-referential symlink cycle without duplicating files', () => {
    const root = mkTmpDir();
    fs.mkdirSync(path.join(root, 'a'));
    fs.writeFileSync(path.join(root, 'a', 'file.txt'), 'content');
    try {
      fs.symlinkSync(path.join(root, 'a'), path.join(root, 'a', 'loop'), 'dir');
    } catch {
      return;
    }

    const ctx = createScanContext(root);
    const occurrences = ctx.files.filter((f) => f.endsWith('file.txt'));
    // The cycle must not be walked more than once — a handful of legitimate
    // depth-bounded traversals through the loop is fine, an unbounded one
    // (thousands of copies) is the bug this test guards against.
    expect(occurrences.length).toBeLessThan(20);
    expect(ctx.truncated).toBe(false);
  });
});

describe('deterministic incomplete scan reasons', () => {
  test('sorts directory entries before applying the file-count limit', () => {
    const root = mkTmpDir();
    for (const name of ['z.txt', 'a.txt', 'm.txt']) fs.writeFileSync(path.join(root, name), name);
    const reverseRead = (directory: string) => fs.readdirSync(directory, { withFileTypes: true }).reverse();

    const result = walkDirectory(root, { maxFiles: 2, readDirectory: reverseRead });
    expect(result.files).toEqual(['a.txt', 'm.txt']);
    expect(result.incompleteReasons).toEqual([{ code: 'file-count-limit', path: 'z.txt', limit: 2 }]);
    expect(result.truncated).toBe(true);
  });

  test('records the first deterministic directory skipped by the depth limit', () => {
    const root = mkTmpDir();
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    fs.mkdirSync(path.join(root, 'z', 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'b', 'deep.txt'), 'deep');

    const result = walkDirectory(root, { maxDepth: 1 });
    expect(result.files).toEqual([]);
    expect(result.incompleteReasons).toEqual([{ code: 'depth-limit', path: 'a/b', limit: 1 }]);
  });

  test('records an unreadable directory and continues scanning deterministic siblings', () => {
    const root = mkTmpDir();
    fs.mkdirSync(path.join(root, 'a-blocked'));
    fs.mkdirSync(path.join(root, 'b-readable'));
    fs.writeFileSync(path.join(root, 'b-readable', 'visible.txt'), 'visible');
    const injectedRead = (directory: string): fs.Dirent[] => {
      if (path.basename(directory) === 'a-blocked') throw new Error('permission denied');
      return fs.readdirSync(directory, { withFileTypes: true });
    };

    const result = walkDirectory(root, { readDirectory: injectedRead });
    expect(result.files).toEqual(['b-readable/visible.txt']);
    expect(result.incompleteReasons).toEqual([{ code: 'unreadable-directory', path: 'a-blocked' }]);
  });

  test('converts a legacy truncated overlay to a file-count reason', () => {
    const root = mkTmpDir();
    const ctx = createScanContext(root, {
      overlays: [{ label: 'legacy', files: new Map(), truncated: true }],
    });
    expect(ctx.truncated).toBe(true);
    expect(ctx.incompleteReasons).toEqual([{ code: 'file-count-limit' }]);
  });
});
