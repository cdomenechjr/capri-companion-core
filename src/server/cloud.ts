import path from 'node:path';
import { Store } from './store';
import { createService } from './service';
async function main(){const token=process.env.CAPRI_ADMIN_TOKEN,key=process.env.CAPRI_STORE_KEY;if(!token||token.length<32||!key)throw new Error('Set CAPRI_ADMIN_TOKEN (32+ characters) and CAPRI_STORE_KEY (base64, 32 random bytes) on the server.');const store=await new Store(process.env.CAPRI_DATA_DIR||'data',Buffer.from(key,'base64'),process.env.DATABASE_URL).init();const service=await createService({store,adminToken:token,key:()=>process.env.OPENAI_API_KEY,uiPath:path.join(__dirname,'ui')});await service.app.listen({port:Number(process.env.PORT||4317),host:process.env.CAPRI_HOST||'127.0.0.1'});console.log('Capri service ready. Place behind HTTPS for remote access.');for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>void service.app.close().then(()=>process.exit(0)));}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
