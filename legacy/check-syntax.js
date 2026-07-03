// Extracts inline <script> blocks from index.html and parse-checks each.
// Parsing (not executing) validates syntax incl. our edits; undefined
// browser globals are fine because we never run the code.
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m, idx = 0, errors = 0, checked = 0;
while ((m = re.exec(html)) !== null) {
  const attrs = m[1] || '';
  if (/\bsrc\s*=/.test(attrs)) continue; // external script, nothing inline
  if (/type\s*=\s*["'](?!text\/javascript|module|application\/javascript)/i.test(attrs)) continue; // non-JS (e.g. templates)
  const code = m[2];
  if (!code.trim()) continue;
  idx++;
  // Compute line number where this block starts for useful error context
  const startLine = html.slice(0, m.index).split('\n').length;
  try {
    // new Function parses the body without executing it.
    new Function(code);
    checked++;
  } catch (e) {
    errors++;
    console.error(`\n✗ Syntax error in <script> block #${idx} (starts ~line ${startLine}):`);
    console.error(`  ${e.message}`);
  }
}
console.log(`\nChecked ${checked} inline script block(s); ${errors} error(s).`);
process.exit(errors ? 1 : 0);
