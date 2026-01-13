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

// 文件锁机制 - 表级锁
function acquireLock(dbName, tableName, timeout = 3000) {
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

function releaseLock(dbName, tableName) {
    const lockFile = path.join(LOCK_DIR, `${dbName}_${tableName}.lock`);
    try { fs.unlinkSync(lockFile); } catch {}
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // API: 获取所有数据库的元数据（不含表数据）
    if (req.method === 'GET' && req.url.split('?')[0] === '/api/databases') {
        try {
            const databases = {};
            const tableVersions = {};
            
            // 读取所有数据库文件
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

    // API: 获取表数据
    if (req.method === 'GET' && req.url.match(/^\/api\/table-data\/([^\/]+)\/([^\/\?]+)/)) {
        const match = req.url.match(/^\/api\/table-data\/([^\/]+)\/([^\/\?]+)/);
        const dbName = match[1];
        const tableName = match[2];
        
        try {
            const tableFile = path.join(DATA_DIR, `${dbName}_${tableName}.json`);
            if (fs.existsSync(tableFile)) {
                const content = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, data: content.data, version: content.version }));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: '表不存在' }));
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
        const dbName = match[1];
        const tableName = match[2];
        
        try {
            const tableFile = path.join(DATA_DIR, `${dbName}_${tableName}.json`);
            if (fs.existsSync(tableFile)) {
                const content = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, version: content.version }));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false }));
            }
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: 保存表数据（表级版本号 + 表级锁）
    if (req.method === 'POST' && req.url === '/api/save-table') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { database, table, expectedVersion, version, data } = JSON.parse(body);
                
                // 获取表级锁
                if (!acquireLock(database, table)) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: '表被其他进程锁定，请稍后重试' }));
                    console.log(`⚠️ 写入冲突：表 ${database}.${table} 被锁定`);
                    return;
                }
                
                try {
                    const tableFile = path.join(DATA_DIR, `${database}_${table}.json`);
                    
                    // 乐观锁版本检查
                    if (fs.existsSync(tableFile) && expectedVersion) {
                        const existing = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
                        if (existing.version && existing.version !== expectedVersion) {
                            releaseLock(database, table);
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
                    
                    // 保存表数据
                    fs.writeFileSync(tableFile, JSON.stringify({ version, data }, null, 2), 'utf8');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: '表数据已保存', path: tableFile }));
                    console.log(`✅ 表数据已保存: ${database}.${table}, 版本: ${version}`);
                } finally {
                    releaseLock(database, table);
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // API: 保存元数据（表结构）
    if (req.method === 'POST' && req.url === '/api/save-metadata') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { database, metadata } = JSON.parse(body);
                const metadataFile = path.join(DATA_DIR, `${database}_metadata.json`);
                fs.writeFileSync(metadataFile, JSON.stringify({ metadata }, null, 2), 'utf8');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: '元数据已保存' }));
                console.log(`✅ 元数据已保存: ${database}`);
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // 静态文件服务
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
    console.log(`\n🚀 MiniSQL 服务器已启动 (优化版)`);
    console.log(`   地址: http://localhost:${PORT}`);
    console.log(`   数据目录: ${DATA_DIR}`);
    console.log(`   特性: 元数据分离 + 表级版本号 + 表级锁`);
    console.log(`\n   按 Ctrl+C 停止服务器\n`);
});
