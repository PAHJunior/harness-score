#!/usr/bin/env node
/**
 * Scan-time benchmark against a synthetic large repository. Not part of the
 * test suite (no pass/fail assertion) — a manual before/after measurement
 * tool for changes to scan.ts, per the distribution/perf improvement plan.
 * Run with `npm run bench -- 5000,25000 5` (requires `npm run build` first).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { score } from '../dist/index.js';

const FILE_COUNTS = String(process.argv[2] ?? '5000')
  .split(',')
  .map((value) => Number(value));
const ITERATIONS = Number(process.argv[3] ?? 5);

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function buildSyntheticRepo(root, fileCount) {
  fs.mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n\nThis is a benchmark fixture.\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'bench', version: '1.0.0' }));
  for (let i = 0; i < 10; i += 1) {
    fs.writeFileSync(
      path.join(root, '.cursor', 'rules', `rule-${i}.mdc`),
      `---\ndescription: rule ${i}\nglobs: "src/**"\n---\n\nBody text.\n`,
    );
  }
  // Bulk of the tree: a mix of source and test files spread across nested
  // directories, mirroring what a real large monorepo's `files` list looks
  // like (this is what scan.ts's walk + every check's matching() calls
  // actually have to work through).
  const perDir = 100;
  let written = 0;
  let dirIndex = 0;
  while (written < fileCount) {
    const dir = path.join(root, 'src', `module-${dirIndex}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < perDir && written < fileCount; i += 1, written += 1) {
      const isTest = i % 5 === 0;
      const name = isTest ? `file-${i}.test.ts` : `file-${i}.ts`;
      fs.writeFileSync(path.join(dir, name), `export const value${i} = ${i};\n`);
    }
    dirIndex += 1;
  }
}

for (const fileCount of FILE_COUNTS) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-score-bench-'));
  console.log(`Building synthetic repo with ~${fileCount} files at ${root} ...`);
  buildSyntheticRepo(root, fileCount);

  const timings = [];
  let peakRss = 0;
  for (let i = 0; i < ITERATIONS; i += 1) {
    const start = process.hrtime.bigint();
    const report = score(root);
    const end = process.hrtime.bigint();
    if (report.verdicts?.maturity.status !== 'complete') {
      throw new Error(`Benchmark scan was incomplete at ${fileCount} files.`);
    }
    const ms = Number(end - start) / 1e6;
    const rss = process.memoryUsage().rss;
    timings.push(ms);
    peakRss = Math.max(peakRss, rss);
    console.log(
      `  run ${i + 1}/${ITERATIONS}: ${ms.toFixed(1)}ms, RSS ${formatMiB(rss)} (level ${report.level.name}, ${report.checks.length} checks)`,
    );
  }

  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  const sorted = [...timings].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
  console.log(`Average over ${ITERATIONS} runs: ${avg.toFixed(1)}ms (${fileCount} files)`);
  console.log(`Median over ${ITERATIONS} runs: ${median.toFixed(1)}ms (${fileCount} files)`);
  console.log(`Peak RSS over ${ITERATIONS} runs: ${formatMiB(peakRss)} (${fileCount} files)`);

  fs.rmSync(root, { recursive: true, force: true });
}
