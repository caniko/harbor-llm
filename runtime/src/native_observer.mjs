// Independent synthetic observer. No production credentials or external network.
// Counts and receipts are durable outside all engine/bridge namespaces.
import assert from "node:assert/strict";
import { appendFileSync, openSync, fstatSync, readSync, closeSync, constants, mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
const [root,phase]=process.argv.slice(1);
let providers=0,tools=0,descendants=0,attempts=0,revoked=false,failure=false;
let claimBytes=0;
function claimImage(path) {
  let fd;
  try {fd=openSync(path,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);}
  catch(error){if(error.code==="ENOENT")return null;throw error;}
  try {
    const metadata=fstatSync(fd);assert.ok(metadata.isFile()&&metadata.size<=16777216);
    const bytes=Buffer.alloc(metadata.size+1);let length=0;
    while(length<bytes.length){const count=readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}
    claimBytes+=length;assert.ok(claimBytes<=67108864);
    if(length!==metadata.size||fstatSync(fd).size!==metadata.size)return undefined;
    return bytes.subarray(0,length);
  } finally {closeSync(fd);}
}
const active=new Set(),responses=new Set();
const log=value=>appendFileSync(`${root}/observer.jsonl`,`${JSON.stringify(value)}\n`,{mode:0o600,flush:true});
const quote=value=>`'${value.replaceAll("'","'\\''")}'`;
const broker=createServer((req,res)=>{ handle(req,res).catch(()=>{failure=true;res.destroy();}); });
broker.maxConnections=4;broker.headersTimeout=2000;broker.requestTimeout=60000;
async function handle(req,res) {
  attempts++;log({type:"provider-attempt",ordinal:attempts,revoked});
  if(revoked){res.writeHead(403);res.end();return;}
  assert.equal(req.method,"POST");assert.equal(req.url,"/v1/chat/completions");
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;assert.ok(size<=65536);chunks.push(chunk);}
  assert.ok(!revoked);const input=JSON.parse(Buffer.concat(chunks));assert.equal(input.model,"fixture");
  providers++;assert.ok(providers<=4);log({type:"provider",ordinal:providers,input});
  responses.add(res);res.on("close",()=>responses.delete(res));
  res.writeHead(200,{"content-type":"text/event-stream"});
  const emit=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:"synthetic",object:"chat.completion.chunk",choices:[{index:0,delta,finish_reason}]})}\n\n`);
  if(phase.includes("tool")) {
    assert.ok(input.tools.some(tool=>tool.function?.name==="shell"));
    const detached=`const s=require("node:net").connect("/control/tool.sock",()=>s.write("descendant\\n"));setInterval(()=>{},1000)`;
    const code=`const {spawn}=require("node:child_process");spawn("/artifacts/node",["-e",${JSON.stringify(detached)}],{detached:true,stdio:"ignore"}).unref();const s=require("node:net").connect("/control/tool.sock",()=>s.write("tool\\n"));setInterval(()=>{},1000)`;
    const command=`/artifacts/node -e ${quote(code)}`;
    emit({role:"assistant",tool_calls:[{index:0,id:"call_fixture",type:"function",function:{name:"shell",arguments:JSON.stringify({command,timeout:30000})}}]});
    emit({},"tool_calls");res.end("data: [DONE]\n\n");return;
  }
  emit({role:"assistant",content:phase==="complete"?"exact synthetic result":"synthetic provider begun"});
  if(phase==="complete"){emit({},"stop");res.end("data: [DONE]\n\n");}
}
const witness=createSocketServer(socket=>{
  active.add(socket);let pending="";
  socket.on("data",bytes=>{
    pending+=bytes.toString();if(pending.length>64){failure=true;socket.destroy();return;}
    if(pending.endsWith("\n")) {
      if(pending==="tool\n"){tools++;log({type:"tool",ordinal:tools});}
      else if(pending==="descendant\n"){descendants++;log({type:"descendant",ordinal:descendants});}
      else failure=true;
    }
  });socket.on("error",()=>{});socket.on("close",()=>active.delete(socket));
});witness.maxConnections=8;
async function send(value){const bytes=Buffer.from(JSON.stringify(value));const header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);process.stdout.write(Buffer.concat([header,bytes]));}
await Promise.all([new Promise(resolve=>broker.listen(`${root}/broker.sock`,resolve)),new Promise(resolve=>witness.listen(`${root}/tool.sock`,resolve))]);
await send({ready:true});let pending=Buffer.alloc(0);
try {
  for await(const chunk of process.stdin){
    pending=Buffer.concat([pending,chunk]);assert.ok(pending.length<=65540);
    while(pending.length>=4){
      const length=pending.readUInt32BE();assert.ok(length>0&&length<=65536);if(pending.length<length+4)break;
      const request=JSON.parse(pending.subarray(4,length+4));pending=pending.subarray(length+4);
      if(request.kind==="revoke") {revoked=true;log({type:"revoked"});for(const response of responses)response.destroy();await send({revoked:true});}
      else if(request.kind==="status")await send({providers,tools,descendants,attempts,revoked,failure,activeTools:active.size});
      else if(request.kind==="claim") {
        // SQLite canonicalizes /proc fd paths out of detached mounts. Independently
        // copy/read back only this synthetic live database; originals stay untouched.
        let stable=false;
        for(let attempt=0;attempt<8;attempt++) {
          const copy=mkdtempSync(`${root}/claim-`),captured=[];
          for(const suffix of ["","-wal"]) {
            const path=request.path+suffix,bytes=claimImage(path);
            if(bytes)writeFileSync(`${copy}/engine.db${suffix}`,bytes,{mode:0o600,flag:"wx"});
            captured.push({path,bytes});
          }
          stable=!!captured[0].bytes;
          for(const {path,bytes} of captured) {
            const readback=claimImage(path);
            if(bytes===undefined||readback===undefined||!!bytes!==!!readback||(bytes&&!bytes.equals(readback)))stable=false;
          }
          log({type:"claim-capture",copy,stable,files:captured.map(({path,bytes})=>({path,digest:bytes?createHash("sha256").update(bytes).digest("hex"):null}))});
          if(!stable){await delay(25);continue;}
          const database=new DatabaseSync(`${copy}/engine.db`,{readOnly:true});
          try {await send(database.prepare("SELECT time_suspended, resume_attempts FROM session_v2 WHERE id = ?").get(request.session)??null);}finally{database.close();}
          break;
        }
        assert.ok(stable,"live claim did not stabilize within eight observations");
      } else assert.fail("unknown native observer operation");
    }
  }
} finally {for(const response of responses)response.destroy();for(const socket of active)socket.destroy();broker.closeAllConnections();broker.close();witness.close();}
