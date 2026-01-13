const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const DATA_DIR = path.join(__dirname, 'data');
const LOCK_DIR = path.join(__dirname, 'data', 'locks');

// 确保目录存在
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(LOCK_DIR)) {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
}

// ==================== 表级锁机制 ====================
function acquireTableLock(dbName, tableName, timeout = 3000) {
    const lockFile = path.join(LOCK_DIR, `${dbName}_${tableName}.lock`);
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            fs.writeFileSync(lockFile, process.pid.toString(), { flag: 'wx' });
            return true;
        } catch (e) {
            if (e.code === 'EEXIST') {
                try {
                    const stat = fs.statSync(lockFile);
                    if (Date.now() - stat.mtimeMs > 5000) {
                        fs.unlinkSync(lockFile);
                        continue;
                    }
                } catch {}
                const waitUntil = Date.now() + 10;
                while (Date.now() < waitUntil) {}
            } else {
                return false;
            }
        }
    }
    return false;
}

function releaseTableLock(dbName, tableName) {
    const lockFile = path.join(LOCK_DIR, `${dbName}_${tableName}.lock`);
    try { fs.unlinkSync(lockFile); } catch {}
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonIfExists(filePath, defaultValue) {
    if (!fs.existsSync(filePath)) return defaultValue;
    return readJson(filePath);
}

function getMetadataFile(dbName) {
    return path.join(DATA_DIR, `${dbName}_metadata.json`);
}

function getTableFile(dbName, tableName) {
    return path.join(DATA_DIR, `${dbName}_${tableName}.json`);
}

function listDatabasesFromMetadataFiles() {
    const dbNames = [];
    const files = fs.readdirSync(DATA_DIR);
    for (const file of files) {
        if (file.endsWith('_metadata.json')) {
            dbNames.push(file.replace('_metadata.json', ''));
        }
    }
    return dbNames;
}

function makeUniqueName(base, existsFn) {
    if (!existsFn(base)) return base;
    let i = 1;
    while (existsFn(`${base}_import${i}`)) i++;
    return `${base}_import${i}`;
}

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // ==================== 分库分表 API ====================
    
    // API: 获取所有数据库的元数据（不含表数据，用于懒加载）
    if (req.method === 'GET' && req.url.split('?')[0] === '/api/databases') {
        try {
            const databases = {};
            const tableVersions = {};
            
            // 读取所有 *_metadata.json 文件
            const files = fs.readdirSync(DATA_DIR);
            for (const file of files) {
                if (file.endsWith('_metadata.json')) {
                    const dbName = file.replace('_metadata.json', '');
                    const filePath = path.join(DATA_DIR, file);
                    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    databases[dbName] = content.metadata || { tables: {} };
                    
                    // 读取表版本号
                    for (const tableName in databases[dbName].tables) {
                        const tableKey = `${dbName}.${tableName}`;
                        const tableFile = path.join(DATA_DIR, `${dbName}_${tableName}.json`);
                        if (fs.existsSync(tableFile)) {
                            const tableContent = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
                            tableVersions[tableKey] = tableContent.version;
                        }
                    }
                }
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, databases, tableVersions }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }
    
    // API: 获取表数据（按需加载）
    if (req.method === 'GET' && req.url.match(/^\/api\/table-data\/([^\/]+)\/([^\/\?]+)/)) {
        const match = req.url.match(/^\/api\/table-data\/([^\/]+)\/([^\/\?]+)/);
        const dbName = decodeURIComponent(match[1]);
        const tableName = decodeURIComponent(match[2]);
        
        try {
            const tableFile = path.join(DATA_DIR, `${dbName}_${tableName}.json`);
            if (fs.existsSync(tableFile)) {
                const content = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, data: content.data || [], version: content.version }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, data: [], version: null }));
            }
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }
    
    // API: 获取表版本号
    if (req.method === 'GET' && req.url.match(/^\/api\/table-version\/([^\/]+)\/([^\/\?]+)/)) {
        const match = req.url.match(/^\/api\/table-version\/([^\/]+)\/([^\/\?]+)/);
        const dbName = decodeURIComponent(match[1]);
        const tableName = decodeURIComponent(match[2]);
        
        try {
            const tableFile = path.join(DATA_DIR, `${dbName}_${tableName}.json`);
            if (fs.existsSync(tableFile)) {
                const content = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, version: content.version }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, version: null }));
            }
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }
    
    // API: 保存表数据（表级锁 + 表级版本号）
    if (req.method === 'POST' && req.url === '/api/save-table') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { database, table, data, version, expectedVersion } = JSON.parse(body);
                
                if (!database || !table) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: '缺少 database 或 table 参数' }));
                    return;
                }
                
                // 获取表级锁
                if (!acquireTableLock(database, table)) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: `表 ${table} 被其他进程锁定，请稍后重试` }));
                    console.log(`⚠️ 表级锁冲突: ${database}.${table}`);
                    return;
                }
                
                try {
                    const tableFile = path.join(DATA_DIR, `${database}_${table}.json`);
                    
                    // 乐观锁版本检查
                    if (fs.existsSync(tableFile) && expectedVersion) {
                        const existing = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
                        if (existing.version && existing.version !== expectedVersion) {
                            releaseTableLock(database, table);
                            res.writeHead(409, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ 
                                success: false, 
                                error: `表 ${table} 数据冲突：其他进程已修改，请刷新页面`,
                                serverVersion: existing.version,
                                clientVersion: expectedVersion
                            }));
                            console.log(`⚠️ 乐观锁冲突: ${database}.${table} 客户端版本 ${expectedVersion}, 服务器版本 ${existing.version}`);
                            return;
                        }
                    }
                    
                    fs.writeFileSync(tableFile, JSON.stringify({ version, data }, null, 2), 'utf8');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: '表数据已保存', path: tableFile }));
                    console.log(`✅ 表数据已保存: ${database}.${table}, 版本: ${version}`);
                } finally {
                    releaseTableLock(database, table);
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }
    
    // API: 保存元数据
    if (req.method === 'POST' && req.url === '/api/save-metadata') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { database, metadata } = JSON.parse(body);
                
                if (!database) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: '缺少 database 参数' }));
                    return;
                }
                
                const metadataFile = path.join(DATA_DIR, `${database}_metadata.json`);
                fs.writeFileSync(metadataFile, JSON.stringify({ metadata }, null, 2), 'utf8');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: '元数据已保存', path: metadataFile }));
                console.log(`✅ 元数据已保存: ${database}`);
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

     if (req.method === 'POST' && req.url.split('?')[0] === '/api/clear-all') {
         try {
             const files = fs.readdirSync(DATA_DIR);
             for (const file of files) {
                 const fullPath = path.join(DATA_DIR, file);
                 let stat;
                 try { stat = fs.statSync(fullPath); } catch { continue; }
                 if (!stat.isFile()) continue;
                 if (file.toLowerCase().endsWith('.json')) {
                     try { fs.unlinkSync(fullPath); } catch {}
                 }
             }

             const lockFiles = fs.readdirSync(LOCK_DIR);
             for (const file of lockFiles) {
                 const fullPath = path.join(LOCK_DIR, file);
                 let stat;
                 try { stat = fs.statSync(fullPath); } catch { continue; }
                 if (!stat.isFile()) continue;
                 try { fs.unlinkSync(fullPath); } catch {}
             }

             res.writeHead(200, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ success: true }));
         } catch (e) {
             res.writeHead(500, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ success: false, error: e.message }));
         }
         return;
     }

     if (req.method === 'POST' && req.url.split('?')[0] === '/api/delete-database') {
         try {
             const u = new URL(req.url, `http://localhost:${PORT}`);
             const database = u.searchParams.get('database');
             if (!database) {
                 res.writeHead(400, { 'Content-Type': 'application/json' });
                 res.end(JSON.stringify({ success: false, error: '缺少 database 参数' }));
                 return;
             }

             const metaFile = getMetadataFile(database);
             try { fs.unlinkSync(metaFile); } catch {}

             const files = fs.readdirSync(DATA_DIR);
             for (const file of files) {
                 if (file.startsWith(`${database}_`) && file.toLowerCase().endsWith('.json') && !file.endsWith('_metadata.json')) {
                     try { fs.unlinkSync(path.join(DATA_DIR, file)); } catch {}
                 }
             }

             const lockFiles = fs.readdirSync(LOCK_DIR);
             for (const file of lockFiles) {
                 if (file.startsWith(`${database}_`) && file.toLowerCase().endsWith('.lock')) {
                     try { fs.unlinkSync(path.join(LOCK_DIR, file)); } catch {}
                 }
             }

             res.writeHead(200, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ success: true }));
         } catch (e) {
             res.writeHead(500, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ success: false, error: e.message }));
         }
         return;
     }

     if (req.method === 'POST' && req.url.split('?')[0] === '/api/delete-table') {
         try {
             const u = new URL(req.url, `http://localhost:${PORT}`);
             const database = u.searchParams.get('database');
             const table = u.searchParams.get('table');
             if (!database || !table) {
                 res.writeHead(400, { 'Content-Type': 'application/json' });
                 res.end(JSON.stringify({ success: false, error: '缺少 database 或 table 参数' }));
                 return;
             }
             try { fs.unlinkSync(getTableFile(database, table)); } catch {}
             try { fs.unlinkSync(path.join(LOCK_DIR, `${database}_${table}.lock`)); } catch {}
             res.writeHead(200, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ success: true }));
         } catch (e) {
             res.writeHead(500, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ success: false, error: e.message }));
         }
         return;
     }

     if (req.method === 'POST' && req.url.split('?')[0] === '/api/rename-table-file') {
         try {
             const u = new URL(req.url, `http://localhost:${PORT}`);
             const database = u.searchParams.get('database');
             const from = u.searchParams.get('from');
             const to = u.searchParams.get('to');
             if (!database || !from || !to) {
                 res.writeHead(400, { 'Content-Type': 'application/json' });
                 res.end(JSON.stringify({ success: false, error: '缺少 database/from/to 参数' }));
                 return;
             }
             const fromFile = getTableFile(database, from);
             const toFile = getTableFile(database, to);
             if (!fs.existsSync(fromFile)) {
                 res.writeHead(200, { 'Content-Type': 'application/json' });
                 res.end(JSON.stringify({ success: true, skipped: true }));
                 return;
             }
             if (fs.existsSync(toFile)) {
                 res.writeHead(409, { 'Content-Type': 'application/json' });
                 res.end(JSON.stringify({ success: false, error: `目标表已存在: ${database}.${to}` }));
                 return;
             }
             fs.renameSync(fromFile, toFile);

             const fromLock = path.join(LOCK_DIR, `${database}_${from}.lock`);
             const toLock = path.join(LOCK_DIR, `${database}_${to}.lock`);
             if (fs.existsSync(fromLock) && !fs.existsSync(toLock)) {
                 try { fs.renameSync(fromLock, toLock); } catch {}
             }

             res.writeHead(200, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ success: true }));
         } catch (e) {
             res.writeHead(500, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ success: false, error: e.message }));
         }
         return;
     }

     if (req.method === 'GET' && req.url.split('?')[0] === '/api/backup') {
         try {
             const u = new URL(req.url, `http://localhost:${PORT}`);
             const scope = (u.searchParams.get('scope') || 'all').toLowerCase();
             const database = u.searchParams.get('database');

             const snapshot = {
                 version: '2.0',
                 exportTime: new Date().toISOString(),
                 scope: scope === 'db' ? { type: 'db', database } : { type: 'all' },
                 databases: {},
                 tableData: {},
                 tableVersions: {}
             };

             let dbNames = [];
             if (scope === 'db') {
                 if (!database) {
                     res.writeHead(400, { 'Content-Type': 'application/json' });
                     res.end(JSON.stringify({ success: false, error: '缺少 database 参数' }));
                     return;
                 }
                 if (!fs.existsSync(getMetadataFile(database))) {
                     res.writeHead(404, { 'Content-Type': 'application/json' });
                     res.end(JSON.stringify({ success: false, error: `数据库不存在: ${database}` }));
                     return;
                 }
                 dbNames = [database];
             } else {
                 dbNames = listDatabasesFromMetadataFiles();
             }

             for (const dbName of dbNames) {
                 const metaJson = readJson(getMetadataFile(dbName));
                 const metadata = metaJson.metadata || { tables: {} };
                 snapshot.databases[dbName] = metadata;

                 for (const tableName of Object.keys(metadata.tables || {})) {
                     const tableKey = `${dbName}.${tableName}`;
                     const tableJson = readJsonIfExists(getTableFile(dbName, tableName), { version: null, data: [] });
                     snapshot.tableData[tableKey] = {
                         version: Object.prototype.hasOwnProperty.call(tableJson, 'version') ? (tableJson.version ?? null) : null,
                         data: Array.isArray(tableJson.data) ? tableJson.data : []
                     };
                     snapshot.tableVersions[tableKey] = snapshot.tableData[tableKey].version;
                 }
             }

             res.writeHead(200, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify(snapshot, null, 2));
         } catch (e) {
             res.writeHead(500, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ success: false, error: e.message }));
         }
         return;
     }

     if (req.method === 'POST' && req.url.split('?')[0] === '/api/restore') {
         const u = new URL(req.url, `http://localhost:${PORT}`);
         const mode = (u.searchParams.get('mode') || 'merge').toLowerCase();
         const conflict = (u.searchParams.get('conflict') || 'rename').toLowerCase();
         if (mode !== 'merge' || conflict !== 'rename') {
             res.writeHead(400, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ success: false, error: '仅支持 mode=merge&conflict=rename' }));
             return;
         }

         let body = '';
         req.on('data', chunk => body += chunk);
         req.on('end', () => {
             try {
                 const snapshot = JSON.parse(body || '{}');
                 const incomingDbs = snapshot.databases || {};
                 const incomingTableData = snapshot.tableData || {};

                 const existingDbs = new Set(listDatabasesFromMetadataFiles());
                 const renamedDatabases = {};
                 const renamedTables = {};

                 for (const [srcDbName, srcDbMeta] of Object.entries(incomingDbs)) {
                     const targetDbName = makeUniqueName(srcDbName, (n) => existingDbs.has(n));
                     if (targetDbName !== srcDbName) renamedDatabases[srcDbName] = targetDbName;
                     existingDbs.add(targetDbName);

                     const existingMeta = readJsonIfExists(getMetadataFile(targetDbName), { metadata: { tables: {} } }).metadata || { tables: {} };
                     const existingTables = new Set(Object.keys(existingMeta.tables || {}));

                     const srcTables = (srcDbMeta && srcDbMeta.tables) ? srcDbMeta.tables : {};
                     const tableRenameMap = {};
                     const outTables = {};

                     for (const [srcTableName, tableMeta] of Object.entries(srcTables)) {
                         const targetTableName = makeUniqueName(srcTableName, (n) => existingTables.has(n));
                         if (targetTableName !== srcTableName) {
                             if (!renamedTables[targetDbName]) renamedTables[targetDbName] = {};
                             renamedTables[targetDbName][srcTableName] = targetTableName;
                             tableRenameMap[srcTableName] = targetTableName;
                         }
                         existingTables.add(targetTableName);
                         outTables[targetTableName] = JSON.parse(JSON.stringify(tableMeta || {}));
                     }

                     for (const [tName, tMeta] of Object.entries(outTables)) {
                         const fks = Array.isArray(tMeta.foreignKeys) ? tMeta.foreignKeys : [];
                         for (const fk of fks) {
                             if (fk && fk.refTable && tableRenameMap[fk.refTable]) {
                                 fk.refTable = tableRenameMap[fk.refTable];
                             }
                         }
                     }

                     const outMeta = { tables: { ...(existingMeta.tables || {}) } };
                     for (const [tName, tMeta] of Object.entries(outTables)) {
                         outMeta.tables[tName] = tMeta;
                     }
                     fs.writeFileSync(getMetadataFile(targetDbName), JSON.stringify({ metadata: outMeta }, null, 2), 'utf8');

                     for (const [srcTableName, tableMeta] of Object.entries(srcTables)) {
                         const targetTableName = tableRenameMap[srcTableName] || srcTableName;
                         const srcKey = `${srcDbName}.${srcTableName}`;
                         const payload = incomingTableData[srcKey] || { version: null, data: [] };
                         const outPayload = {
                             version: (payload && Object.prototype.hasOwnProperty.call(payload, 'version')) ? (payload.version ?? null) : null,
                             data: (payload && Array.isArray(payload.data)) ? payload.data : []
                         };
                         const version = outPayload.version || new Date().toISOString();

                         if (!acquireTableLock(targetDbName, targetTableName)) {
                             res.writeHead(409, { 'Content-Type': 'application/json' });
                             res.end(JSON.stringify({ success: false, error: `表 ${targetDbName}.${targetTableName} 被其他进程锁定，请稍后重试` }));
                             return;
                         }
                         try {
                             fs.writeFileSync(getTableFile(targetDbName, targetTableName), JSON.stringify({ version, data: outPayload.data }, null, 2), 'utf8');
                         } finally {
                             releaseTableLock(targetDbName, targetTableName);
                         }
                     }
                 }

                 res.writeHead(200, { 'Content-Type': 'application/json' });
                 res.end(JSON.stringify({ success: true, renamedDatabases, renamedTables }));
             } catch (e) {
                 res.writeHead(500, { 'Content-Type': 'application/json' });
                 res.end(JSON.stringify({ success: false, error: e.message }));
             }
         });
         return;
     }

    // 静态文件服务（移除查询参数）
    let urlPath = req.url.split('?')[0];
    let filePath = urlPath === '/' ? '/index.html' : urlPath;
    filePath = path.join(__dirname, filePath);

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end('Server error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

server.listen(PORT, () => {
    console.log(`\n🚀 MiniSQL 服务器已启动`);
    console.log(`   地址: http://localhost:${PORT}`);
    console.log(`   数据目录: ${DATA_DIR}`);
    console.log(`   特性: 分库分表 + 表级锁 + 懒加载`);
    console.log(`\n   按 Ctrl+C 停止服务器\n`);
});
