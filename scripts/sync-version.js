#!/usr/bin/env node
// Run automatically by `npm version` (version hook, before the commit/tag).
// Writes the canonical version from package.json to apps/collector/VERSION
// so the Python collector (whose Docker context is apps/collector/) can read it.
// The npm "version" script also `git add`s the file so it lands in the tag.
const { version } = require('../package.json');
const { writeFileSync } = require('fs');
const { join } = require('path');

const dest = join(__dirname, '..', 'apps', 'collector', 'VERSION');
writeFileSync(dest, version + '\n', 'utf8');
console.log(`sync-version: apps/collector/VERSION → ${version}`);
