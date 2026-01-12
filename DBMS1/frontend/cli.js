#!/usr/bin/env node
/**
 * MiniSQL 命令行工具
 * 用法:
 *   node cli.js                    # 交互模式
 *   node cli.js -e "SQL语句"       # 直接执行
 *   node cli.js -d dbname          # 指定数据库进入交互模式
 *   node cli.js -d dbname -e "SQL" # 指定数据库执行SQL
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_FILE = path.join(__dirname, 'data', 'minisql_data.json');

// 数据库状态
let databases = {};
let currentDatabase = null;

// 加载数据
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            databases = data.databases || {};
            console.log(`✅ 已加载 ${Object.keys(databases).length} 个数据库`);
        }
    } catch (e) {
        console.error('加载数据失败:', e.message);
    }
}

// 保存数据
function saveData() {
    try {
        const data = {
            version: '1.0',
            lastModified: new Date().toISOString(),
            databases: databases
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error('保存数据失败:', e.message);
    }
}

// 解析值
function parseValue(val) {
    if (val === undefined || val === null) return null;
    val = val.trim();
    if (val.toUpperCase() === 'NULL') return null;
    if (val.startsWith("'") && val.endsWith("'")) return val.slice(1, -1);
    if (val.startsWith('"') && val.endsWith('"')) return val.slice(1, -1);
    if (!isNaN(val) && val !== '') return parseFloat(val);
    return val;
}

// 执行SQL
function executeSQL(sql) {
    sql = sql.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!sql || sql.startsWith('--')) return null;
    
    const upperSQL = sql.toUpperCase();
    
    try {
        // SHOW DATABASES
        if (upperSQL === 'SHOW DATABASES') {
            const dbs = Object.keys(databases);
            console.log('\n📊 数据库列表:');
            dbs.forEach(db => console.log(`  - ${db}`));
            console.log(`共 ${dbs.length} 个数据库\n`);
            return { success: true };
        }
        
        // USE database
        if (upperSQL.startsWith('USE ')) {
            const match = sql.match(/USE\s+(\w+)/i);
            if (!match) throw new Error('USE 语法错误');
            const dbName = match[1];
            if (!databases[dbName]) throw new Error(`数据库 '${dbName}' 不存在`);
            currentDatabase = dbName;
            console.log(`✅ 已切换到数据库: ${dbName}`);
            return { success: true };
        }
        
        // SHOW TABLES
        if (upperSQL === 'SHOW TABLES') {
            if (!currentDatabase) throw new Error('请先选择数据库 (USE database_name)');
            const tables = Object.keys(databases[currentDatabase].tables || {});
            console.log(`\n📋 表列表 (${currentDatabase}):`);
            tables.forEach(t => {
                const rowCount = databases[currentDatabase].tables[t].data.length;
                console.log(`  - ${t} (${rowCount} 行)`);
            });
            console.log(`共 ${tables.length} 个表\n`);
            return { success: true };
        }
        
        // CREATE DATABASE
        if (upperSQL.startsWith('CREATE DATABASE')) {
            const match = sql.match(/CREATE\s+DATABASE\s+(\w+)/i);
            if (!match) throw new Error('CREATE DATABASE 语法错误');
            const dbName = match[1];
            if (databases[dbName]) throw new Error(`数据库 '${dbName}' 已存在`);
            databases[dbName] = { tables: {} };
            currentDatabase = dbName;
            saveData();
            console.log(`✅ 数据库 '${dbName}' 创建成功`);
            return { success: true };
        }
        
        // DROP DATABASE
        if (upperSQL.startsWith('DROP DATABASE')) {
            const match = sql.match(/DROP\s+DATABASE\s+(\w+)/i);
            if (!match) throw new Error('DROP DATABASE 语法错误');
            const dbName = match[1];
            if (!databases[dbName]) throw new Error(`数据库 '${dbName}' 不存在`);
            delete databases[dbName];
            if (currentDatabase === dbName) currentDatabase = null;
            saveData();
            console.log(`✅ 数据库 '${dbName}' 已删除`);
            return { success: true };
        }
        
        // CREATE TABLE
        if (upperSQL.startsWith('CREATE TABLE')) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            const match = sql.match(/CREATE\s+TABLE\s+(\w+)\s*\(([\s\S]+)\)/i);
            if (!match) throw new Error('CREATE TABLE 语法错误');
            const tableName = match[1];
            const columnsDef = match[2];
            if (databases[currentDatabase].tables[tableName]) {
                throw new Error(`表 '${tableName}' 已存在`);
            }
            
            const columns = [];
            const parts = columnsDef.split(',');
            for (const part of parts) {
                const colMatch = part.trim().match(/^(\w+)\s+(\w+)(?:\s*\((\d+)\))?(.*)$/i);
                if (colMatch) {
                    columns.push({
                        name: colMatch[1],
                        type: colMatch[2].toUpperCase(),
                        size: colMatch[3] ? parseInt(colMatch[3]) : null,
                        primaryKey: /PRIMARY\s+KEY/i.test(colMatch[4]),
                        notNull: /NOT\s+NULL/i.test(colMatch[4])
                    });
                }
            }
            
            databases[currentDatabase].tables[tableName] = {
                columns: columns,
                foreignKeys: [],
                data: []
            };
            saveData();
            console.log(`✅ 表 '${tableName}' 创建成功，共 ${columns.length} 个字段`);
            return { success: true };
        }
        
        // DROP TABLE
        if (upperSQL.startsWith('DROP TABLE')) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            const match = sql.match(/DROP\s+TABLE\s+(\w+)/i);
            if (!match) throw new Error('DROP TABLE 语法错误');
            const tableName = match[1];
            if (!databases[currentDatabase].tables[tableName]) {
                throw new Error(`表 '${tableName}' 不存在`);
            }
            delete databases[currentDatabase].tables[tableName];
            saveData();
            console.log(`✅ 表 '${tableName}' 已删除`);
            return { success: true };
        }
        
        // INSERT
        if (upperSQL.startsWith('INSERT')) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            const match = sql.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
            if (!match) throw new Error('INSERT 语法错误');
            const tableName = match[1];
            const table = databases[currentDatabase].tables[tableName];
            if (!table) throw new Error(`表 '${tableName}' 不存在`);
            
            const colNames = match[2].split(',').map(c => c.trim());
            const values = match[3].split(',').map(v => parseValue(v.trim()));
            
            const row = {};
            // 自增ID
            const pkCol = table.columns.find(c => c.primaryKey);
            if (pkCol && !colNames.includes(pkCol.name)) {
                const maxId = table.data.reduce((max, r) => Math.max(max, r[pkCol.name] || 0), 0);
                row[pkCol.name] = maxId + 1;
            }
            colNames.forEach((col, i) => { row[col] = values[i]; });
            table.data.push(row);
            saveData();
            console.log(`✅ 成功插入 1 行数据`);
            return { success: true };
        }
        
        // SELECT
        if (upperSQL.startsWith('SELECT')) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            
            // 简单SELECT解析
            const match = sql.match(/SELECT\s+(.*?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+LIMIT\s+(\d+))?$/i);
            if (!match) throw new Error('SELECT 语法错误');
            
            const selectCols = match[1].trim();
            const tableName = match[2];
            const whereClause = match[3];
            const limit = match[4] ? parseInt(match[4]) : null;
            
            const table = databases[currentDatabase].tables[tableName];
            if (!table) throw new Error(`表 '${tableName}' 不存在`);
            
            let data = [...table.data];
            
            // WHERE过滤
            if (whereClause) {
                data = data.filter(row => {
                    const condMatch = whereClause.match(/(\w+)\s*(=|!=|<>|<=|>=|<|>)\s*(.+)/);
                    if (condMatch) {
                        const col = condMatch[1];
                        const op = condMatch[2];
                        const val = parseValue(condMatch[3]);
                        switch (op) {
                            case '=': return row[col] == val;
                            case '!=':
                            case '<>': return row[col] != val;
                            case '<': return row[col] < val;
                            case '>': return row[col] > val;
                            case '<=': return row[col] <= val;
                            case '>=': return row[col] >= val;
                        }
                    }
                    return true;
                });
            }
            
            // LIMIT
            if (limit) data = data.slice(0, limit);
            
            // 列选择
            let columns = selectCols === '*' ? table.columns.map(c => c.name) : selectCols.split(',').map(c => c.trim());
            
            // 打印结果
            if (data.length === 0) {
                console.log('\n(空结果集)\n');
            } else {
                console.log();
                // 表头
                console.log(columns.join('\t'));
                console.log(columns.map(() => '--------').join('\t'));
                // 数据
                data.forEach(row => {
                    console.log(columns.map(c => row[c] ?? 'NULL').join('\t'));
                });
                console.log(`\n共 ${data.length} 行\n`);
            }
            return { success: true, data };
        }
        
        // UPDATE
        if (upperSQL.startsWith('UPDATE')) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            const match = sql.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/i);
            if (!match) throw new Error('UPDATE 语法错误');
            
            const tableName = match[1];
            const setClause = match[2];
            const whereClause = match[3];
            
            const table = databases[currentDatabase].tables[tableName];
            if (!table) throw new Error(`表 '${tableName}' 不存在`);
            
            let count = 0;
            for (const row of table.data) {
                let matches = true;
                if (whereClause) {
                    const condMatch = whereClause.match(/(\w+)\s*=\s*(.+)/);
                    if (condMatch) {
                        matches = row[condMatch[1]] == parseValue(condMatch[2]);
                    }
                }
                if (matches) {
                    const setParts = setClause.split(',');
                    for (const part of setParts) {
                        const eqIdx = part.indexOf('=');
                        const col = part.substring(0, eqIdx).trim();
                        const expr = part.substring(eqIdx + 1).trim();
                        // 支持算术表达式
                        const arithMatch = expr.match(/^(\w+)\s*([+\-*\/])\s*(\d+\.?\d*)$/);
                        if (arithMatch) {
                            const colName = arithMatch[1];
                            const op = arithMatch[2];
                            const num = parseFloat(arithMatch[3]);
                            const colVal = parseFloat(row[colName]) || 0;
                            switch (op) {
                                case '+': row[col] = colVal + num; break;
                                case '-': row[col] = colVal - num; break;
                                case '*': row[col] = colVal * num; break;
                                case '/': row[col] = num !== 0 ? colVal / num : 0; break;
                            }
                        } else {
                            row[col] = parseValue(expr);
                        }
                    }
                    count++;
                }
            }
            saveData();
            console.log(`✅ 成功更新 ${count} 行数据`);
            return { success: true };
        }
        
        // DELETE
        if (upperSQL.startsWith('DELETE')) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            const match = sql.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/i);
            if (!match) throw new Error('DELETE 语法错误');
            
            const tableName = match[1];
            const whereClause = match[2];
            
            const table = databases[currentDatabase].tables[tableName];
            if (!table) throw new Error(`表 '${tableName}' 不存在`);
            
            const originalLen = table.data.length;
            if (whereClause) {
                table.data = table.data.filter(row => {
                    const condMatch = whereClause.match(/(\w+)\s*=\s*(.+)/);
                    if (condMatch) {
                        return row[condMatch[1]] != parseValue(condMatch[2]);
                    }
                    return true;
                });
            } else {
                table.data = [];
            }
            saveData();
            console.log(`✅ 成功删除 ${originalLen - table.data.length} 行数据`);
            return { success: true };
        }
        
        // DESC / DESCRIBE
        if (upperSQL.startsWith('DESC ') || upperSQL.startsWith('DESCRIBE ')) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            const match = sql.match(/(?:DESC|DESCRIBE)\s+(\w+)/i);
            if (!match) throw new Error('DESC 语法错误');
            const tableName = match[1];
            const table = databases[currentDatabase].tables[tableName];
            if (!table) throw new Error(`表 '${tableName}' 不存在`);
            
            console.log(`\n📋 表结构: ${tableName}`);
            console.log('字段名\t\t类型\t\tPK\tNOT NULL');
            console.log('--------\t--------\t--\t--------');
            table.columns.forEach(col => {
                const type = col.size ? `${col.type}(${col.size})` : col.type;
                console.log(`${col.name}\t\t${type}\t\t${col.primaryKey ? '✓' : ''}\t${col.notNull ? '✓' : ''}`);
            });
            console.log();
            return { success: true };
        }
        
        throw new Error(`不支持的SQL语句: ${sql}`);
        
    } catch (e) {
        console.error(`❌ 错误: ${e.message}`);
        return { success: false, error: e.message };
    }
}

// 交互模式
function startInteractive() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'minisql> '
    });
    
    console.log('\n🗄️  MiniSQL 命令行工具');
    console.log('输入 SQL 语句执行，输入 exit 或 quit 退出\n');
    
    rl.prompt();
    
    rl.on('line', (line) => {
        const input = line.trim();
        if (!input) {
            rl.prompt();
            return;
        }
        if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
            console.log('👋 再见！');
            rl.close();
            process.exit(0);
        }
        if (input.toLowerCase() === 'help') {
            console.log('\n📖 帮助:');
            console.log('  SHOW DATABASES       - 显示所有数据库');
            console.log('  USE <db>             - 切换数据库');
            console.log('  SHOW TABLES          - 显示当前数据库的表');
            console.log('  DESC <table>         - 显示表结构');
            console.log('  CREATE DATABASE <db> - 创建数据库');
            console.log('  CREATE TABLE ...     - 创建表');
            console.log('  SELECT ...           - 查询数据');
            console.log('  INSERT ...           - 插入数据');
            console.log('  UPDATE ...           - 更新数据');
            console.log('  DELETE ...           - 删除数据');
            console.log('  exit / quit          - 退出\n');
            rl.prompt();
            return;
        }
        
        // 执行SQL（可能是多条，用分号分隔）
        const statements = input.split(';').filter(s => s.trim());
        for (const stmt of statements) {
            executeSQL(stmt.trim());
        }
        
        // 更新提示符显示当前数据库
        rl.setPrompt(currentDatabase ? `minisql(${currentDatabase})> ` : 'minisql> ');
        rl.prompt();
    });
    
    rl.on('close', () => {
        process.exit(0);
    });
}

// 解析命令行参数
function parseArgs() {
    const args = process.argv.slice(2);
    const options = { database: null, execute: null };
    
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-d' || args[i] === '--database') {
            options.database = args[++i];
        } else if (args[i] === '-e' || args[i] === '--execute') {
            options.execute = args[++i];
        } else if (args[i] === '-h' || args[i] === '--help') {
            console.log('用法: node cli.js [选项]');
            console.log('选项:');
            console.log('  -d, --database <name>  指定数据库');
            console.log('  -e, --execute <sql>    执行SQL语句');
            console.log('  -h, --help             显示帮助');
            process.exit(0);
        }
    }
    return options;
}

// 主函数
function main() {
    loadData();
    const options = parseArgs();
    
    // 如果指定了数据库
    if (options.database) {
        if (databases[options.database]) {
            currentDatabase = options.database;
            console.log(`✅ 已选择数据库: ${currentDatabase}`);
        } else {
            console.error(`❌ 数据库 '${options.database}' 不存在`);
            process.exit(1);
        }
    }
    
    // 如果指定了SQL语句，直接执行并退出
    if (options.execute) {
        const statements = options.execute.split(';').filter(s => s.trim());
        for (const stmt of statements) {
            executeSQL(stmt.trim());
        }
        process.exit(0);
    }
    
    // 否则进入交互模式
    startInteractive();
}

main();
