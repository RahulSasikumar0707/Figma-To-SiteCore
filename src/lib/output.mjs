// Output_N folder management: each run allocates the next free Output_<n>
// directory (Output_1 on first run, Output_2 on the second, ...).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function allocateOutputDir(rootDir) {
  let n = 1;
  while (fs.existsSync(path.join(rootDir, `Output_${n}`))) n++;
  const dir = path.join(rootDir, `Output_${n}`);
  fs.mkdirSync(path.join(dir, 'assets', 'css'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets', 'js'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'report'), { recursive: true });
  return { dir, n };
}

export async function writeFiles(outDir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(outDir, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, content, 'utf8');
  }
}

export async function writeReport(outDir, name, data) {
  const dest = path.join(outDir, 'report', name);
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  await fsp.writeFile(dest, body, 'utf8');
}

// Sanity-check that every local asset referenced by the generated files exists.
export function findBrokenAssetRefs(outDir, files) {
  const broken = [];
  const refRe = /(?:src|href)=["'](assets\/[^"']+)["']|url\(["']?(assets\/[^"')]+)["']?\)/g;
  for (const [rel, content] of Object.entries(files)) {
    let m;
    while ((m = refRe.exec(content)) !== null) {
      const ref = (m[1] || m[2]).split(/[?#]/)[0];
      if (!fs.existsSync(path.join(outDir, ref))) broken.push({ file: rel, ref });
    }
  }
  return broken;
}
