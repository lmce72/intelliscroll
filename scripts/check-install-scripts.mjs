/**
 * Keep `allowScripts` in step with the lockfile.
 *
 * npm 12 blocks dependency install scripts unless `package.json`'s
 * `allowScripts` lists them, and with `strict-allow-scripts` an unlisted script
 * fails the whole install. Obsidian's plugin scanner runs that install, so a
 * dependency that gains a script between releases turns into
 * "Source review dependency installation failed" even though npm 11 installs
 * the same tree without complaint.
 *
 * Each locked package with an install script must therefore be named in
 * `allowScripts` (as `name` or `name@range`), either approved (`true`) or
 * explicitly denied (`false`).
 */
import { readFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const allowScripts = pkg.allowScripts ?? {};
const keys = Object.keys(allowScripts);

const uncovered = Object.entries(lock.packages ?? {})
  .filter(([path, entry]) => path !== '' && entry.hasInstallScript)
  .map(([path, entry]) => ({
    name: entry.name ?? path.replace(/^.*node_modules\//, ''),
    version: entry.version,
  }))
  .filter(
    ({ name }) =>
      !keys.some((key) => key === name || key.startsWith(`${name}@`))
  );

if (uncovered.length > 0) {
  console.error(
    "These dependencies have install scripts that package.json's allowScripts " +
      "does not cover, so npm 12's strict install (and Obsidian's source " +
      'review) will fail:'
  );
  for (const { name, version } of uncovered) {
    console.error(`  ${name}@${version}`);
  }
  console.error(
    '\nAdd each to allowScripts: false if the package works without its ' +
      'script, true (or name@version) if it needs it to run.'
  );
  process.exit(1);
}

console.log('install scripts covered by allowScripts');
