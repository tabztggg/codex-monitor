import express from 'express';
import { createServer } from 'node:http';
import { installServiceControl } from '../service-control';

it.each([['restart',42],['stop',0]] as const)('accepts remote %s without credentials, once', async (action, code) => {
  const app=express(); app.use(express.json());
  const exits:number[]=[];
  installServiceControl(app,true,value=>exits.push(value));
  const server=createServer(app);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/service`;
  try {
    const config=await fetch(url).then(r=>r.json());
    expect(config.enabled).toBe(true); expect(config.token).toBeUndefined();
    const post=(body:string)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':'192.0.2.5'},body:JSON.stringify({action:body})});
    expect((await post('invalid')).status).toBe(400);
    expect((await post(action)).status).toBe(202);
    expect((await post(action)).status).toBe(409);
    await new Promise(resolve=>setTimeout(resolve,400));expect(exits).toEqual([code]);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
it('rejects control without a managed launcher',async()=>{
  const app=express();app.use(express.json());installServiceControl(app,false,()=>{throw Error('Must not exit')});
  const server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/service`;
    expect((await fetch(url).then(r=>r.json())).enabled).toBe(false);
    expect((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"stop"}'})).status).toBe(403);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
