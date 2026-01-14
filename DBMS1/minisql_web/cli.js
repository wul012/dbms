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

const DATA_DIR = path.join(__dirname, 'data');
const LOCK_DIR = path.join(__dirname, 'data', 'locks');

// 数据库状态
let databases = {};
let currentDatabase = null;
let tableVersions = {};

let inTransaction = false;
let transactionSnapshot = null;
let transactionSnapshotVersions = null;
let transactionModifiedTables = new Set();
let transactionModifiedDatabases = new Set();
let transactionDeletedTables = new Set();
let transactionDeletedDatabases = new Set();
let transactionRenamedTables = [];

function ensureDataDir() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true });
    } catch {}
}

function listDatabasesFromMetadataFiles() {
    ensureDataDir();
    try {
        const files = fs.readdirSync(DATA_DIR);
        return files
            .filter(f => f.endsWith('_metadata.json'))
            .map(f => f.replace('_metadata.json', ''));
    } catch {
        return [];
    }
}

function makeUniqueName(baseName, existsFn) {
    if (!existsFn(baseName)) return baseName;
    for (let i = 1; i < 10000; i++) {
        const candidate = `${baseName}_import${i}`;
        if (!existsFn(candidate)) return candidate;
    }
    return `${baseName}_import${Date.now()}`;
}

function buildBackupSnapshot({ database }) {
    ensureDataDir();
    const scopeType = database ? 'db' : 'all';
    const snapshot = {
        version: '2.0',
        exportTime: new Date().toISOString(),
        scope: scopeType === 'db' ? { type: 'db', database } : { type: 'all' },
        databases: {},
        tableData: {},
        tableVersions: {}
    };

    let dbNames = [];
    if (scopeType === 'db') {
        if (!database) throw new Error('缺少 database 参数');
        if (!fs.existsSync(getMetadataFile(database))) throw new Error(`数据库不存在: ${database}`);
        dbNames = [database];
    } else {
        dbNames = listDatabasesFromMetadataFiles();
    }

    for (const dbName of dbNames) {
        const metaJson = JSON.parse(fs.readFileSync(getMetadataFile(dbName), 'utf8'));
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

    return snapshot;
}

function clearAllDataFiles() {
    ensureDataDir();
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
    } catch {}

    try {
        const lockFiles = fs.readdirSync(LOCK_DIR);
        for (const file of lockFiles) {
            const fullPath = path.join(LOCK_DIR, file);
            let stat;
            try { stat = fs.statSync(fullPath); } catch { continue; }
            if (!stat.isFile()) continue;
            if (file.toLowerCase().endsWith('.lock')) {
                try { fs.unlinkSync(fullPath); } catch {}
            }
        }
    } catch {}
}

