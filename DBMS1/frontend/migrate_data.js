/**
 * 数据迁移脚本：将旧格式数据转换为新格式
 * 旧格式：单个 minisql_data.json 文件，包含所有数据库和表数据
 * 新格式：每个数据库一个元数据文件，每个表一个数据文件
 */

const fs = require('fs');
const path = require('path');

const OLD_FILE = path.join(__dirname, 'data', 'minisql_data.json');
const DATA_DIR = path.join(__dirname, 'data');

function migrate() {
    console.log('🔄 开始数据迁移...\n');
    
    // 读取旧数据
    if (!fs.existsSync(OLD_FILE)) {
        console.log('❌ 未找到旧数据文件:', OLD_FILE);
        return;
    }
    
    const oldData = JSON.parse(fs.readFileSync(OLD_FILE, 'utf8'));
    const databases = oldData.databases || {};
    
    console.log(`📊 发现 ${Object.keys(databases).length} 个数据库\n`);
    
    // 转换每个数据库
    for (const [dbName, db] of Object.entries(databases)) {
        console.log(`📁 处理数据库: ${dbName}`);
        
        // 提取元数据（不含 data 字段）
        const metadata = { tables: {} };
        for (const [tableName, table] of Object.entries(db.tables || {})) {
            metadata.tables[tableName] = {
                columns: table.columns || [],
                foreignKeys: table.foreignKeys || [],
                indexes: table.indexes || {}
            };
            
            // 保存表数据到单独文件
            const tableFile = path.join(DATA_DIR, `${dbName}_${tableName}.json`);
            const tableData = {
                version: new Date().toISOString(),
                data: table.data || []
            };
            fs.writeFileSync(tableFile, JSON.stringify(tableData, null, 2), 'utf8');
            console.log(`  ✅ 表 ${tableName}: ${tableData.data.length} 行 → ${tableFile}`);
        }
        
        // 保存元数据
        const metadataFile = path.join(DATA_DIR, `${dbName}_metadata.json`);
        fs.writeFileSync(metadataFile, JSON.stringify({ metadata }, null, 2), 'utf8');
        console.log(`  ✅ 元数据 → ${metadataFile}\n`);
    }
    
    // 备份旧文件
    const backupFile = OLD_FILE.replace('.json', '_backup.json');
    fs.copyFileSync(OLD_FILE, backupFile);
    console.log(`💾 旧数据已备份到: ${backupFile}`);
    console.log(`\n✅ 迁移完成！`);
    console.log(`\n提示：`);
    console.log(`  1. 使用 node server_new.js 启动新服务器`);
    console.log(`  2. 刷新浏览器页面即可使用新版本`);
}

migrate();
