import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createBackup,verifyBackup,restoreBackup} from '../scripts/database-backup.mjs';
await mkdir('outputs',{recursive:true});
const dir=await mkdtemp(resolve('outputs/backup-rehearsal-'));
const source=join(dir,'source.db'),saved=join(dir,'snapshot'),restored=join(dir,'restored.db');
const db=new DatabaseSync(source);
try {
 db.exec('PRAGMA journal_mode=WAL; CREATE TABLE customers(id INTEGER PRIMARY KEY, business_id INTEGER, name TEXT); CREATE TABLE ledger(id INTEGER PRIMARY KEY, amount INTEGER, customer_id INTEGER);');
 db.prepare('INSERT INTO customers VALUES (?,?,?)').run(1,10,'Synthetic shop');
 db.prepare('INSERT INTO ledger VALUES (?,?,?)').run(1,2500,1);
 const manifest=await createBackup(source,saved);assert.deepEqual(manifest.tables,{customers:1,ledger:1});
 db.prepare('INSERT INTO ledger VALUES (?,?,?)').run(2,300,1);
 assert.equal((await verifyBackup(saved)).tables.ledger,1);
 await assert.rejects(()=>createBackup(source,saved),/exist/i);
 await restoreBackup(saved,restored);
 const copy=new DatabaseSync(restored,{readOnly:true});
 try {assert.equal(copy.prepare('SELECT SUM(amount) AS amount FROM ledger').get().amount,2500);assert.equal(copy.prepare('SELECT name FROM customers').get().name,'Synthetic shop');}finally{copy.close();}
 await assert.rejects(()=>restoreBackup(saved,source),/exist/i);
 assert.equal(db.prepare('SELECT SUM(amount) AS amount FROM ledger').get().amount,2800);
 const stale=join(dir,'stale.db');await writeFile(stale+'-wal','existing sidecar');
 await assert.rejects(()=>restoreBackup(saved,stale),/exists/);
 const backupFile=join(saved,'database.db');const original=await readFile(backupFile);
 const damaged=Buffer.from(original);damaged[100]^=1;await writeFile(backupFile,damaged);
 await assert.rejects(()=>restoreBackup(saved,join(dir,'should-not-exist.db')),/checksum/);
 await writeFile(backupFile,original);
 const result={passed:true,checks:['committed WAL included','snapshot independent of later writes','restored values match','existing target protected','corrupt backup rejected'],scope:'Synthetic local SQLite only; remote Turso recovery not verified'};
 await writeFile(join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{db.close();}