function restoreFromSnapshot(snapshot) {
    ensureDataDir();
    const incomingDbs = snapshot && snapshot.databases ? snapshot.databases : {};
    const incomingTableData = snapshot && snapshot.tableData ? snapshot.tableData : {};

    const existingDbs = new Set(listDatabasesFromMetadataFiles());
    const renamedDatabases = {};
    const renamedTables = {};

    for (const [srcDbName, srcDbMeta] of Object.entries(incomingDbs)) {
        const targetDbName = makeUniqueName(srcDbName, (n) => existingDbs.has(n));
        if (targetDbName !== srcDbName) renamedDatabases[srcDbName] = targetDbName;
        existingDbs.add(targetDbName);

        const existingMetaJson = readJsonIfExists(getMetadataFile(targetDbName), { metadata: { tables: {} } });
        const existingMeta = (existingMetaJson && existingMetaJson.metadata) ? existingMetaJson.metadata : { tables: {} };
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

        for (const tMeta of Object.values(outTables)) {
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

        for (const [srcTableName] of Object.entries(srcTables)) {
            const targetTableName = tableRenameMap[srcTableName] || srcTableName;
            const srcKey = `${srcDbName}.${srcTableName}`;
            const payload = incomingTableData[srcKey] || { version: null, data: [] };
            const outPayload = {
                version: (payload && Object.prototype.hasOwnProperty.call(payload, 'version')) ? (payload.version ?? null) : null,
                data: (payload && Array.isArray(payload.data)) ? payload.data : []
            };
            const version = outPayload.version || new Date().toISOString();

            if (!acquireTableLock(targetDbName, targetTableName)) {
                throw new Error(`表 ${targetDbName}.${targetTableName} 被其他进程锁定，请稍后重试`);
            }
            try {
                fs.writeFileSync(getTableFile(targetDbName, targetTableName), JSON.stringify({ version, data: outPayload.data }, null, 2), 'utf8');
            } finally {
                releaseTableLock(targetDbName, targetTableName);
            }
        }
    }

    return { renamedDatabases, renamedTables };
}

function getMetadataFile(dbName) {
    return path.join(DATA_DIR, `${dbName}_metadata.json`);
}

function getTableFile(dbName, tableName) {
    return path.join(DATA_DIR, `${dbName}_${tableName}.json`);
}

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

function readJsonIfExists(filePath, defaultValue) {
    try {
        if (!fs.existsSync(filePath)) return defaultValue;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return defaultValue;
    }
}

async function saveMetadata(dbName) {
    ensureDataDir();
    const db = databases[dbName];
    if (!db) throw new Error(`数据库 '${dbName}' 不存在`);
    const metaOut = { metadata: { tables: {} } };
    for (const [tableName, table] of Object.entries((db && db.tables) || {})) {
        metaOut.metadata.tables[tableName] = {
            columns: table.columns || [],
            foreignKeys: table.foreignKeys || [],
            indexes: table.indexes || {}
        };
    }
    fs.writeFileSync(getMetadataFile(dbName), JSON.stringify(metaOut, null, 2), 'utf8');
}

async function saveTableData(dbName, tableName, expectedVersion) {
    ensureDataDir();
    const db = databases[dbName];
    if (!db || !db.tables || !db.tables[tableName]) throw new Error(`表 '${tableName}' 不存在`);

    if (!acquireTableLock(dbName, tableName)) {
        throw new Error(`表 ${tableName} 被其他进程锁定，请稍后重试`);
    }

    try {
        const tableFile = getTableFile(dbName, tableName);
        const existing = readJsonIfExists(tableFile, null);
        if (existing && expectedVersion && existing.version && existing.version !== expectedVersion) {
            throw new Error(`表 ${tableName} 版本冲突：期望 ${expectedVersion}，实际 ${existing.version}`);
        }

        const version = new Date().toISOString();
        const data = Array.isArray(db.tables[tableName].data) ? db.tables[tableName].data : [];
        fs.writeFileSync(tableFile, JSON.stringify({ version, data }, null, 2), 'utf8');
        tableVersions[`${dbName}.${tableName}`] = version;
    } finally {
        releaseTableLock(dbName, tableName);
    }
}

async function persistTable(dbName, tableName) {
    if (inTransaction) {
        transactionModifiedTables.add(`${dbName}.${tableName}`);
        return;
    }
    const key = `${dbName}.${tableName}`;
    await saveTableData(dbName, tableName, tableVersions[key] || null);
}

async function persistDbMetadata(dbName) {
    if (inTransaction) {
        transactionModifiedDatabases.add(dbName);
        return;
    }
    await saveMetadata(dbName);
}

function deleteDatabaseFiles(dbName) {
    try { fs.unlinkSync(getMetadataFile(dbName)); } catch {}
    try {
        const files = fs.readdirSync(DATA_DIR);
        for (const file of files) {
            if (file.startsWith(`${dbName}_`) && file.toLowerCase().endsWith('.json') && !file.endsWith('_metadata.json')) {
                try { fs.unlinkSync(path.join(DATA_DIR, file)); } catch {}
            }
        }
    } catch {}

    try {
        const lockFiles = fs.readdirSync(LOCK_DIR);
        for (const file of lockFiles) {
            if (file.startsWith(`${dbName}_`) && file.toLowerCase().endsWith('.lock')) {
                try { fs.unlinkSync(path.join(LOCK_DIR, file)); } catch {}
            }
        }
    } catch {}
}

function splitStatements(sqlText) {
    const statements = [];
    let current = '';
    let quote = null;
    for (let i = 0; i < sqlText.length; i++) {
        const ch = sqlText[i];
        if (quote) {
            current += ch;
            if (ch === quote && sqlText[i - 1] !== '\\') quote = null;
            continue;
        }
        if (ch === '\'' || ch === '"') {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === ';') {
            if (current.trim()) statements.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) statements.push(current.trim());
    return statements;
}

// 加载数据
function loadData() {
    ensureDataDir();
    try {
        databases = {};
        tableVersions = {};
        const files = fs.readdirSync(DATA_DIR);
        for (const file of files) {
            if (!file.endsWith('_metadata.json')) continue;
            const dbName = file.replace('_metadata.json', '');
            const filePath = path.join(DATA_DIR, file);
            const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const meta = (content && content.metadata) ? content.metadata : content;
            const tables = (meta && meta.tables) ? meta.tables : {};

            databases[dbName] = { tables: {} };
            for (const [tableName, tableMeta] of Object.entries(tables)) {
                const tableFile = getTableFile(dbName, tableName);
                let tableContent = { data: [] };
                if (fs.existsSync(tableFile)) {
                    try {
                        tableContent = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
                    } catch {}
                }

                if (tableContent && tableContent.version) {
                    tableVersions[`${dbName}.${tableName}`] = tableContent.version;
                }

                databases[dbName].tables[tableName] = {
                    columns: (tableMeta && tableMeta.columns) ? tableMeta.columns : [],
                    foreignKeys: (tableMeta && tableMeta.foreignKeys) ? tableMeta.foreignKeys : [],
                    indexes: (tableMeta && tableMeta.indexes) ? tableMeta.indexes : {},
                    data: Array.isArray(tableContent.data) ? tableContent.data : []
                };
            }
        }
        console.log(`✅ 已加载 ${Object.keys(databases).length} 个数据库`);
    } catch (e) {
        console.error('加载数据失败:', e.message);
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

function parseValues(valStr) {
    const values = [];
    let current = '';
    let inString = false;
    let stringChar = '';

    for (let i = 0; i < valStr.length; i++) {
        const char = valStr[i];
        if (!inString && (char === "'" || char === '"')) {
            inString = true;
            stringChar = char;
        } else if (inString && char === stringChar) {
            inString = false;
            stringChar = '';
        } else if (!inString && char === ',') {
            values.push(parseValue(current.trim()));
            current = '';
            continue;
        }
        current += char;
    }

    if (current.trim() || current === '') {
        if (current.trim()) values.push(parseValue(current.trim()));
    }

    return values;
}

function normalizeAggExpr(expr) {
    const m = expr.trim().match(/^(COUNT|SUM|AVG|MAX|MIN)\s*\(\s*(\*|\w+)\s*\)$/i);
    if (!m) return null;
    return `${m[1].toUpperCase()}(${m[2]})`;
}

function evaluateWhere(row, whereClause) {
    const splitTopLevel = (expr, keyword, betweenAware) => {
        const parts = [];
        let buf = '';
        let quote = null;
        let depth = 0;
        let pendingBetween = false;

        const isWordChar = (c) => /[A-Za-z0-9_]/.test(c || '');
        const matchKeywordAt = (s, idx, kw) => {
            if (s.substr(idx, kw.length).toUpperCase() !== kw) return false;
            const prev = idx > 0 ? s[idx - 1] : ' ';
            const next = idx + kw.length < s.length ? s[idx + kw.length] : ' ';
            if (isWordChar(prev)) return false;
            if (isWordChar(next)) return false;
            return true;
        };

        for (let i = 0; i < expr.length; i++) {
            const ch = expr[i];

            if (quote) {
                buf += ch;
                if (ch === quote && expr[i - 1] !== '\\') quote = null;
                continue;
            }
            if (ch === '\'' || ch === '"') {
                quote = ch;
                buf += ch;
                continue;
            }
            if (ch === '(') {
                depth++;
                buf += ch;
                continue;
            }
            if (ch === ')') {
                if (depth > 0) depth--;
                buf += ch;
                continue;
            }

            if (depth === 0 && matchKeywordAt(expr, i, 'BETWEEN')) {
                pendingBetween = true;
                buf += expr.substr(i, 'BETWEEN'.length);
                i += 'BETWEEN'.length - 1;
                continue;
            }

            if (depth === 0 && matchKeywordAt(expr, i, keyword)) {
                if (betweenAware && keyword === 'AND' && pendingBetween) {
                    pendingBetween = false;
                    buf += expr.substr(i, keyword.length);
                    i += keyword.length - 1;
                    continue;
                }
                if (buf.trim()) parts.push(buf.trim());
                buf = '';
                i += keyword.length - 1;
                continue;
            }

            buf += ch;
        }

        if (buf.trim()) parts.push(buf.trim());
        return parts;
    };

    const orParts = splitTopLevel(whereClause, 'OR', false);
    return orParts.some((part) => {
        const andParts = splitTopLevel(part, 'AND', true);
        return andParts.every(p => evaluateCondition(row, p));
    });
}

function evaluateCondition(row, condition) {
    let match;

    const resolveKey = (raw) => {
        const trimmed = raw.trim();
        const agg = normalizeAggExpr(trimmed);
        return agg || trimmed;
    };

    const resolveVal = (raw) => {
        const key = resolveKey(raw);
        return row[key];
    };

    match = condition.match(/^\s*([\w.]+|\w+\s*\(\s*(?:\*|\w+)\s*\))\s+BETWEEN\s+(.+?)\s+AND\s+(.+)\s*$/i);
    if (match) {
        const val = resolveVal(match[1]);
        const min = parseValue(match[2].trim());
        const max = parseValue(match[3].trim());
        return val >= min && val <= max;
    }

    match = condition.match(/^\s*([\w.]+|\w+\s*\(\s*(?:\*|\w+)\s*\))\s+NOT\s+IN\s*\(([^)]+)\)\s*$/i);
    if (match) {
        const val = resolveVal(match[1]);
        const values = match[2].split(',').map(v => parseValue(v.trim()));
        return !values.some(v => v == val);
    }

    match = condition.match(/^\s*([\w.]+|\w+\s*\(\s*(?:\*|\w+)\s*\))\s+IN\s*\(([^)]+)\)\s*$/i);
    if (match) {
        const val = resolveVal(match[1]);
        const values = match[2].split(',').map(v => parseValue(v.trim()));
        return values.some(v => v == val);
    }

    match = condition.match(/^\s*([\w.]+|\w+\s*\(\s*(?:\*|\w+)\s*\))\s+LIKE\s+'([^']+)'\s*$/i);
    if (match) {
        const val = resolveVal(match[1]);
        const pattern = match[2].replace(/%/g, '.*').replace(/_/g, '.');
        return new RegExp(`^${pattern}$`, 'i').test(val);
    }

    match = condition.match(/^\s*([\w.]+|\w+\s*\(\s*(?:\*|\w+)\s*\))\s+IS\s+(NOT\s+)?NULL\s*$/i);
    if (match) {
        const val = resolveVal(match[1]);
        return match[2] ? val !== null && val !== undefined : val === null || val === undefined;
    }

    match = condition.match(/^\s*([\w.]+|\w+\s*\(\s*(?:\*|\w+)\s*\))\s*(=|!=|<>|<=|>=|<|>)\s*(.+?)\s*$/);
    if (match) {
        const colName = resolveKey(match[1]);
        const op = match[2];
        const compareVal = parseValue(match[3].trim());
        const rowVal = row[colName];

        switch (op) {
            case '=': return rowVal == compareVal;
            case '!=':
            case '<>': return rowVal != compareVal;
            case '<': return rowVal < compareVal;
            case '>': return rowVal > compareVal;
            case '<=': return rowVal <= compareVal;
            case '>=': return rowVal >= compareVal;
        }
    }

    const trimmed = condition.trim();
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
        return evaluateWhere(row, trimmed.slice(1, -1));
    }
    throw new Error(`WHERE 条件语法错误: ${condition}`);
}

