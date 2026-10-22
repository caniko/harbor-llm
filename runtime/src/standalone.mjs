// Embedded exact bridge entrypoint. Host controller admission and unit custody
// precede the private bootstrap; no managed-service discovery/continuity is used.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createConnection } from "node:net";
import { pathToFileURL } from "node:url";

const socket = createConnection(`/control/${process.argv[1]}`);
let child, dispatcher, proxy, pending = Buffer.alloc(0), setup, stage="bootstrap";
const timeout = setTimeout(() => process.exit(2), 3600000);
async function send(bytes) {
  if (bytes.length < 1 || bytes.length > 65580) throw new Error();
  const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
  if (!socket.write(Buffer.concat([header,bytes]))) await new Promise((resolve,reject) => { socket.once("drain",resolve); socket.once("error",reject); });
}
try {
  for await (const chunk of socket) {
    pending = Buffer.concat([pending,chunk]);
    if (pending.length > 131168) throw new Error();
    while (pending.length >= 4) {
      const length = pending.readUInt32BE();
      if (length < 1 || length > 65580) throw new Error();
      if (pending.length < length+4) break;
      const record = pending.subarray(4,length+4); pending = pending.subarray(length+4);
      if (!setup) {
        setup = JSON.parse(record);
        const { plan } = setup;
        stage="engine-setup";
        for (const name of ["home","config","data","cache","state","runtime","tmp","repo"]) await mkdir(`/work/${name}`,{recursive:true,mode:0o700});
        let requests=0,inputBytes=0,outputBytes=0;
        proxy = createServer({maxHeaderSize:16384},(req,res) => {
          if(req.method!=="POST"||req.url!=="/v1/chat/completions"||++requests>256){res.writeHead(403);res.end();return;}
          let requestBytes=0,responseBytes=0;
          const upstream = request({socketPath:"/control/broker.sock",path:req.url,method:req.method,headers:{"content-type":"application/json"}}, reply => {
            reply.on("data",bytes=>{responseBytes+=bytes.length;outputBytes+=bytes.length;if(responseBytes>16777216||outputBytes>67108864){reply.destroy();res.destroy();}});
            res.writeHead(reply.statusCode,{"content-type":reply.headers["content-type"] ?? "application/octet-stream"});
            reply.pipe(res);
          });
          req.on("data",bytes=>{requestBytes+=bytes.length;inputBytes+=bytes.length;if(requestBytes>65536||inputBytes>67108864){req.destroy();upstream.destroy();}});
          upstream.on("error",() => res.destroy()); req.on("error",() => upstream.destroy()); res.on("close",() => upstream.destroy()); req.pipe(upstream);
        });
        proxy.maxConnections=2; proxy.requestTimeout=plan.resources.wallSeconds*1000; proxy.headersTimeout=5000;
        await new Promise(resolve => proxy.listen(0,"127.0.0.1",resolve));
        const configuration = structuredClone(plan.engineConfiguration);
        configuration.providers[plan.providerId].settings.baseURL=`http://127.0.0.1:${proxy.address().port}/v1`;
        configuration.providers[plan.providerId].settings.apiKey="broker-only";
        const password=randomBytes(32).toString("base64url");
        child=spawn("/artifacts/engine",["serve","--stdio","--hostname","127.0.0.1","--port","0"],{cwd:"/work/repo",stdio:["pipe","pipe","pipe"],env:{
          PATH:plan.tools.path,HOME:"/work/home",TMPDIR:"/work/tmp",XDG_CONFIG_HOME:"/work/config",XDG_DATA_HOME:"/work/data",XDG_STATE_HOME:"/work/state",XDG_CACHE_HOME:"/work/cache",XDG_RUNTIME_DIR:"/work/runtime",
          OPENCODE_CONFIG_DIR:"/work/config",OPENCODE_CONFIG_CONTENT:JSON.stringify(configuration),OPENCODE_CONFIG_PROJECT_DISABLE:"1",OPENCODE_DISABLE_MODELS_FETCH:"1",OPENCODE_FILEWATCHER_DISABLE:"1",OPENCODE_DISABLE_FFF:"1",OPENCODE_PASSWORD:password,OPENCODE_DB:"/work/engine.db",
        }});
        let stdout=0,stderr=0,buffer="",isReady=false;
        stage="engine-readiness";
        const ready=new Promise((resolve,reject) => {
          child.once("error",reject); child.once("exit",() => reject(new Error()));
          child.stdout.on("data",bytes => { stdout+=bytes.length; if(stdout>65536){child.kill("SIGKILL");socket.destroy();reject(new Error());return;} if(!isReady){buffer+=bytes.toString();if(buffer.includes("\n")){try {const ready=JSON.parse(buffer.slice(0,buffer.indexOf("\n")));isReady=true;buffer="";resolve(ready.url);}catch {reject(new Error());}}} });
          child.stderr.on("data",bytes => {stderr+=bytes.length;if(stderr>1048576){child.kill("SIGKILL");socket.destroy();reject(new Error());}});
        });
        const url=await ready;
        stage="dispatcher-import";
        const { InitialDispatcher }=await import(pathToFileURL(plan.tools.dispatcher));
        stage="dispatcher-configuration";
        dispatcher=new InitialDispatcher({binding:setup.binding,credentials:{key:Uint8Array.from(setup.key),nonce:Uint8Array.from(setup.nonce),binding:Uint8Array.from(setup.digest)},mode:setup.mode,interruptAuthority:plan.interruptAuthority ?? undefined,
          limits:{timeoutMs:plan.resources.wallSeconds*1000,inputBytes:65536,records:4096},adapter:{url,authorization:`Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,server:{pid:child.pid,version:plan.engineVersion},directory:"/work/repo",
            limits:{timeoutMs:plan.resources.wallSeconds*1000,inputBytes:65536,outputBytes:1048576,totalResponseBytes:16777216,requests:256,pages:8,messages:128}}});
        setup.key.fill(0); setup.nonce.fill(0);
        await send(Buffer.from(JSON.stringify({ready:true})));
        stage="commands";
        continue;
      }
      const response=await dispatcher.handle(record,send);
      if(response) await send(response);
    }
  }
  if(pending.length) throw new Error();
} catch {
  process.stderr.write(`standalone bridge failed at ${stage}\n`); process.exitCode=1;
} finally {
  clearTimeout(timeout); dispatcher?.close(); socket.destroy(); proxy?.closeAllConnections(); proxy?.close(); child?.stdin.destroy(); child?.kill("SIGTERM");
}
