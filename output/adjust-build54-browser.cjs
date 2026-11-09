const fs=require('node:fs'),path=require('node:path');const file=path.join(__dirname,'verify-build54-support-browser.cjs');let s=fs.readFileSync(file,'utf8');
function replace(old,next){if(s.split(old).length!==2)throw Error('Expected unique browser anchor');s=s.replace(old,next);}
replace("assert.equal(createPosts,1);checks.push", "assert.equal(createPosts,1);assert.equal(await p.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('tabweb.support.attempt.v1.')&&k.includes('.create.')).length),0);checks.push");
replace("assert.equal(assignmentPosts,1);await assignment.screenshot", "assert.equal(assignmentPosts,1);assert.equal(await p.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('tabweb.support.attempt.v1.')&&k.includes('.assign.')).length),0);await assignment.screenshot");
fs.writeFileSync(file,s);