function executeAggregateSelect(selectCols, data, groupBy, havingClause, orderBy, orderDir, limit) {
    const aggregateFuncs = {
        COUNT: (arr, col) => col === '*' ? arr.length : arr.filter(r => r[col] !== null && r[col] !== undefined).length,
        SUM: (arr, col) => arr.reduce((sum, r) => sum + (Number(r[col]) || 0), 0),
        AVG: (arr, col) => { const vals = arr.filter(r => r[col] !== null); return vals.length ? vals.reduce((s, r) => s + Number(r[col]), 0) / vals.length : 0; },
        MAX: (arr, col) => Math.max(...arr.map(r => r[col]).filter(v => v !== null && v !== undefined)),
        MIN: (arr, col) => Math.min(...arr.map(r => r[col]).filter(v => v !== null && v !== undefined))
    };

    const selectItems = selectCols.split(',').map(s => s.trim());
    const columns = [];
    const colDefs = [];

    for (const item of selectItems) {
        const aggMatch = item.match(/(\w+)\s*\(\s*(\*|\w+)\s*\)(?:\s+AS\s+(\w+))?/i);
        if (aggMatch) {
            const func = aggMatch[1].toUpperCase();
            const col = aggMatch[2];
            const alias = aggMatch[3] || `${func}(${col})`;
            columns.push(alias);
            colDefs.push({ type: 'agg', func, col, alias });
        } else {
            const colName = item.split('.').pop();
            columns.push(colName);
            colDefs.push({ type: 'col', col: colName });
        }
    }

    const requiredAggMap = new Map();
    for (const def of colDefs) {
        if (def.type === 'agg') requiredAggMap.set(`${def.func}(${def.col})`, { func: def.func, col: def.col });
    }
    if (havingClause) {
        const re = /\b(COUNT|SUM|AVG|MAX|MIN)\s*\(\s*(\*|\w+)\s*\)/ig;
        let m;
        while ((m = re.exec(havingClause)) !== null) {
            const key = `${m[1].toUpperCase()}(${m[2]})`;
            requiredAggMap.set(key, { func: m[1].toUpperCase(), col: m[2] });
        }
    }

    let result = [];

    if (groupBy) {
        const groupCols = groupBy.split(',').map(c => c.trim());
        const groups = new Map();

        for (const row of data) {
            const key = groupCols.map(c => row[c]).join('|||');
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(row);
        }

        for (const [key, groupData] of groups) {
            const newRow = {};
            const keyParts = key.split('|||');
            groupCols.forEach((c, i) => newRow[c] = keyParts[i]);

            for (const [exprKey, def] of requiredAggMap.entries()) {
                let v = aggregateFuncs[def.func](groupData, def.col);
                if (def.func === 'AVG') v = Number(v.toFixed(2));
                newRow[exprKey] = v;
            }

            for (const def of colDefs) {
                if (def.type === 'agg') {
                    const exprKey = `${def.func}(${def.col})`;
                    newRow[def.alias] = newRow[exprKey];
                }
            }
            result.push(newRow);
        }

        if (havingClause) result = result.filter(row => evaluateWhere(row, havingClause));
    } else {
        const newRow = {};
        for (const [exprKey, def] of requiredAggMap.entries()) {
            let v = aggregateFuncs[def.func](data, def.col);
            if (def.func === 'AVG') v = Number(v.toFixed(2));
            newRow[exprKey] = v;
        }
        for (const def of colDefs) {
            if (def.type === 'agg') {
                const exprKey = `${def.func}(${def.col})`;
                newRow[def.alias] = newRow[exprKey];
            }
        }
        result.push(newRow);
    }

    if (orderBy) {
        result.sort((a, b) => {
            const va = a[orderBy], vb = b[orderBy];
            if (va < vb) return orderDir === 'ASC' ? -1 : 1;
            if (va > vb) return orderDir === 'ASC' ? 1 : -1;
            return 0;
        });
    }

    if (limit) result = result.slice(0, limit);
    return { columns, data: result, message: `聚合查询到 ${result.length} 行数据` };
}

async function executeJoinSelect(sql) {
    const joinMatch = sql.match(/SELECT\s+(.*?)\s+FROM\s+(\w+)(?:\s+(\w+))?\s+JOIN\s+(\w+)(?:\s+(\w+))?\s+ON\s+(.+?)(?:\s+WHERE\s+(.+))?$/i);
    if (!joinMatch) throw new Error('JOIN 语法错误');

    const selectCols = joinMatch[1].trim();
    const table1Name = joinMatch[2];
    const alias1 = joinMatch[3] || table1Name;
    const table2Name = joinMatch[4];
    const alias2 = joinMatch[5] || table2Name;
    const onCondition = joinMatch[6];
    const whereClause = joinMatch[7];

    const table1 = databases[currentDatabase].tables[table1Name];
    const table2 = databases[currentDatabase].tables[table2Name];
    if (!table1) throw new Error(`表 '${table1Name}' 不存在`);
    if (!table2) throw new Error(`表 '${table2Name}' 不存在`);

    const data1 = table1.data || [];
    const data2 = table2.data || [];

    const onMatch = onCondition.match(/([\w.]+)\s*=\s*([\w.]+)/);
    if (!onMatch) throw new Error('ON 条件语法错误');

    const leftCol = onMatch[1].includes('.') ? onMatch[1].split('.')[1] : onMatch[1];
    const rightCol = onMatch[2].includes('.') ? onMatch[2].split('.')[1] : onMatch[2];

    let joinedData = [];
    for (const row1 of data1) {
        for (const row2 of data2) {
            if (row1[leftCol] == row2[rightCol]) {
                const merged = {};
                for (const col of (table1.columns || [])) {
                    merged[`${alias1}.${col.name}`] = row1[col.name];
                    merged[col.name] = row1[col.name];
                }
                for (const col of (table2.columns || [])) {
                    merged[`${alias2}.${col.name}`] = row2[col.name];
                    if (merged[col.name] === undefined) merged[col.name] = row2[col.name];
                }
                joinedData.push(merged);
            }
        }
    }

    if (whereClause) joinedData = joinedData.filter(row => evaluateWhere(row, whereClause));

    let columns = [];
    if (selectCols === '*') {
        columns = [...(table1.columns || []).map(c => `${alias1}.${c.name}`), ...(table2.columns || []).map(c => `${alias2}.${c.name}`)];
    } else {
        columns = selectCols.split(',').map(c => c.trim());
        const expandedCols = [];
        for (const col of columns) {
            if (col.endsWith('.*')) {
                const tAlias = col.split('.')[0];
                const tName = tAlias === alias1 ? table1Name : (tAlias === alias2 ? table2Name : tAlias);
                const t = databases[currentDatabase].tables[tName];
                if (t) expandedCols.push(...(t.columns || []).map(c => `${tAlias}.${c.name}`));
            } else {
                expandedCols.push(col);
            }
        }
        columns = expandedCols;
    }

    const projectedData = joinedData.map(row => {
        const newRow = {};
        for (const col of columns) {
            newRow[col] = row[col] ?? null;
        }
        return newRow;
    });

    return { columns, data: projectedData, message: `JOIN查询到 ${projectedData.length} 行数据` };
}

