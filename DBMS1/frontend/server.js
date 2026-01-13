const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const DATA_DIR = path.join(__dirname, 'data');
const LOCK_DIR = path.join(__dirname, 'data', 'locks');
const DATA_FILE = path.join(__dirname, 'data', 'minisql_data.json');
const LOCK_FILE = path.join(__dirname, 'data', '.minisql.lock');

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

// 文件锁机制 - 防止多进程并发写入冲突（兼容旧版）
function acquireLock(timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            fs.writeFileSync(LOCK_FILE, process.pid.toString(), { flag: 'wx' });
            return true;
        } catch (e) {
            if (e.code === 'EEXIST') {
                // 检查锁是否过期（超过5秒视为过期）
                try {
                    const stat = fs.statSync(LOCK_FILE);
                    if (Date.now() - stat.mtimeMs > 5000) {
                        fs.unlinkSync(LOCK_FILE);
                        continue;
                    }
                } catch {}
                // 等待10ms后重试
                const waitUntil = Date.now() + 10;
                while (Date.now() < waitUntil) {}
            } else {
                return false;
            }
        }
    }
    return false;
}

function releaseLock() {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
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

    // API: 获取服务器版本号（lastModified）用于读时过期检测（兼容旧版）
    if (req.method === 'GET' && req.url.split('?')[0] === '/api/version') {
        try {
            let lastModified = null;
            if (fs.existsSync(DATA_FILE)) {
                const existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
                lastModified = existing.lastModified || null;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, lastModified }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
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

    // API: 保存数据到本地文件（带文件锁）（兼容旧版）
    if (req.method === 'POST' && req.url === '/api/save') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                
                // 获取文件锁
                if (!acquireLock()) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: '文件被其他进程锁定，请稍后重试' }));
                    console.log('⚠️ 写入冲突：文件被锁定');
                    return;
                }
                
                try {
                    // 乐观锁版本检查：比较客户端的expectedVersion和服务器当前版本
                    if (!data.forceWrite && fs.existsSync(DATA_FILE) && data.expectedVersion) {
                        const existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
                        if (existing.lastModified && existing.lastModified !== data.expectedVersion) {
                            releaseLock();
                            res.writeHead(409, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ 
                                success: false, 
                                error: '数据冲突：其他进程已修改数据，请刷新页面',
                                serverVersion: existing.lastModified,
                                clientVersion: data.expectedVersion
                            }));
                            console.log('⚠️ 乐观锁冲突: 客户端版本', data.expectedVersion, '服务器版本', existing.lastModified);
                            return;
                        }
                    }
                    
                    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: '数据已保存到本地文件', path: DATA_FILE }));
                    console.log('✅ 数据已保存:', DATA_FILE, '版本:', data.lastModified);
                } finally {
                    releaseLock();
                }
            } catch (e) {
                releaseLock();
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
