import path from 'path';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';

// Resolve __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DB_PATH || path.join(__dirname, 'v2ray_bot.sqlite');

let db;

export const initDb = () => {
    return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('Error opening database:', err.message);
                return reject(err);
            }
            console.log('Connected to the SQLite database.');
            db = database;
            resolve();
        });
    }).then(() => {
        return new Promise((resolve, reject) => {
            const queries = [
                `CREATE TABLE IF NOT EXISTS config_files (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, added_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
                `CREATE TABLE IF NOT EXISTS posted_configs (id INTEGER PRIMARY KEY AUTOINCREMENT, config_hash TEXT NOT NULL UNIQUE, posted_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
                `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`
            ];
            db.serialize(() => {
                const promises = queries.map(query => 
                    new Promise((res, rej) => db.run(query, (err) => err ? rej(err) : res()))
                );
                Promise.all(promises).then(() => {
                    console.log("Database tables are ready.");
                    resolve();
                }).catch(reject);
            });
        });
    });
};

export const get = (query, params = []) => new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database not initialized."));
    db.get(query, params, (err, row) => err ? reject(err) : resolve(row));
});

export const all = (query, params = []) => new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database not initialized."));
    db.all(query, params, (err, rows) => err ? reject(err) : resolve(rows));
});

export const run = (query, params = []) => new Promise(function(resolve, reject) {
    if (!db) return reject(new Error("Database not initialized."));
    db.run(query, params, function(err) {
        if (err) reject(err);
        resolve(this);
    });
});