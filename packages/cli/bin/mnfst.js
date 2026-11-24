#!/usr/bin/env node
'use strict';

const { main } = require('../dist/index.js');

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    // Last-resort guard: main() handles its own errors; anything landing here
    // is a bug in the CLI itself.
    console.error(String(err && err.stack ? err.stack : err));
    process.exitCode = 1;
  },
);
