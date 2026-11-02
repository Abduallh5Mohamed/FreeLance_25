const path = require('node:path');
const h = require('../server/tests/helpers/m2-course-lessons-harness.ts');
const isolation = h.createIsolation();
process.env.JWT_SECRET = h.TEST_SECRET;
const modules = h.loadAppModules(isolation,path.resolve(__dirname,'../server/src/routes/tenant-self'));
(async () => {
  const state = h.makeState();
  const prerequisite = state.lessons.find(l => l.id === h.LESSON_1);
  const dependent = state.lessons.find(l => l.id === h.LESSON_2);
  prerequisite.display_order = 1;
  dependent.display_order = 2;
  dependent.prerequisite_lesson_id = prerequisite.id;
  const harness = h.buildHarness(state,modules);
  const result = await h.runChain(harness.chain,h.reorderReq({items:[
    {id:prerequisite.id,display_order:5},
    {id:dependent.id,display_order:6},
  ]}));
  console.log(JSON.stringify({status:result.status,body:result.body,final:[prerequisite.display_order,dependent.display_order],events:harness.events}));
})().catch(e=>{console.error(e);process.exitCode=1});
