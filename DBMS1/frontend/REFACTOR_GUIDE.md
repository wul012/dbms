# 重构完成指南

## 已完成的修改

### 1. 数据结构变更 (app.js)
- ✅ 添加了 `tableData` 和 `tableVersions` 全局变量
- ✅ 修改了 `loadFromLocalFile()` - 只加载元数据
- ✅ 添加了 `loadTableData()` 和 `getTableData()` - 按需加载表数据
- ✅ 添加了 `saveTableData()` - 表级保存
- ✅ 添加了 `saveMetadata()` - 元数据保存
- ✅ 修改了 `renderTableList()` - 使用 tableData
- ✅ 修改了 `updateStorageInfo()` - 计算已加载数据
- ✅ 修改了 `executeInsert()` - 异步加载表数据

### 2. 服务器端 (server_new.js)
- ✅ 完全重写，支持：
  - 表级文件存储 (`dbName_tableName.json`)
  - 元数据文件 (`dbName_metadata.json`)
  - 表级版本号
  - 表级锁

### 3. 数据迁移 (migrate_data.js)
- ✅ 自动转换旧数据格式到新格式

## 需要手动完成的修改

### app.js 中需要改为异步的函数

以下函数需要改为 `async function` 并使用 `await getTableData()`:

```javascript
// 1. executeSelect - 第1463行
async function executeSelect(sql) {
    // ...
    const data = await getTableData(currentDatabase, tableName);  // 替换 table.data
    // ...
}

// 2. executeUpdate - 第1836行
async function executeUpdate(sql) {
    // ...
    const data = await getTableData(currentDatabase, tableName);
    for (const row of data) {  // 替换 table.data
        // ...
    }
}

// 3. executeDelete - 第1861行
async function executeDelete(sql) {
    // ...
    const data = await getTableData(currentDatabase, tableName);
    const toDelete = whereClause ? data.filter(...) : [...data];  // 替换 table.data
    // ...
    const originalLength = data.length;
    if (whereClause) {
        const newData = data.filter(row => !evaluateWhere(row, whereClause));
        tableData[`${currentDatabase}.${tableName}`].data = newData;
    } else {
        tableData[`${currentDatabase}.${tableName}`].data = [];
    }
}

// 4. executeTruncate - 第2011行
async function executeTruncate(sql) {
    // ...
    const data = await getTableData(currentDatabase, tableName);
    const count = data.length;
    tableData[`${currentDatabase}.${tableName}`].data = [];
}

// 5. executeCreateIndex - 第2045行
async function executeCreateIndex(sql) {
    // ...
    const data = await getTableData(currentDatabase, tableName);
    data.forEach((row, idx) => {  // 替换 table.data
        // ...
    });
}

// 6. executeAlterTable - 第1923行 (外键验证部分)
async function executeAlterTable(sql) {
    // ...
    const data = await getTableData(currentDatabase, tableName);
    const refData = await getTableData(currentDatabase, refTable);
    // 验证外键
    for (const row of data) {
        // ...
    }
}

// 7. executeAggregateSelect - 聚合查询
async function executeAggregateSelect(selectCols, data, ...) {
    // 这个函数接收 data 参数，不需要修改
    // 但调用它的 executeSelect 需要传入 await getTableData() 的结果
}

// 8. executeJoinSelect - JOIN查询
async function executeJoinSelect(sql) {
    // ...
    const data1 = await getTableData(currentDatabase, table1Name);
    const data2 = await getTableData(currentDatabase, table2Name);
    for (const row1 of data1) {
        for (const row2 of data2) {
            // ...
        }
    }
}

// 9. showERDiagram - ER图显示
async function showERDiagram() {
    // ...
    // 修改生成ER图的代码，不显示行数或显示 "?" 
    // 因为元数据中没有 data.length
}
```

### executeSQL 函数修改

```javascript
async function executeSQL() {
    // ...
    
    // 判断需要保存的表
    const modifiedTables = new Set();
    
    for (const stmt of statements) {
        const result = await parseSingleSQL(stmt);  // 已经是 async
        
        // 记录修改的表
        if (upperStmt.startsWith('INSERT') || upperStmt.startsWith('UPDATE') || 
            upperStmt.startsWith('DELETE') || upperStmt.startsWith('TRUNCATE')) {
            const tableMatch = stmt.match(/(?:INTO|UPDATE|FROM)\s+(\w+)/i);
            if (tableMatch) {
                modifiedTables.add(tableMatch[1]);
            }
        }
    }
    
    // 保存修改的表
    if (!inTransaction && modifiedTables.size > 0) {
        for (const tableName of modifiedTables) {
            await saveTableData(currentDatabase, tableName);
        }
    }
    
    // 如果修改了表结构，保存元数据
    if (hasStructureChange) {
        await saveMetadata(currentDatabase);
    }
}
```

### 事务处理修改

```javascript
async function executeBegin() {
    if (inTransaction) throw new Error('事务已经开始');
    inTransaction = true;
    // 快照需要包含 tableData
    transactionSnapshot = {
        databases: JSON.parse(JSON.stringify(databases)),
        tableData: JSON.parse(JSON.stringify(tableData))
    };
    updateTransactionStatus();
    return { type: 'message', message: '🔒 事务已开始', status: 'info' };
}

async function executeCommit() {
    if (!inTransaction) throw new Error('没有活动的事务');
    
    // 保存所有修改的表
    for (const tableKey in tableData) {
        const [dbName, tableName] = tableKey.split('.');
        await saveTableData(dbName, tableName, false);
    }
    
    inTransaction = false;
    transactionSnapshot = null;
    updateTransactionStatus();
    return { type: 'message', message: '✅ 事务已提交', status: 'success' };
}

async function executeRollback() {
    if (!inTransaction) throw new Error('没有活动的事务');
    databases = transactionSnapshot.databases;
    tableData = transactionSnapshot.tableData;
    inTransaction = false;
    transactionSnapshot = null;
    updateTransactionStatus();
    return { type: 'message', message: '⏪ 事务已回滚', status: 'warning' };
}
```

## 使用步骤

### 1. 迁移数据
```bash
node migrate_data.js
```

### 2. 启动新服务器
```bash
node server_new.js
```

### 3. 完成 app.js 修改
按照上面的指南修改所有需要异步的函数

### 4. 测试功能
- 创建数据库
- 创建表
- 插入数据（检查是否按需加载）
- 查询数据
- 更新/删除数据
- 测试并发冲突（开两个浏览器窗口）

## 验证要点

1. ✅ 页面加载时只加载元数据，不加载表数据
2. ✅ 第一次查询表时才加载数据
3. ✅ 表列表显示行数（已加载的显示数字，未加载显示 "?"）
4. ✅ 修改不同表不会冲突
5. ✅ 修改同一表会检测冲突
6. ✅ data 目录下有多个文件：
   - `dbName_metadata.json` (元数据)
   - `dbName_tableName.json` (表数据)

## 回滚方案

如果出现问题，可以：
1. 停止 server_new.js
2. 启动原来的 server.js
3. 恢复 `minisql_data_backup.json` 为 `minisql_data.json`