async function executeRenameTableCli(sql) {
    if (!currentDatabase) throw new Error('请先选择数据库');
    const match = sql.match(/RENAME\s+TABLE\s+(\w+)\s+TO\s+(\w+)/i);
    if (!match) throw new Error('RENAME TABLE 语法错误，格式: RENAME TABLE old TO new');
    const oldName = match[1], newName = match[2];

    const db = databases[currentDatabase];
    if (!db || !db.tables || !db.tables[oldName]) throw new Error(`表 '${oldName}' 不存在`);
    if (db.tables[newName]) throw new Error(`表 '${newName}' 已存在`);

    const oldKey = `${currentDatabase}.${oldName}`;
    const newKey = `${currentDatabase}.${newName}`;

    db.tables[newName] = db.tables[oldName];
    delete db.tables[oldName];

    for (const tbl of Object.values(db.tables || {})) {
        const fks = tbl && tbl.foreignKeys ? tbl.foreignKeys : [];
        for (const fk of fks) {
            if (fk && fk.refTable && String(fk.refTable).toLowerCase() === String(oldName).toLowerCase()) {
                fk.refTable = newName;
            }
        }
    }

    if (Object.prototype.hasOwnProperty.call(tableVersions, oldKey) && !Object.prototype.hasOwnProperty.call(tableVersions, newKey)) {
        tableVersions[newKey] = tableVersions[oldKey];
    }
    delete tableVersions[oldKey];

    if (inTransaction) {
        transactionRenamedTables.push({ dbName: currentDatabase, from: oldName, to: newName });
        if (transactionModifiedTables.has(oldKey)) {
            transactionModifiedTables.delete(oldKey);
            transactionModifiedTables.add(newKey);
        }
        if (transactionDeletedTables.has(oldKey)) {
            transactionDeletedTables.delete(oldKey);
            transactionDeletedTables.add(newKey);
        }
    } else {
        const fromFile = getTableFile(currentDatabase, oldName);
        const toFile = getTableFile(currentDatabase, newName);
        if (fs.existsSync(fromFile) && !fs.existsSync(toFile)) {
            try { fs.renameSync(fromFile, toFile); } catch {}
        }

        const fromLock = path.join(LOCK_DIR, `${currentDatabase}_${oldName}.lock`);
        const toLock = path.join(LOCK_DIR, `${currentDatabase}_${newName}.lock`);
        if (fs.existsSync(fromLock) && !fs.existsSync(toLock)) {
            try { fs.renameSync(fromLock, toLock); } catch {}
        }
    }

    await persistDbMetadata(currentDatabase);
    return { success: true, message: `表 '${oldName}' 已重命名为 '${newName}'` };
}

async function executeTruncateCli(sql) {
    if (!currentDatabase) throw new Error('请先选择数据库');
    const match = sql.match(/TRUNCATE\s+(?:TABLE\s+)?(\w+)/i);
    if (!match) throw new Error('TRUNCATE 语法错误');
    const tableName = match[1];
    const table = databases[currentDatabase].tables[tableName];
    if (!table) throw new Error(`表 '${tableName}' 不存在`);
    const count = (table.data || []).length;
    table.data = [];
    await persistTable(currentDatabase, tableName);
    return { success: true, message: `成功清空表 '${tableName}'，删除 ${count} 行` };
}

function printTabularResult(columns, data) {
    if (!data || data.length === 0) {
        console.log('\n(空结果集)\n');
        return;
    }
    console.log();
    console.log(columns.join('\t'));
    console.log(columns.map(() => '--------').join('\t'));
    data.forEach(row => {
        console.log(columns.map(c => row[c] ?? 'NULL').join('\t'));
    });
    console.log(`\n共 ${data.length} 行\n`);
}

async function executeCreateIndexCli(sql) {
    if (!currentDatabase) throw new Error('请先选择数据库');
    const match = sql.match(/CREATE\s+(UNIQUE\s+)?INDEX\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]+)\)/i);
    if (!match) throw new Error('CREATE INDEX 语法错误');

    const isUnique = !!match[1];
    const indexName = match[2];
    const tableName = match[3];
    const columns = match[4].split(',').map(c => c.trim());

    const table = databases[currentDatabase].tables[tableName];
    if (!table) throw new Error(`表 '${tableName}' 不存在`);

    for (const col of columns) {
        if (!(table.columns || []).find(c => c && c.name && c.name.toLowerCase() === col.toLowerCase())) {
            throw new Error(`列 '${col}' 不存在于表 '${tableName}'`);
        }
    }

    if (!table.indexes) table.indexes = {};
    if (table.indexes[indexName]) throw new Error(`索引 '${indexName}' 已存在`);

    if (isUnique && (table.data || []).length > 0) {
        const seen = new Set();
        for (const row of (table.data || [])) {
            const key = columns.map(c => row[c]).join('|');
            if (seen.has(key)) throw new Error(`无法创建唯一索引：列 (${columns.join(', ')}) 存在重复值`);
            seen.add(key);
        }
    }

    const indexData = {};
    (table.data || []).forEach((row, idx) => {
        const key = columns.map(c => row[c]).join('|');
        if (!indexData[key]) indexData[key] = [];
        indexData[key].push(idx);
    });

    table.indexes[indexName] = {
        name: indexName,
        columns,
        unique: isUnique,
        data: indexData,
        createdAt: new Date().toISOString()
    };

    await persistDbMetadata(currentDatabase);
    return { success: true, message: `成功创建${isUnique ? '唯一' : ''}索引 '${indexName}' ON ${tableName}(${columns.join(', ')})` };
}

async function executeDropIndexCli(sql) {
    if (!currentDatabase) throw new Error('请先选择数据库');
    const match = sql.match(/DROP\s+INDEX\s+(\w+)\s+ON\s+(\w+)/i);
    if (!match) throw new Error('DROP INDEX 语法错误');
    const indexName = match[1];
    const tableName = match[2];

    const table = databases[currentDatabase].tables[tableName];
    if (!table) throw new Error(`表 '${tableName}' 不存在`);
    if (!table.indexes || !table.indexes[indexName]) throw new Error(`索引 '${indexName}' 不存在`);

    delete table.indexes[indexName];
    await persistDbMetadata(currentDatabase);
    return { success: true, message: `成功删除索引 '${indexName}'` };
}

function executeShowIndexesCli(sql) {
    if (!currentDatabase) throw new Error('请先选择数据库');
    const match = sql.match(/SHOW\s+INDEX(?:ES)?\s+(?:FROM|ON)\s+(\w+)/i);
    if (!match) throw new Error('SHOW INDEXES 语法错误');
    const tableName = match[1];
    const table = databases[currentDatabase].tables[tableName];
    if (!table) throw new Error(`表 '${tableName}' 不存在`);

    const indexes = table.indexes || {};
    const data = [];
    const pkCol = (table.columns || []).find(c => c && c.primaryKey);
    if (pkCol && pkCol.name) {
        data.push({ Table: tableName, Index_name: 'PRIMARY', Unique: 'YES', Columns: pkCol.name, Type: 'BTREE' });
    }
    for (const [name, idx] of Object.entries(indexes)) {
        data.push({
            Table: tableName,
            Index_name: name,
            Unique: idx && idx.unique ? 'YES' : 'NO',
            Columns: idx && idx.columns ? idx.columns.join(', ') : '',
            Type: 'BTREE'
        });
    }
    return { columns: ['Table', 'Index_name', 'Unique', 'Columns', 'Type'], data };
}

