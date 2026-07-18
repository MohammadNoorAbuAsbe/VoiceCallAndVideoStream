import { WebSocket } from 'ws';
import { startServer, stopServer } from './server/server.js';
const port = await startServer(0);
const url = `ws://127.0.0.1:${port}`;
function mk(id){return new Promise(res=>{const ws=new WebSocket(url);ws.on('open',()=>{ws.send(JSON.stringify({t:'register',id}));ws.on('message',(d,isBin)=>{if(isBin)return;const m=JSON.parse(d.toString());if(m.t==='registered')res(ws);});});});}
const a=await mk('a');const b=await mk('b');
a.send(JSON.stringify({t:'call',to:'b',name:'a',callId:'c'}));
await new Promise(r=>b.on('message',(d,isBin)=>{if(isBin)return;const m=JSON.parse(d.toString());if(m.t==='incoming'){b.send(JSON.stringify({t:'accept',callId:'c',to:'a'}));r();}}));
await new Promise(r=>a.on('message',(d,isBin)=>{if(isBin)return;const m=JSON.parse(d.toString());if(m.t==='accepted')r();}));
const rec=[];
b.on('message',(d,isBin)=>{ if(isBin) rec.push(Array.from(d)); });
for(let i=0;i<5;i++){ a.send(Buffer.from([i,i+1,i+2])); await new Promise(r=>setTimeout(r,10)); }
await new Promise(r=>setTimeout(r,100));
console.log('RECEIVED', JSON.stringify(rec));
await stopServer();
