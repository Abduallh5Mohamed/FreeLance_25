'use strict';
// Computes a scope digest only. Does not approve or modify a task.
const fs=require('node:fs');
const {scopeHash}=require('./mailbox-core.cjs');
try {const task=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));console.log(scopeHash(task));}
catch(e){console.error(e.message);process.exitCode=1;}
