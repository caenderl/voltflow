#!/usr/bin/env node
// Run automatically by `npm version` (postversion hook).
// Writes the canonical version from package.json to apps/collector/VERSION
// so the Python collector (whose Docker context is apps/collector/) can read it.
const { version } = require('../package.json');
const { writeFileSync } = require('fs');
const { join } = require('path');

const dest = join(__dirname, '..', 'apps', 'collector', 'VERSION');
writeFileSync(dest, version + '\n', 'utf8');
console.log(`sync-version: apps/collector/VERSION → ${version}`);
