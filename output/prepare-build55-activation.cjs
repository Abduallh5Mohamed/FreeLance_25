const fs=require('node:fs');let s=fs.readFileSync('output/activate-demo-preparation.cjs','utf8');
s=s.replace("const specs=[{file:","const specs=[{file:");
const a=s.indexOf(' const specs='),b=s.indexOf('\n const sections=',a);if(a<0||b<0)throw Error('TEMPLATE_CHANGED');
s=s.slice(0,a)+" const specs=[{file:'20261018_08_question_bank_assignments.sql',start:'SET @has_qb_usages =',end:null,prefix:'SET @m4_db = DATABASE();\\n'}];"+s.slice(b);
s=s.replace('b=sql.indexOf(s.end,a)','b=s.end?sql.indexOf(s.end,a):sql.length').replaceAll('build48','build55').replaceAll('before-build55-preparation','before-build55-quiz').replaceAll('DEMO_PREPARATION','DEMO_QUIZ');
fs.writeFileSync('output/activate-demo-quiz.cjs',s);
