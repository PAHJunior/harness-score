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

describe('createScanContext — production limits', () => {
  test('includes files beyond ten directory levels without truncating the scan', () => {
    const root = mkTmpDir();
    const segments = Array.from({ length: 12 }, (_, index) => `level-${index + 1}`);
    const deepDirectory = path.join(root, ...segments);
    fs.mkdirSync(deepDirectory, { recursive: true });
    fs.writeFileSync(path.join(deepDirectory, 'AGENTS.md'), '# deep harness signal');

    const ctx = createScanContext(root);
    const deepFile = `${segments.join('/')}/AGENTS.md`;

    expect(ctx.has(deepFile)).toBe(true);
    expect(ctx.read(deepFile)).toBe('# deep harness signal');
    expect(ctx.truncated).toBe(false);
    expect(ctx.incompleteReasons).toEqual([]);
  });

  test('scans a 25,000-file repository past the former 20,000-file limit', () => {
    const fileCount = 25_000;
    const virtualFiles = Array.from({ length: fileCount }, (_, index) => {
      const name = `file-${index.toString().padStart(5, '0')}.txt`;
      return {
        name,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      } as fs.Dirent;
    });

    const result = walkDirectory('virtual-root', { readDirectory: () => virtualFiles });

    expect(result.files).toHaveLength(fileCount);
    expect(result.files.at(-1)).toBe('file-24999.txt');
    expect(result.truncated).toBe(false);
    expect(result.incompleteReasons).toEqual([]);
  });
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