function executeShowForeignKeysCli(sql) {
    if (!currentDatabase) throw new Error('请先选择数据库');
    const match = sql.match(/SHOW\s+(?:FOREIGN\s+KEYS|REFERENCES)\s+(?:FROM|ON)\s+(\w+)/i);
    if (!match) throw new Error('SHOW FOREIGN KEYS 语法错误');
    const tableName = match[1];
    const table = databases[currentDatabase].tables[tableName];
    if (!table) throw new Error(`表 '${tableName}' 不存在`);

    const foreignKeys = Array.isArray(table.foreignKeys) ? table.foreignKeys : [];
    const data = foreignKeys.map(fk => ({
        Constraint: (fk && (fk.name || `fk_${fk.column}`)) || '',
        Column: fk ? fk.column : '',
        RefTable: fk ? fk.refTable : '',
        RefColumn: fk ? fk.refColumn : '',
        OnDelete: fk ? (fk.onDelete || 'RESTRICT') : 'RESTRICT',
        OnUpdate: fk ? (fk.onUpdate || 'RESTRICT') : 'RESTRICT'
    }));
    return { columns: ['Constraint', 'Column', 'RefTable', 'RefColumn', 'OnDelete', 'OnUpdate'], data };
}

async function executeAlterTableCli(sql) {
    if (!currentDatabase) throw new Error('请先选择数据库');
    let match;

    const persistCurrentDbMetadata = async () => {
        await persistDbMetadata(currentDatabase);
    };

    match = sql.match(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:CONSTRAINT\s+(\w+)\s+)?FOREIGN\s+KEY\s*\((\w+)\)\s+REFERENCES\s+(\w+)\s*\((\w+)\)(?:\s+ON\s+DELETE\s+(CASCADE|SET NULL|RESTRICT|NO ACTION))?(?:\s+ON\s+UPDATE\s+(CASCADE|SET NULL|RESTRICT|NO ACTION))?/i);
    if (match) {
        const tableName = match[1];
        const constraintName = match[2] || `fk_${tableName}_${match[3]}`;
        const column = match[3];
        const refTable = match[4];
        const refColumn = match[5];
        const onDelete = match[6] ? match[6].toUpperCase() : 'RESTRICT';
        const onUpdate = match[7] ? match[7].toUpperCase() : 'RESTRICT';

        const table = databases[currentDatabase].tables[tableName];
        if (!table) throw new Error(`表 '${tableName}' 不存在`);
        if (!(table.columns || []).find(c => c && c.name && c.name.toLowerCase() === column.toLowerCase())) throw new Error(`列 '${column}' 不存在`);

        const refTableObj = databases[currentDatabase].tables[refTable];
        if (!refTableObj) throw new Error(`引用的表 '${refTable}' 不存在`);
        if (!(refTableObj.columns || []).find(c => c && c.name && c.name.toLowerCase() === refColumn.toLowerCase())) throw new Error(`引用的列 '${refTable}.${refColumn}' 不存在`);

        if (!table.foreignKeys) table.foreignKeys = [];
        if (table.foreignKeys.find(fk => fk && fk.column && fk.column.toLowerCase() === column.toLowerCase())) throw new Error(`列 '${column}' 已有外键约束`);

        const refValues = new Set((refTableObj.data || []).map(r => r[refColumn]));
        const tableDataArray = table.data || [];
        for (const row of tableDataArray) {
            const val = row[column];
            if (val !== null && val !== undefined && !refValues.has(val)) {
                throw new Error(`无法添加外键：现有数据 ${column}=${val} 在 ${refTable}.${refColumn} 中不存在`);
            }
        }

        table.foreignKeys.push({ name: constraintName, column, refTable, refColumn, onDelete, onUpdate });
        await persistCurrentDbMetadata();
        return { success: true, message: `成功添加外键约束 '${constraintName}'` };
    }

    match = sql.match(/ALTER\s+TABLE\s+(\w+)\s+DROP\s+FOREIGN\s+KEY\s+(\w+)/i);
    if (match) {
        const tableName = match[1], fkName = match[2];
        const table = databases[currentDatabase].tables[tableName];
        if (!table) throw new Error(`表 '${tableName}' 不存在`);
        if (!table.foreignKeys) table.foreignKeys = [];

        const fkIdx = table.foreignKeys.findIndex(fk => {
            const resolvedName = (fk && (fk.name || (fk.column ? (`fk_${tableName}_${fk.column}`) : ''))) || '';
            return resolvedName.toLowerCase() === fkName.toLowerCase();
        });
        if (fkIdx === -1) throw new Error(`外键约束 '${fkName}' 不存在`);
        table.foreignKeys.splice(fkIdx, 1);

        await persistCurrentDbMetadata();
        return { success: true, message: `成功删除外键约束 '${fkName}'` };
    }

    match = sql.match(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+)\s+(\w+)(?:\s*\((\d+)\))?/i);
    if (match) {
        const tableName = match[1];
        const table = databases[currentDatabase].tables[tableName];
        if (!table) throw new Error(`表 '${tableName}' 不存在`);
        const newCol = {
            name: match[2],
            type: match[3].toUpperCase(),
            size: match[4] ? parseInt(match[4]) : null,
            primaryKey: false,
            autoIncrement: false,
            notNull: false,
            default: null
        };
        (table.columns || (table.columns = [])).push(newCol);
        await persistCurrentDbMetadata();
        return { success: true, message: `成功添加列 '${newCol.name}'` };
    }

    match = sql.match(/ALTER\s+TABLE\s+(\w+)\s+DROP\s+(?:COLUMN\s+)?(\w+)/i);
    if (match) {
        const tableName = match[1], colName = match[2];
        const table = databases[currentDatabase].tables[tableName];
        if (!table) throw new Error(`表 '${tableName}' 不存在`);
        const cols = table.columns || [];
        const colIndex = cols.findIndex(c => c && c.name && c.name.toLowerCase() === colName.toLowerCase());
        if (colIndex === -1) throw new Error(`列 '${colName}' 不存在`);

        const ownedFk = (table.foreignKeys || []).find(fk => fk && fk.column && fk.column.toLowerCase() === colName.toLowerCase());
        if (ownedFk) {
            const fkDisplayName = ownedFk.name || `fk_${tableName}_${ownedFk.column}`;
            throw new Error(`无法删除列 '${tableName}.${colName}'：该列存在外键约束 '${fkDisplayName}'（请先 DROP FOREIGN KEY）`);
        }

        const referencing = [];
        for (const [otherTableName, otherTable] of Object.entries(databases[currentDatabase].tables || {})) {
            if (otherTableName === tableName) continue;
            const fks = otherTable.foreignKeys || [];
            for (const fk of fks) {
                if (!fk || !fk.refTable || !fk.refColumn) continue;
                if (String(fk.refTable).toLowerCase() === String(tableName).toLowerCase() && String(fk.refColumn).toLowerCase() === String(colName).toLowerCase()) {
                    referencing.push(`${otherTableName}.${fk.column}`);
                }
            }
        }
        if (referencing.length > 0) {
            throw new Error(`无法删除列 '${tableName}.${colName}'：被外键引用（请先删除相关外键）: ${referencing.join(', ')}`);
        }

        cols.splice(colIndex, 1);
        (table.data || []).forEach(row => { try { delete row[colName]; } catch {} });
        await persistCurrentDbMetadata();
        await persistTable(currentDatabase, tableName);
        return { success: true, message: `成功删除列 '${colName}'` };
    }

    match = sql.match(/ALTER\s+TABLE\s+(\w+)\s+MODIFY\s+(?:COLUMN\s+)?(\w+)\s+(\w+)(?:\s*\((\d+)\))?/i);
    if (match) {
        const tableName = match[1], colName = match[2];
        const table = databases[currentDatabase].tables[tableName];
        if (!table) throw new Error(`表 '${tableName}' 不存在`);
        const col = (table.columns || []).find(c => c && c.name && c.name.toLowerCase() === colName.toLowerCase());
        if (!col) throw new Error(`列 '${colName}' 不存在`);
        col.type = match[3].toUpperCase();
        col.size = match[4] ? parseInt(match[4]) : null;
        await persistCurrentDbMetadata();
        return { success: true, message: `成功修改列 '${colName}' 类型为 ${col.type}${col.size ? `(${col.size})` : ''}` };
    }

    match = sql.match(/ALTER\s+TABLE\s+(\w+)\s+RENAME\s+COLUMN\s+(\w+)\s+TO\s+(\w+)/i);
    if (match) {
        const tableName = match[1], oldColName = match[2], newColName = match[3];
        const table = databases[currentDatabase].tables[tableName];
        if (!table) throw new Error(`表 '${tableName}' 不存在`);
        const col = (table.columns || []).find(c => c && c.name && c.name.toLowerCase() === oldColName.toLowerCase());
        if (!col) throw new Error(`列 '${oldColName}' 不存在`);
        if ((table.columns || []).find(c => c && c.name && c.name.toLowerCase() === newColName.toLowerCase())) throw new Error(`列 '${newColName}' 已存在`);
        col.name = newColName;
        (table.data || []).forEach(row => {
            row[newColName] = row[oldColName];
            delete row[oldColName];
        });
        await persistCurrentDbMetadata();
        await persistTable(currentDatabase, tableName);
        return { success: true, message: `成功将列 '${oldColName}' 重命名为 '${newColName}'` };
    }

    throw new Error('ALTER TABLE 语法错误，支持: ADD, DROP, MODIFY, RENAME COLUMN, ADD/DROP FOREIGN KEY');
}

