import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, lstat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw Error('Database integrity check failed.');
    const tables = {};
    for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      const quoted = '"' + name.replaceAll('"','""') + '"';
      tables[name] = Number(db.prepare('SELECT COUNT(*) AS count FROM '+quoted).get().count);
    }
    return tables;
  } finally { db.close(); }
}
export async function createBackup(source, directory) {
  source=resolve(source); directory=resolve(directory);
  if (!(await stat(source)).isFile()) throw Error('Source must be an existing local SQLite file.');
  const db=new DatabaseSync(source,{readOnly:true});
  try {
    // Exclusive directory creation prevents overwriting any earlier backup.
    await mkdir(directory,{mode:0o700});
    const target=join(directory,'database.db');
    // SQLite online backup includes committed WAL data; plain file copying does not.
    await backup(db,target);
    const tables=inspect(target), bytes=await readFile(target);
    const manifest={format:1,createdAt:new Date().toISOString(),sha256:digest(bytes),bytes:bytes.length,tables};
    await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    return manifest;
  } finally { db.close(); }
}
export async function verifyBackup(directory) {
  directory=resolve(directory);
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
  if(manifest.format!==1 || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw Error('Invalid backup manifest.');
  const bytes=await readFile(join(directory,'database.db'));
  if(bytes.length!==manifest.bytes || digest(bytes)!==manifest.sha256) throw Error('Backup checksum mismatch. Restore refused.');
  const tables=inspect(join(directory,'database.db'));
  if(JSON.stringify(tables)!==JSON.stringify(manifest.tables)) throw Error('Backup table counts do not match manifest.');
  return manifest;
}
export async function restoreBackup(directory,destination) {
  const manifest=await verifyBackup(directory);
  destination=resolve(destination);
  for(const suffix of ['', '-wal', '-shm']) {
    try {await lstat(destination+suffix);}
    catch(error) {if(error.code==='ENOENT')continue;throw error;}
    throw Error('Destination or SQLite sidecar already exists. Restore requires a new path.');
  }
  // The verified bytes are read again and checked before creating the target.
  const bytes=await readFile(join(resolve(directory),'database.db'));
  if(digest(bytes)!==manifest.sha256) throw Error('Backup changed during verification.');
  await writeFile(destination,bytes,{flag:'wx',mode:0o600});
  inspect(destination);
  return {restored:true,sha256:manifest.sha256,tables:manifest.tables};
}

// Local files only. Never loads application environment or opens a remote database.
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [operation,source,target]=process.argv.slice(2);
  try {
    if(operation==='create' && source && target) console.log(JSON.stringify(await createBackup(source,target)));
    else if(operation==='verify' && source && !target) console.log(JSON.stringify(await verifyBackup(source)));
    else if(operation==='restore' && source && target) console.log(JSON.stringify(await restoreBackup(source,target)));
    else throw Error('Usage: node scripts/database-backup.mjs create <local.db> <new-backup-folder> | verify <backup-folder> | restore <backup-folder> <new-local.db>');
  } catch(error) { console.error(error instanceof Error ? error.message : 'Backup operation failed.');process.exitCode=1; }
}
