const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const files=['server/src/routes/student-account-link.ts','server/tests/student-account-link.test.ts','src/features/enrollment/account-link.ts','src/features/enrollment/AccountLinkPanels.tsx','src/tests/student-account-link.test.ts'];
for(const file of files){const p=path.join(__dirname,'..',file),source=ts.createSourceFile(p,fs.readFileSync(p,'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);if(source.parseDiagnostics.length)throw Error('Parse error: '+file);fs.writeFileSync(p,ts.createPrinter({newLine:ts.NewLineKind.LineFeed}).printFile(source));}
console.log('Formatted five new BUILD-52 TypeScript files only.');
