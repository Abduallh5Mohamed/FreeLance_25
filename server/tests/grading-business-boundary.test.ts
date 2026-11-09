import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualGradingRouter } from '../src/routes/manual-grading';
import { invokeRoute } from './helpers/m2-harness';
import { Router } from 'express';
import { createGradingControlRouter } from '../src/routes/grading-control';

test('binary assignment keys reject UUID case aliases before any database work',async()=>{
 let calls=0;const router=Router();router.use((req:any,_res,next)=>{req.user={id:'teacher',role:'teacher',tenantId:'tenant'};next();});router.use(createGradingControlRouter({getConnection:async()=>{calls++;throw Error('No query expected');}}));
 const canonical='b6000000-0000-4000-8000-000000000001';
 assert.equal((await invokeRoute(router,{method:'GET',url:'/grading/questions/'+canonical.toUpperCase()+'/assignment'})).statusCode,400);
 assert.equal((await invokeRoute(router,{method:'POST',url:'/grading/questions/'+canonical+'/assignment',body:{operation_id:canonical.toUpperCase()}})).statusCode,400);assert.equal(calls,0);
});
for (const route of [{ method: 'GET', url: '/pending' }, { method: 'POST', url: '/submit' }])
    test('legacy marking denies business admin before platform or student data lookup: ' + route.method, async () => {
        let calls = 0;
        const forbidden = async () => { calls++; throw Error('No academic query expected'); };
        const router = createManualGradingRouter({ db: { query: forbidden, queryOne: forbidden, execute: forbidden, withTransaction: forbidden } as any, optionalAuthenticate: (req: any, _res, next) => { req.user = { id: 'platform-admin', role: 'admin', tenantId: 'selected-tenant', identitySource: 'users' }; next(); }, authenticate: (_req, _res, next) => next(), isPlatformAdmin: async () => { calls++; return true; } });
        const result = await invokeRoute(router, route);
        assert.equal(result.statusCode, 403);
        assert.equal(calls, 0);
    });
