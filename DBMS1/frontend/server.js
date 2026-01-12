const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const DATA_FILE = path.join(__dirname, 'data', 'minisql_data.json');
const LOCK_FILE = path.join(__dirname, 'data', '.minisql.lock');

// 确保data目录存在
if (!fs.existsSync(path.dirname(DATA_FILE))) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}

// 文件锁机制 - 防止多进程并发写入冲突
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

    // API: 保存数据到本地文件（带文件锁）
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
                    // 版本检查：如果文件存在，比较lastModified防止覆盖更新的数据
                    if (fs.existsSync(DATA_FILE) && data.lastModified) {
                        const existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
                        if (existing.lastModified && new Date(existing.lastModified) > new Date(data.lastModified)) {
                            releaseLock();
                            res.writeHead(409, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ 
                                success: false, 
                                error: '数据冲突：服务器上有更新的版本，请刷新页面',
                                serverVersion: existing.lastModified 
                            }));
                            console.log('⚠️ 版本冲突：服务器数据更新');
                            return;
                        }
                    }
                    
                    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: '数据已保存到本地文件', path: DATA_FILE }));
                    console.log('✅ 数据已保存:', DATA_FILE);
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
    console.log(`   数据文件: ${DATA_FILE}`);
    console.log(`\n   按 Ctrl+C 停止服务器\n`);
});
