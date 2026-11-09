const fs=require('node:fs'),p='src/features/grading/GradingRubricEditor.tsx';let s=fs.readFileSync(p,'utf8').replace(".replaceAll('-','')",".replace(/-/g,'')");fs.writeFileSync(p,s);
