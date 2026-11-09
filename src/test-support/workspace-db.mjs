import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
export function sqliteD1(migrations) {
  const sqlite=new DatabaseSync(':memory:');
  for(const file of fs.readdirSync(migrations).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync(migrations+'/'+file,'utf8'));
  const db={sqlite,prepare(sql) {
    let args=[];
    // D1 can batch CREATE TABLE followed by statements that use that new table.
    // Prepare against SQLite at execution time so the fixture has the same behavior.
    const statement={bind(...values){args=values;return statement;},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}};
    return statement;
  },async batch(statements){sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  return db;
}
export function workspaceEnv(role='administrator') {
  const DB=sqliteD1('migrations'),SITE_DB=DB;
  DB.sqlite.prepare("INSERT INTO admin_users(id,email,full_name,role,status,invited_at,created_at,updated_at) VALUES('tester','tester@example.com','Test Administrator',?,'active','2026-10-01','2026-10-01','2026-10-01')").run(role);
  SITE_DB.sqlite.prepare("INSERT INTO contact_messages(id,name,email,subject,message,created_at) VALUES('one','Ada Brown','ada@example.com','Church question','Hello <img src=x onerror=alert(1)>','2026-10-03T12:00:00Z')").run();
  const insert=SITE_DB.sqlite.prepare('INSERT INTO facility_rental_requests(id,audience,person_responsible,contact_email,phone,purpose,date_of_use,time_from,time_to,form_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  for(const [id,audience,from,to,facilities]of [['rent-a','member','10:00','12:00',['Fellowship Hall']],['rent-b','non_member','11:00','13:00',['Fellowship Hall']],['rent-c','member','11:00','13:00',['Sanctuary']]])insert.run(id,audience,'Test Renter','renter@example.com','555-0100','Community event','2026-10-11',from,to,JSON.stringify({facilities,numberOfPeople:'40'}),'2026-10-02T10:00:00Z');
  return {DB,SITE_DB,DEV_BYPASS_AUTH:'true',DEV_BYPASS_EMAIL:'tester@example.com',RESEND_API_KEY:'mock',RESEND_FROM_EMAIL:'church@example.com'};
}
