import initSqlJs, { Database } from 'sql.js';
import { Pool } from 'pg';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync,openSync,fsyncSync,closeSync } from 'node:fs';
import path from 'node:path';
import { RecordData } from '../shared';
export function seal(value:string,key:Buffer){const iv=randomBytes(12);const c=createCipheriv('aes-256-gcm',key,iv);const out=Buffer.concat([c.update(value,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),out]).toString('base64');}
export function unseal(value:string,key:Buffer){const b=Buffer.from(value,'base64');const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}
/** Call with the original writer closed for effects, before reopening a rollback
 * profile. These private no-repost reservations are deliberately NOT exports. */
export async function retainPairedAndroidJournalAcrossRollback(source:Pick<Store,'list'>,target:Pick<Store,'get'|'put'>){
 for(const row of await source.list('paired-android-receipt')){
  const old=await target.get('paired-android-receipt',row.id);
  if(old&&(old.deviceId!==row.deviceId||old.notificationId!==row.notificationId||old.bodySha256!==row.bodySha256))throw Error('Paired notification rollback identity conflict.');
  const retained=old?.state==='delivered'?old:row;
  await target.put('paired-android-receipt',retained);
  const saved=await target.get('paired-android-receipt',row.id);
  if(!saved||saved.deviceId!==retained.deviceId||saved.bodySha256!==retained.bodySha256||saved.state!==retained.state)throw Error('Paired notification rollback retention failed.');
 }
}
export class Store {
 db?:Database; pool?:Pool; file:string; key:Buffer;
 constructor(directory:string,key:Buffer,private databaseUrl?:string,private existingOnly=false){if(key.length!==32)throw Error('A 32-byte storage key is required.');if(!existingOnly)mkdirSync(directory,{recursive:true});this.file=path.join(directory,'capri.sqlite');this.key=key;}
 async init(){if(this.databaseUrl){if(this.existingOnly)throw Error('Offline local Store required.');this.pool=new Pool({connectionString:this.databaseUrl});await this.pool.query('CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id))');}else{const SQL=await initSqlJs();if(this.existingOnly&&!existsSync(this.file))throw Error('Existing database required.');this.db=existsSync(this.file)?new SQL.Database(readFileSync(this.file)):new SQL.Database();try{if(this.existingOnly){const columns=this.db.exec('PRAGMA table_info(records)')[0]?.values.map(row=>row[1]);if(JSON.stringify(columns)!==JSON.stringify(['kind','id','data','updated_at']))throw Error('Existing database schema required.');}else this.db.run('CREATE TABLE IF NOT EXISTS records(kind TEXT,id TEXT,data TEXT,updated_at TEXT,PRIMARY KEY(kind,id))');}catch(error){this.db.close();this.db=undefined;throw error;}}return this;}
 async list(kind:string):Promise<RecordData[]>{let rows:any[];if(this.pool)rows=(await this.pool.query('SELECT data FROM records WHERE kind=$1 ORDER BY updated_at ASC',[kind])).rows;else{const st=this.db!.prepare('SELECT data FROM records WHERE kind=? ORDER BY updated_at ASC');st.bind([kind]);rows=[];while(st.step())rows.push(st.getAsObject());st.free();}return rows.map(r=>JSON.parse(unseal(r.data,this.key)));}
 async get(kind:string,id:string){let data:string|undefined;if(this.pool)data=(await this.pool.query('SELECT data FROM records WHERE kind=$1 AND id=$2',[kind,id])).rows[0]?.data;else{const st=this.db!.prepare('SELECT data FROM records WHERE kind=? AND id=?');st.bind([kind,id]);if(st.step())data=st.getAsObject().data as string;st.free();}return data?JSON.parse(unseal(data,this.key)) as RecordData:undefined;}
 async put(kind:string,value:any){const row={...value,id:value.id||randomUUID(),updatedAt:new Date().toISOString()};const data=seal(JSON.stringify(row),this.key);if(this.pool)await this.pool.query('INSERT INTO records VALUES($1,$2,$3,$4) ON CONFLICT(kind,id) DO UPDATE SET data=$3,updated_at=$4',[kind,row.id,data,row.updatedAt]);else{this.db!.run('INSERT OR REPLACE INTO records VALUES(?,?,?,?)',[kind,row.id,data,row.updatedAt]);this.flush();}return row as RecordData;}
 async remove(kind:string,id:string){if(this.pool)await this.pool.query('DELETE FROM records WHERE kind=$1 AND id=$2',[kind,id]);else{this.db!.run('DELETE FROM records WHERE kind=? AND id=?',[kind,id]);this.flush();}}
 /** Offline managed backup verification. Decrypt every row without exporting
  * private kinds or disclosing payloads in logs/RPCs. */
 async verifyAll(){if(this.pool)throw Error('Offline local Store required.');const rows=this.db!.exec('SELECT data FROM records');for(const result of rows)for(const row of result.values)JSON.parse(unseal(String(row[0]),this.key));}
 flush(){if(this.db){const bytes=Buffer.from(this.db.export()),temporary=this.file+'.write-'+randomUUID()+'.tmp';const fd=openSync(temporary,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,this.file);if(!readFileSync(this.file).equals(bytes))throw Error('Store durable readback failed.');}}
 async close(){if(!this.existingOnly)this.flush();this.db?.close();await this.pool?.end();}
 async export(){const kinds=['message','memory','plan','topic','settings','usage','task','backup','activity','knowledge','attachment'];const data:any={version:1,exportedAt:new Date().toISOString()};for(const kind of kinds)data[kind]=await this.list(kind);return data;}
}
