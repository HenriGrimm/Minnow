import Database from 'better-sqlite3';

// SQLite caps the mapping just below 2 GiB. Pages beyond the map use buffered reads.
const MAX_MAPPED_BYTES = 0x7fff0000;

let verified = false;
if (process.send) {
  let db;
  try {
    db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
    const mapped = db.pragma(`mmap_size = ${MAX_MAPPED_BYTES}`, { simple: true });
    verified = mapped > 0 && db.pragma('quick_check', { simple: true }) === 'ok';
  } catch {
    // The startup worker repeats the buffered check and handles recovery.
  } finally {
    db?.close();
  }
  process.send(verified, () => process.disconnect());
}
