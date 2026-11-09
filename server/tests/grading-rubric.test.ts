import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGradingRubric, scoreGradingRubric } from '../src/services/grading-rubric';
const criteria = [{key:'method',label:'خطوات الحل',max_points:'2.10'},{key:'result',label:'النتيجة',max_points:'0.20'}];
test('rubric totals use exact hundredths of the pinned question without changing exam marks',()=>{
  const r=parseGradingRubric(criteria,'2.30');
  assert.equal(r.total_points,'2.30');
  assert.equal(scoreGradingRubric(r,[{key:'result',points:'0.10'},{key:'method',points:'0.20'}]).points,'0.30');
  assert.throws(()=>parseGradingRubric(criteria,'3.00'));
});
test('rubric criteria reject duplicates, authority fields and unbounded or zero-weight definitions',()=>{
  for(const raw of [[],Array(21).fill(criteria[0]),[criteria[0],criteria[0]],[{...criteria[0],tenant_id:'forged'}],[{...criteria[0],label:' '}],[{...criteria[0],max_points:'0'}]])assert.throws(()=>parseGradingRubric(raw,'2.10'));
});
test('rubric marks require the complete criterion set and reject client totals or invented criteria',()=>{
  const r=parseGradingRubric(criteria,'2.30');
  for(const raw of [[],[{key:'method',points:'1'}],[{key:'method',points:'1'},{key:'method',points:'1'}],[{key:'method',points:'2.11'},{key:'result',points:'0'}],[{key:'other',points:'0'},{key:'result',points:'0'}],[{key:'method',points:'1',total:'2.30'},{key:'result',points:'0'}]])assert.throws(()=>scoreGradingRubric(r,raw));
});
test('rubric never accepts partial numeric strings, excess precision or non-finite/negative values',()=>{
  for(const points of ['12abc','1.234','Infinity','NaN','-1','1e0',' 1','1.','0x10',Infinity,1]){
    assert.throws(()=>parseGradingRubric([{...criteria[0],max_points:points}],'2.10'));
    assert.throws(()=>scoreGradingRubric(parseGradingRubric(criteria,'2.30'),[{key:'method',points},{key:'result',points:'0'}]));
  }
});
