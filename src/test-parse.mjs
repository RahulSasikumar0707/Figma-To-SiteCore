// Regression tests for parseFileBlocks against realistic LLM output variants.
import { parseFileBlocks } from './lib/util.mjs';

let failures = 0;
function check(name, text, expect) {
  const got = parseFileBlocks(text);
  for (const [k, v] of Object.entries(expect)) {
    const actual = (got[k] || '').trim();
    if (actual !== v) {
      console.error(`FAIL ${name}: ${k}\n  expect: ${JSON.stringify(v)}\n  got:    ${JSON.stringify(actual)}`);
      failures++;
    }
  }
  const extra = Object.keys(got).filter((k) => !(k in expect));
  if (extra.length) { console.error(`FAIL ${name}: unexpected keys ${extra}`); failures++; }
}

check('canonical', `===FILE: index.html===
<html>A</html>
===FILE: assets/css/styles.css===
.a{}
===FILE: assets/js/script.js===
console.log(1)
`, { 'index.html': '<html>A</html>', 'assets/css/styles.css': '.a{}', 'assets/js/script.js': 'console.log(1)' });

check('no-space-after-colon', `===FILE:index.html===
<html>B</html>
===FILE:assets/css/styles.css===
.b{}
`, { 'index.html': '<html>B</html>', 'assets/css/styles.css': '.b{}' });

check('lowercase-and-extra-spaces', `===file:  section.html===
<div>C</div>
==FILE: section.css==
.c{}
`, { 'section.html': '<div>C</div>', 'section.css': '.c{}' });

check('fenced-content', `===FILE: section.html===
\`\`\`html
<div>D</div>
\`\`\`
===FILE: section.js===
\`\`\`js
(function(){})()
\`\`\`
`, { 'section.html': '<div>D</div>', 'section.js': '(function(){})()' });

check('content-mentions-next-path', `===FILE: index.html===
<!-- see FILE: assets/css/styles.css for styles -->
<html>E</html>
===FILE: assets/css/styles.css===
.e{}
`, { 'index.html': '<!-- see FILE: assets/css/styles.css for styles -->\n<html>E</html>', 'assets/css/styles.css': '.e{}' });

if (failures) { console.error(failures + ' failures'); process.exit(1); }
console.log('parseFileBlocks: all tests passed');
