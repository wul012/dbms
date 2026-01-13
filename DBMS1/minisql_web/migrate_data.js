#!/usr/bin/env node
/**
 * 数据迁移脚本
 * 将 minisql_data.json 拆分为分库分表格式：
 * - {db}_metadata.json: 元数据（表结构、外键、索引）
 * - {db}_{table}.json: 表数据
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SOURCE_FILE = path.join(DATA_DIR, 'minisql_data.json');

console.log('🔄 开始数据迁移...\n');

// 检查源文件是否存在
if (!fs.existsSync(SOURCE_FILE)) {
    console.log('❌ 源文件不存在:', SOURCE_FILE);
    process.exit(1);
}

// 读取源数据
const sourceData = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
const databases = sourceData.databases || {};

if (Object.keys(databases).length === 0) {
    console.log('⚠️ 源文件中没有数据库');
    process.exit(0);
}

const version = new Date().toISOString();
let dbCount = 0;
let tableCount = 0;

for (const [dbName, dbData] of Object.entries(databases)) {
    console.log(`📁 处理数据库: ${dbName}`);
    dbCount++;
    
    // 创建元数据（不含表数据）
    const metadata = { tables: {} };
    
    for (const [tableName, tableInfo] of Object.entries(dbData.tables || {})) {
        console.log(`   📋 处理表: ${tableName}`);
        tableCount++;
        
        // 元数据：只包含结构信息
        metadata.tables[tableName] = {
            columns: tableInfo.columns || [],
            foreignKeys: tableInfo.foreignKeys || [],
            indexes: tableInfo.indexes || {}
        };
        
        // 表数据文件
        const tableFile = path.join(DATA_DIR, `${dbName}_${tableName}.json`);
        const tableData = {
            version: version,
            data: tableInfo.data || []
        };
        fs.writeFileSync(tableFile, JSON.stringify(tableData, null, 2), 'utf8');
        console.log(`      ✅ 已创建: ${dbName}_${tableName}.json (${tableData.data.length} 行)`);
    }
    
    // 保存元数据文件
    const metadataFile = path.join(DATA_DIR, `${dbName}_metadata.json`);
    fs.writeFileSync(metadataFile, JSON.stringify({ metadata }, null, 2), 'utf8');
    console.log(`   ✅ 已创建: ${dbName}_metadata.json\n`);
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`🎉 迁移完成！`);
console.log(`   数据库: ${dbCount} 个`);
console.log(`   数据表: ${tableCount} 个`);
console.log(`   版本号: ${version}`);
console.log(`\n💡 原始文件 minisql_data.json 已保留作为备份`);
