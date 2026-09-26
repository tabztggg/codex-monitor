import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountUsageHistory } from '../account-usage';
import { codexUsageFromRateLimitsRead } from '../usage';

it('keeps accounts separate, persists only display fields, and survives restart',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'monitor-accounts-'));const file=path.join(dir,'accounts.json');
  try{
    const usage=(email:string,percent:number)=>({...codexUsageFromRateLimitsRead({rateLimits:{secondary:{usedPercent:percent,windowDurationMins:10080,resetsAt:2000000000}}},'2026-09-26T00:00:00Z'),account:{type:'chatgpt',email,planType:'pro'},access_token:'never-save-me'});
    const a=usage('a@example.test',12),b=usage('b@example.test',44);
    const history=new AccountUsageHistory(file);history.record(a);history.record(b);
    expect(history.list(b).map(x=>x.current)).toEqual([true,false]);
    expect(history.list(b)[1].usage.primaryLimit?.secondary?.usedPercent).toBe(12);
    history.record({...a,stale:true,primaryLimit:b.primaryLimit});
    expect(history.list(b)[1].usage.primaryLimit?.secondary?.usedPercent).toBe(12);
    expect(readFileSync(file,'utf8')).not.toContain('never-save-me');
    const restored=new AccountUsageHistory(file).list(b);
    expect(restored).toHaveLength(2);expect(restored[0].usage.primaryLimit?.secondary?.usedPercent).toBe(44);
    expect(restored[0].usage.primaryLimit?.secondary?.resetsAt).toBe(b.primaryLimit?.secondary?.resetsAt);
    history.record({...a,account:null});expect(history.list(b)).toHaveLength(2);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