// 执行SQL
async function executeSQL(sql) {
    sql = sql.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!sql || sql.startsWith('--')) return null;
    
    const upperSQL = sql.toUpperCase();
    
    try {
        if (upperSQL === 'BEGIN' || upperSQL === 'START TRANSACTION' || upperSQL === 'BEGIN TRANSACTION') {
            if (inTransaction) throw new Error('事务已经开始，请先COMMIT或ROLLBACK');
            inTransaction = true;
            transactionSnapshot = JSON.parse(JSON.stringify(databases));
            transactionSnapshotVersions = JSON.parse(JSON.stringify(tableVersions));
            transactionModifiedTables.clear();
            transactionModifiedDatabases.clear();
            transactionDeletedTables.clear();
            transactionDeletedDatabases.clear();
            transactionRenamedTables = [];
            console.log('🔒 事务已开始 (BEGIN TRANSACTION) - 更改将暂存，需要COMMIT提交或ROLLBACK撤销');
            return { success: true };
        }

        if (upperSQL === 'COMMIT') {
            if (!inTransaction) throw new Error('没有活动的事务');

            for (const { dbName, from, to } of transactionRenamedTables) {
                if (transactionDeletedDatabases.has(dbName)) continue;
                if (transactionDeletedTables.has(`${dbName}.${from}`)) continue;
                const fromFile = getTableFile(dbName, from);
                const toFile = getTableFile(dbName, to);
                if (fs.existsSync(fromFile) && !fs.existsSync(toFile)) {
                    try { fs.renameSync(fromFile, toFile); } catch {}
                }

                const fromLock = path.join(LOCK_DIR, `${dbName}_${from}.lock`);
                const toLock = path.join(LOCK_DIR, `${dbName}_${to}.lock`);
                if (fs.existsSync(fromLock) && !fs.existsSync(toLock)) {
                    try { fs.renameSync(fromLock, toLock); } catch {}
                }

                const fromKey = `${dbName}.${from}`;
                const toKey = `${dbName}.${to}`;
                if (Object.prototype.hasOwnProperty.call(tableVersions, fromKey) && !Object.prototype.hasOwnProperty.call(tableVersions, toKey)) {
                    tableVersions[toKey] = tableVersions[fromKey];
                }
                delete tableVersions[fromKey];
            }

            for (const tableKey of transactionModifiedTables) {
                const dot = tableKey.indexOf('.');
                const dbName = tableKey.substring(0, dot);
                const tableName = tableKey.substring(dot + 1);
                if (transactionDeletedDatabases.has(dbName)) continue;
                if (transactionDeletedTables.has(tableKey)) continue;
                const expected = (transactionSnapshotVersions && transactionSnapshotVersions[tableKey]) ? transactionSnapshotVersions[tableKey] : (tableVersions[tableKey] || null);
                await saveTableData(dbName, tableName, expected || null);
            }
            transactionModifiedTables.clear();

            for (const tableKey of transactionDeletedTables) {
                const dot = tableKey.indexOf('.');
                const dbName = tableKey.substring(0, dot);
                const tableName = tableKey.substring(dot + 1);
                if (transactionDeletedDatabases.has(dbName)) continue;
                try { fs.unlinkSync(getTableFile(dbName, tableName)); } catch {}
                delete tableVersions[tableKey];
            }
            transactionDeletedTables.clear();

            for (const dbName of transactionDeletedDatabases) {
                deleteDatabaseFiles(dbName);
            }
            transactionDeletedDatabases.clear();

            for (const dbName of transactionModifiedDatabases) {
                await saveMetadata(dbName);
            }
            transactionModifiedDatabases.clear();

            inTransaction = false;
            transactionSnapshot = null;
            transactionSnapshotVersions = null;
            transactionRenamedTables = [];
            console.log('✅ 事务已提交 (COMMIT) - 所有更改已永久保存');
            return { success: true };
        }

        if (upperSQL === 'ROLLBACK') {
            if (!inTransaction) throw new Error('没有活动的事务');
            databases = transactionSnapshot;
            tableVersions = transactionSnapshotVersions || {};
            inTransaction = false;
            transactionSnapshot = null;
            transactionSnapshotVersions = null;
            transactionModifiedTables.clear();
            transactionModifiedDatabases.clear();
            transactionDeletedTables.clear();
            transactionDeletedDatabases.clear();
            transactionRenamedTables = [];
            console.log('⏪ 事务已回滚 (ROLLBACK) - 所有更改已撤销');
            return { success: true };
        }

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
            await persistDbMetadata(dbName);
            console.log(`✅ 数据库 '${dbName}' 创建成功`);
            return { success: true };
        }
        
        // DROP DATABASE
        if (upperSQL.startsWith('DROP DATABASE')) {
            const match = sql.match(/DROP\s+DATABASE\s+(\w+)/i);
            if (!match) throw new Error('DROP DATABASE 语法错误');
            const dbName = match[1];
            if (!databases[dbName]) throw new Error(`数据库 '${dbName}' 不存在`);
            if (!inTransaction) {
                deleteDatabaseFiles(dbName);
            } else {
                transactionDeletedDatabases.add(dbName);
            }
            delete databases[dbName];
            if (currentDatabase === dbName) currentDatabase = null;
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
                indexes: {},
                data: []
            };
            await persistDbMetadata(currentDatabase);
            await persistTable(currentDatabase, tableName);
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

            const referencing = [];
            for (const [otherTableName, otherTable] of Object.entries(databases[currentDatabase].tables || {})) {
                if (otherTableName === tableName) continue;
                const fks = otherTable.foreignKeys || [];
                for (const fk of fks) {
                    if (!fk || !fk.refTable) continue;
                    if (String(fk.refTable).toLowerCase() === String(tableName).toLowerCase()) {
                        referencing.push(`${otherTableName}.${fk.column}`);
                    }
                }
            }
            if (referencing.length > 0) {
                throw new Error(`无法删除表 '${tableName}'：被外键引用（请先删除相关外键）: ${referencing.join(', ')}`);
            }

            delete databases[currentDatabase].tables[tableName];
            if (!inTransaction) {
                try { fs.unlinkSync(getTableFile(currentDatabase, tableName)); } catch {}
                delete tableVersions[`${currentDatabase}.${tableName}`];
            } else {
                transactionDeletedTables.add(`${currentDatabase}.${tableName}`);
            }
            await persistDbMetadata(currentDatabase);
            console.log(`✅ 表 '${tableName}' 已删除`);
            return { success: true };
        }

        if (upperSQL.startsWith('RENAME TABLE')) {
            const r = await executeRenameTableCli(sql);
            if (r && r.message) console.log(`✅ ${r.message}`);
            return { success: true };
        }

        if (upperSQL.startsWith('TRUNCATE')) {
            const r = await executeTruncateCli(sql);
            if (r && r.message) console.log(`✅ ${r.message}`);
            return { success: true };
        }

        if (upperSQL.startsWith('CREATE INDEX') || upperSQL.startsWith('CREATE UNIQUE INDEX')) {
            const r = await executeCreateIndexCli(sql);
            if (r && r.message) console.log(`✅ ${r.message}`);
            return { success: true };
        }

        if (upperSQL.startsWith('DROP INDEX')) {
            const r = await executeDropIndexCli(sql);
            if (r && r.message) console.log(`✅ ${r.message}`);
            return { success: true };
        }

        if (upperSQL.startsWith('SHOW INDEX') || upperSQL.startsWith('SHOW INDEXES')) {
            const r = executeShowIndexesCli(sql);
            printTabularResult(r.columns, r.data);
            return { success: true, data: r.data };
        }

        if (upperSQL.startsWith('SHOW FOREIGN KEYS') || upperSQL.startsWith('SHOW REFERENCES')) {
            const r = executeShowForeignKeysCli(sql);
            printTabularResult(r.columns, r.data);
            return { success: true, data: r.data };
        }

        if (upperSQL.startsWith('ALTER TABLE')) {
            const r = await executeAlterTableCli(sql);
            if (r && r.message) console.log(`✅ ${r.message}`);
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
            const values = parseValues(match[3]);
            if (colNames.length !== values.length) throw new Error('列数与值数不匹配');
            
            const row = {};
            colNames.forEach((col, i) => { row[col] = values[i]; });

            // DEFAULT
            for (const col of (table.columns || [])) {
                if (row[col.name] === undefined && col.default !== undefined && col.default !== null) {
                    row[col.name] = parseValue(String(col.default));
                }
            }

            // AUTO_INCREMENT
            for (const col of (table.columns || [])) {
                if (col && col.autoIncrement && row[col.name] === undefined) {
                    const maxId = (table.data || []).reduce((max, r) => Math.max(max, Number(r[col.name]) || 0), 0);
                    row[col.name] = maxId + 1;
                }
            }

            // NOT NULL
            for (const col of (table.columns || [])) {
                if (col && col.notNull) {
                    const v = row[col.name];
                    if (v === undefined || v === null) throw new Error(`字段 '${col.name}' 不能为空`);
                }
            }

            // 主键唯一
            for (const col of (table.columns || [])) {
                if (col && col.primaryKey && row[col.name] !== undefined) {
                    const exists = (table.data || []).some(r => r && r[col.name] === row[col.name]);
                    if (exists) throw new Error(`主键 '${col.name}' 值 '${row[col.name]}' 已存在`);
                }
            }

            // 外键约束
            if (Array.isArray(table.foreignKeys) && table.foreignKeys.length > 0) {
                for (const fk of table.foreignKeys) {
                    if (!fk || !fk.column || !fk.refTable || !fk.refColumn) continue;
                    const val = row[fk.column];
                    if (val !== null && val !== undefined) {
                        const refTable = databases[currentDatabase].tables[fk.refTable];
                        if (!refTable) throw new Error(`引用的表 '${fk.refTable}' 不存在`);
                        const exists = (refTable.data || []).some(r => r && r[fk.refColumn] == val);
                        if (!exists) throw new Error(`外键约束失败: ${fk.column}=${val} 在 ${fk.refTable}.${fk.refColumn} 中不存在`);
                    }
                }
            }

            table.data.push(row);
            await persistTable(currentDatabase, tableName);
            console.log(`✅ 成功插入 1 行数据`);
            return { success: true };
        }
        
        // SELECT
        if (upperSQL.startsWith('SELECT')) {
            if (!currentDatabase) throw new Error('请先选择数据库');

            if (sql.toUpperCase().includes(' JOIN ')) {
                const r = await executeJoinSelect(sql);
                const columns = r.columns;
                const data = r.data;
                if (!data || data.length === 0) {
                    console.log('\n(空结果集)\n');
                } else {
                    console.log();
                    console.log(columns.join('\t'));
                    console.log(columns.map(() => '--------').join('\t'));
                    data.forEach(row => {
                        console.log(columns.map(c => row[c] ?? 'NULL').join('\t'));
                    });
                    console.log(`\n共 ${data.length} 行\n`);
                }
                return { success: true, data };
            }

            const hasDistinct = /SELECT\s+DISTINCT\s+/i.test(sql);
            const sqlNorm = sql.replace(/SELECT\s+DISTINCT\s+/i, 'SELECT ');

            const match = sqlNorm.match(/SELECT\s+(.*?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+GROUP\s+BY\s+([\w,\s]+))?(?:\s+HAVING\s+(.+?))?(?:\s+ORDER\s+BY\s+([\w.]+)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?)?$/i);
            if (!match) throw new Error('SELECT 语法错误');

            const selectCols = match[1].trim();
            const tableName = match[2];
            const whereClause = match[3];
            const groupBy = match[4];
            const havingClause = match[5];
            const orderBy = match[6];
            const orderDir = match[7] || 'ASC';
            const limit = match[8] ? parseInt(match[8]) : null;
            const offset = match[9] ? parseInt(match[9]) : 0;

            const table = databases[currentDatabase].tables[tableName];
            if (!table) throw new Error(`表 '${tableName}' 不存在`);

            let data = [...(table.data || [])];
            if (whereClause) data = data.filter(row => evaluateWhere(row, whereClause));

            const hasAggregate = /\b(COUNT|SUM|AVG|MAX|MIN)\s*\(/i.test(selectCols);
            if (hasAggregate || groupBy) {
                const r = executeAggregateSelect(selectCols, data, groupBy, havingClause, orderBy, orderDir, limit);
                const columns = r.columns;
                const out = r.data;
                if (!out || out.length === 0) {
                    console.log('\n(空结果集)\n');
                } else {
                    console.log();
                    console.log(columns.join('\t'));
                    console.log(columns.map(() => '--------').join('\t'));
                    out.forEach(row => {
                        console.log(columns.map(c => row[c] ?? 'NULL').join('\t'));
                    });
                    console.log(`\n共 ${out.length} 行\n`);
                }
                return { success: true, data: out };
            }

            if (orderBy) {
                const col = orderBy.includes('.') ? orderBy.split('.')[1] : orderBy;
                data.sort((a, b) => {
                    const va = a[col], vb = b[col];
                    if (va < vb) return orderDir === 'ASC' ? -1 : 1;
                    if (va > vb) return orderDir === 'ASC' ? 1 : -1;
                    return 0;
                });
            }

            if (limit) {
                data = data.slice(offset, offset + limit);
            } else if (offset) {
                data = data.slice(offset);
            }

            let columns = selectCols === '*' ? (table.columns || []).map(c => c.name) : selectCols.split(',').map(c => c.trim().split('.').pop().replace(/^DISTINCT\s+/i, ''));
            let projectedData = data.map(row => {
                const newRow = {};
                for (const col of columns) {
                    newRow[col] = row[col] !== undefined ? row[col] : null;
                }
                return newRow;
            });

            if (hasDistinct) {
                const seen = new Set();
                projectedData = projectedData.filter(row => {
                    const key = JSON.stringify(row);
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
            }

            if (!projectedData || projectedData.length === 0) {
                console.log('\n(空结果集)\n');
            } else {
                console.log();
                console.log(columns.join('\t'));
                console.log(columns.map(() => '--------').join('\t'));
                projectedData.forEach(row => {
                    console.log(columns.map(c => row[c] ?? 'NULL').join('\t'));
                });
                console.log(`\n共 ${projectedData.length} 行\n`);
            }
            return { success: true, data: projectedData };
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
                if (whereClause) matches = evaluateWhere(row, whereClause);
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
            await persistTable(currentDatabase, tableName);
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

            const tableDataArray = table.data || [];
            const toDelete = whereClause ? tableDataArray.filter(row => evaluateWhere(row, whereClause)) : [...tableDataArray];

            const modifiedTables = new Set();
            const pkCol = (table.columns || []).find(c => c && c.primaryKey);
            if (pkCol && toDelete.length > 0) {
                const rootKeys = new Set(toDelete.map(r => r[pkCol.name]).filter(v => v !== null && v !== undefined).map(v => String(v)));
                const queue = [];
                if (rootKeys.size > 0) {
                    queue.push({ refTableName: tableName, refColumn: pkCol.name, deletingKeys: rootKeys });
                }

                const resolveOnDelete = (fk) => {
                    const v = fk && fk.onDelete ? String(fk.onDelete).toUpperCase() : 'RESTRICT';
                    return v;
                };

                while (queue.length > 0) {
                    const { refTableName, refColumn, deletingKeys } = queue.shift();
                    const refTableLower = String(refTableName).toLowerCase();
                    const refColumnLower = String(refColumn).toLowerCase();

                    for (const [otherTableName, otherTable] of Object.entries(databases[currentDatabase].tables || {})) {
                        if (otherTableName === refTableName) continue;
                        const fks = otherTable.foreignKeys || [];
                        for (const fk of fks) {
                            if (!fk || !fk.refTable || !fk.refColumn || !fk.column) continue;
                            if (String(fk.refTable).toLowerCase() !== refTableLower || String(fk.refColumn).toLowerCase() !== refColumnLower) continue;

                            const otherData = otherTable.data || [];
                            const affected = otherData.filter(r => {
                                const v = r ? r[fk.column] : undefined;
                                if (v === null || v === undefined) return false;
                                return deletingKeys.has(String(v));
                            });
                            if (affected.length === 0) continue;

                            const onDelete = resolveOnDelete(fk);
                            if (onDelete === 'RESTRICT' || onDelete === 'NO ACTION') {
                                throw new Error(`外键约束失败: ${otherTableName}.${fk.column} 引用了要删除的 ${refTableName}.${refColumn}`);
                            }

                            if (onDelete === 'SET NULL') {
                                const fkColMeta = (otherTable.columns || []).find(c => c && c.name && c.name.toLowerCase() === fk.column.toLowerCase());
                                if (fkColMeta && fkColMeta.notNull) {
                                    throw new Error(`无法执行 SET NULL：外键列 ${otherTableName}.${fk.column} 为 NOT NULL`);
                                }
                                for (const r of affected) {
                                    r[fk.column] = null;
                                }
                                modifiedTables.add(otherTableName);
                                continue;
                            }

                            if (onDelete === 'CASCADE') {
                                const childPkCol = (otherTable.columns || []).find(c => c && c.primaryKey);
                                const childKeys = new Set();
                                if (childPkCol) {
                                    for (const r of affected) {
                                        const v = r[childPkCol.name];
                                        if (v !== null && v !== undefined) childKeys.add(String(v));
                                    }
                                }

                                const remaining = otherData.filter(r => {
                                    const v = r ? r[fk.column] : undefined;
                                    if (v === null || v === undefined) return true;
                                    return !deletingKeys.has(String(v));
                                });
                                otherData.length = 0;
                                otherData.push(...remaining);
                                modifiedTables.add(otherTableName);

                                if (childPkCol && childKeys.size > 0) {
                                    queue.push({ refTableName: otherTableName, refColumn: childPkCol.name, deletingKeys: childKeys });
                                }
                                continue;
                            }

                            throw new Error(`不支持的 ON DELETE 动作: ${onDelete}`);
                        }
                    }
                }
            }

            const originalLength = tableDataArray.length;
            if (whereClause) {
                const remaining = tableDataArray.filter(row => !evaluateWhere(row, whereClause));
                tableDataArray.length = 0;
                tableDataArray.push(...remaining);
            } else {
                tableDataArray.length = 0;
            }

            const deletedCount = originalLength - tableDataArray.length;
            if (deletedCount > 0) {
                modifiedTables.add(tableName);
            }

            if (inTransaction) {
                for (const t of modifiedTables) {
                    transactionModifiedTables.add(`${currentDatabase}.${t}`);
                }
            } else {
                for (const t of modifiedTables) {
                    await persistTable(currentDatabase, t);
                }
            }

            console.log(`✅ 成功删除 ${deletedCount} 行数据`);
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
    
    rl.on('line', async (line) => {
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
        const statements = splitStatements(input).filter(s => s.trim());
        for (const stmt of statements) {
            await executeSQL(stmt.trim());
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
    const options = { database: null, execute: null, backup: null, restore: null, clearAll: false };
    
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-d' || args[i] === '--database') {
            options.database = args[++i];
        } else if (args[i] === '-e' || args[i] === '--execute') {
            options.execute = args[++i];
        } else if (args[i] === '--backup') {
            options.backup = args[++i];
        } else if (args[i] === '--restore') {
            options.restore = args[++i];
        } else if (args[i] === '--clear-all') {
            options.clearAll = true;
        } else if (args[i] === '-h' || args[i] === '--help') {
            console.log('用法: node cli.js [选项]');
            console.log('选项:');
            console.log('  -d, --database <name>  指定数据库');
            console.log('  -e, --execute <sql>    执行SQL语句');
            console.log('  --backup <file>        导出备份(JSON)，配合 -d 可只备份该数据库');
            console.log('  --restore <file>       从备份(JSON)恢复 (merge + conflict=rename)');
            console.log('  --clear-all            清空所有数据库/表数据与锁文件');
            console.log('  -h, --help             显示帮助');
            process.exit(0);
        }
    }
    return options;
}

// 主函数
function main() {
    const options = parseArgs();

    if (options.clearAll) {
        try {
            clearAllDataFiles();
            console.log('✅ 已清空所有数据');
            process.exit(0);
        } catch (e) {
            console.error(`❌ 错误: ${e.message}`);
            process.exit(1);
        }
    }

    if (options.restore) {
        try {
            const text = fs.readFileSync(options.restore, 'utf8');
            const snapshot = JSON.parse(text || '{}');
            const r = restoreFromSnapshot(snapshot);
            console.log('✅ 恢复完成');
            if (r && r.renamedDatabases && Object.keys(r.renamedDatabases).length > 0) {
                console.log('重命名数据库:', JSON.stringify(r.renamedDatabases));
            }
            if (r && r.renamedTables && Object.keys(r.renamedTables).length > 0) {
                console.log('重命名表:', JSON.stringify(r.renamedTables));
            }
            process.exit(0);
        } catch (e) {
            console.error(`❌ 错误: ${e.message}`);
            process.exit(1);
        }
    }

    if (options.backup) {
        try {
            const snapshot = buildBackupSnapshot({ database: options.database || null });
            const outText = JSON.stringify(snapshot, null, 2);
            if (options.backup === '-') {
                process.stdout.write(outText);
            } else {
                fs.writeFileSync(options.backup, outText, 'utf8');
                console.log(`✅ 备份已导出: ${options.backup}`);
            }
            process.exit(0);
        } catch (e) {
            console.error(`❌ 错误: ${e.message}`);
            process.exit(1);
        }
    }

    loadData();
    
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
        (async () => {
            const statements = splitStatements(options.execute).filter(s => s.trim());
            for (const stmt of statements) {
                const r = await executeSQL(stmt.trim());
                if (r && r.success === false) {
                    process.exitCode = 1;
                    break;
                }
            }
        })().then(() => process.exit(process.exitCode || 0));
        return;
    }
    
    // 否则进入交互模式
    startInteractive();
}

main();
