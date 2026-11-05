import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import StudentImportGuide from '../src/features/students/StudentImportGuide';
import { describeStudentImportNextStep } from '../src/features/students/import-guide';

(globalThis as { React?: unknown }).React = React;
const cssName = readdirSync('dist/assets').find(name => name.endsWith('.css'))!;
const css = readFileSync(`dist/assets/${cssName}`, 'utf8');
const input = { previewPhase: 'ready', hasRows: true, gate: { ok: false, reason: 'not-reconciled', rowNumbers: [] },
  serverPhase: 'idle', serverAvailable: true, commitPhase: 'idle', hasConfirmedResult: false } as const;
const html = renderToStaticMarkup(<main className="mx-auto max-w-5xl space-y-6 p-4" dir="rtl">
  <h1 className="text-2xl font-bold">خطوات استيراد الطلاب</h1>
  <StudentImportGuide guide={describeStudentImportNextStep(input)} />
  <section id="student-import-matching" tabIndex={-1} className="rounded-lg border p-4">قسم المطابقة - بيانات توضيحية بلا طلاب</section>
</main>);
writeFileSync('tmp/business-import-preview.html', `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>Import guide visual check</title><style>${css}</style><body style="background:#fff;font-family:Tahoma,sans-serif">${html}</body></html>`, 'utf8');
