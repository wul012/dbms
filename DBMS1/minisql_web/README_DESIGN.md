# MiniSQL 课程设计说明（答辩级别）

> 本文档用于答辩/验收，系统性说明本课程设计在 **架构、数据组织、SQL 执行、索引、并发控制、事务、备份恢复、可视化** 等方面的设计与实现。本文内容与代码保持一致，可直接对照：
>
>- Web 前端核心逻辑：`minisql_web/app.js`
>- Node.js 后端服务：`minisql_web/server.js`
>- 数据文件目录：`minisql_web/data/`

---

## 1. 总体架构概览

本项目采用 **“浏览器端执行 SQL + Node.js 负责文件读写/并发控制”** 的轻量 DBMS 架构。

### 1.1 模块划分

1) **Web UI（前端）**：

- SQL 输入、执行历史、结果展示
- SQL 解析与执行（DDL/DML/查询/聚合/JOIN/索引/外键/事务）
- 表数据按需加载（Lazy Load）
- 写入时通过 API 落盘（含版本检查）

对应代码：`minisql_web/app.js`

2) **Web Server（后端）**：

- 提供 REST API：读取元数据、按需读取表数据、保存表数据、保存元数据
- 表级锁（`.lock` 文件）
- 乐观锁（`version` 版本号检查，冲突返回 409）
- 备份/恢复（支持合并 + 冲突重命名）

对应代码：`minisql_web/server.js`

3) **CLI（命令行）**：

- 与 Web 共用同一份 `data/` 数据目录
- 适合脚本化/批处理

对应代码：`minisql_web/cli.js`

### 1.2 数据流（关键路径）

#### A. 启动加载（懒加载元数据）

1) 浏览器打开页面 -> `app.js` 执行 `init()`
2) `loadFromLocalFile()` 调用 `GET /api/databases` 获取所有数据库的元数据与表版本号
3) 前端仅缓存“元数据（表结构/外键/索引定义）”，表数据并不一次性加载

代码入口：`app.js`

```js
async function init() {
    await loadFromLocalFile();
    renderDatabaseList();
    renderTableList();
    updateStorageInfo();
    // ...
}

async function loadFromLocalFile() {
    useTableStorage = true;
    const response = await fetch('/api/databases?t=' + Date.now());
    // 成功则进入“懒加载模式”
}
```

后端实现：`server.js` `/api/databases`

```js
if (req.method === 'GET' && req.url.split('?')[0] === '/api/databases') {
    // 读取所有 *_metadata.json
    // 同时遍历表文件读取每个表的 version
}
```

#### B. 执行 SQL（以 SELECT 为例）

1) 用户点击“执行” -> `executeSQL()`
2) 拆分多条语句 -> 逐条 `parseSingleSQL()` 分派到具体执行器
3) `SELECT` -> `executeSelect()`
4) 如果是单表查询，且 `WHERE` 属于简单等值/IN，会触发索引候选集过滤（优化点）

---

## 2. 数据组织与持久化格式（分库分表 JSON）

### 2.1 文件布局

```text
minisql_web/data/
├── <db>_metadata.json           # 数据库元数据（表结构/外键/索引）
├── <db>_<table>.json            # 表数据与版本号（data + version）
└── locks/
    └── <db>_<table>.lock        # 表级锁文件
```

这种布局的优势：

- 元数据与表数据分离：`SHOW TABLES/DESC/SHOW INDEXES` 只需读元数据
- 表数据按需加载：`/api/table-data/<db>/<table>`
- 并发控制粒度更细：锁住单表文件，而非整库

### 2.2 元数据格式（metadata）

文件：`data/<db>_metadata.json`

核心结构：

- `tables.<tableName>.columns`：列定义（类型/主键/自增/默认值等）
- `tables.<tableName>.foreignKeys`：外键定义（引用表/列及 onDelete/onUpdate）
- `tables.<tableName>.indexes`：索引定义与索引数据（`indexes.data`）

示例（片段）：

```json
{
  "metadata": {
    "tables": {
      "users": {
        "columns": [
          {"name": "id", "type": "INT", "primaryKey": true}
        ],
        "foreignKeys": [],
        "indexes": {
          "PRIMARY": {"columns": ["id"], "unique": true, "data": {"1": [0]}}
        }
      }
    }
  }
}
```

### 2.3 表数据格式（table data + version）

文件：`data/<db>_<table>.json`

```json
{
  "version": "2026-01-15T09:43:59.601Z",
  "data": [
    {"id": 1, "name": "Alice", "dept": "R&D", "age": 27}
  ]
}
```

说明：

- `version` 是乐观锁的关键：用于写入冲突检测
- `data` 是行数组（简化实现）

---

## 3. SQL 执行引擎（Web 端）

### 3.1 多语句执行与分派

Web 端支持 `;` 分隔多条语句：

- `executeSQL()`：拆分语句、识别读写类型、在表级存储模式下对读操作做“读前版本检查”
- `parseSingleSQL()`：按语句类型分派到各执行器

关键点：

- 读操作与写操作在“表级存储模式”下策略不同：
  - 读：可做版本检查（避免读到过旧缓存）
  - 写：写入时必须携带 `expectedVersion` 给后端做乐观锁检查

`app.js` 相关函数：

- `executeSQL`
- `parseSingleSQL`
- `isReadOnlySQL`
- `ensureReadFreshTableLevel`

### 3.2 WHERE 条件解析与求值

Web 端实现了 `evaluateWhere(row, whereClause)` 与 `evaluateCondition(row, condition)` 来支持常见条件：

- 比较：`= != <> < > <= >=`
- 集合：`IN / NOT IN`
- 范围：`BETWEEN ... AND ...`
- 模糊：`LIKE`
- 空值：`IS NULL / IS NOT NULL`
- 逻辑：`AND / OR`（含括号层级处理）

实现特点：

- 为了正确拆分 `AND/OR`，内部实现了“顶层 split（括号/引号感知）”
- `BETWEEN a AND b` 中间的 `AND` 不能被误拆分

---

## 4. 索引设计（结构、维护、约束）

### 4.1 索引定义与存放位置

索引属于“元数据的一部分”，定义与内容都存放在：

- `data/<db>_metadata.json` 的 `tables.<table>.indexes`

索引对象字段（概念）：

- `columns`: 索引列（支持单列/多列）
- `unique`: 是否唯一索引
- `data`: key→rowIndex[] 的映射（用于模拟索引）

### 4.2 索引数据结构：key → 行号列表

`indexes.data` 的核心思想：

- 把行数组视作“堆表”
- 索引 `data` 保存“索引键到行号”的映射

key 编码规则：

- 单列：`String(value)`
- 多列：`String(v1) + '|' + String(v2) + ...`

Web 端重建索引的真实实现（`app.js`）：

```js
function rebuildIndexDataForTable(table, dataArray) {
    if (!table || !table.indexes) return;
    const arr = Array.isArray(dataArray) ? dataArray : [];
    for (const idx of Object.values(table.indexes)) {
        if (!idx || !Array.isArray(idx.columns) || idx.columns.length === 0) continue;
        const indexData = {};
        arr.forEach((row, i) => {
            const key = idx.columns.map(c => {
                const v = getRowValueCaseInsensitive(row, c);
                return v === undefined || v === null ? '' : String(v);
            }).join('|');
            if (!indexData[key]) indexData[key] = [];
            indexData[key].push(i);
        });
        idx.data = indexData;
    }
}
```

### 4.3 唯一性约束（主键 + 唯一索引）

课程设计实现中：

- 主键列天然唯一（`PRIMARY`）
- 唯一索引：
  - **NULL 不参与唯一性检查**（与常见数据库行为一致）

Web 端约束校验实现（`app.js`）：

- `ensurePrimaryKeyUnique(table, dataArray)`
- `ensureUniqueIndexes(table, dataArray)`

其核心策略：

- 对每个唯一索引，扫描全表构造 `seen` 集合
- 若任一行在索引列上含 `NULL/undefined`，则跳过该行

---

## 5. 索引加速查询（本次优化点，答辩重点）

### 5.1 目标与约束

目标：

- 在 Web 端执行 `SELECT` 时，若 `WHERE` 是简单模式，则先用索引缩小候选行集合，提高性能

约束（当前版本明确不做/不保证）：

- 不做范围索引扫描（如 `age >= 30`）
- 不做多条件 AND/OR 的索引合并
- 不做 JOIN 的索引优化

### 5.2 简单 WHERE 识别

仅识别两类：

- `WHERE col = value`
- `WHERE col IN (v1, v2, ...)`

对应实现：`parseSimpleWhereForIndex(whereClause)`（`app.js`）

```js
function parseSimpleWhereForIndex(whereClause) {
    if (!whereClause) return null;
    const s = String(whereClause).trim();
    if (!s) return null;
    if (/\bAND\b/i.test(s) || /\bOR\b/i.test(s)) return null;

    let m;
    m = s.match(/^\s*([\w.]+)\s*=\s*(.+?)\s*$/);
    if (m) {
        const col = m[1].split('.').pop();
        const v = parseValue(String(m[2]).trim());
        if (v === null || v === undefined) return null;
        return { column: col, values: [v] };
    }

    m = s.match(/^\s*([\w.]+)\s+IN\s*\(([^)]+)\)\s*$/i);
    if (m) {
        const col = m[1].split('.').pop();
        const values = parseValues(String(m[2]).trim()).filter(v => v !== null && v !== undefined);
        if (values.length === 0) return null;
        return { column: col, values };
    }

    return null;
}
```

注意：该函数明确拒绝包含 `AND/OR` 的复杂条件，确保实现简单且可控。

### 5.3 候选集生成（索引命中）

候选集生成流程：

1) 从 `table.indexes` 里找到与目标列匹配的单列索引
2) 优先选择 `unique=true` 的索引（若存在）
3) 对于 `=`：取一个 key 的 rowIndex 列表
4) 对于 `IN`：合并多个 key 的 rowIndex 列表，并去重
5) 把 rowIndex 映射回真实行对象，形成候选集 `rows`

对应实现：`tryApplyIndexWhere(table, dataArray, whereClause)`（`app.js`）

其结果结构：

- `{ indexName, rows }`

### 5.4 与完整条件求值的配合

即使索引命中，也仍会对候选行执行 `evaluateWhere`（保证语义正确）：

```js
if (whereClause) {
    const indexHit = tryApplyIndexWhere(table, tableDataArray, whereClause);
    if (indexHit && indexHit.indexName) {
        usedIndexName = indexHit.indexName;
        data = (indexHit.rows || []).filter(row => evaluateWhere(row, whereClause));
    } else {
        data = data.filter(row => evaluateWhere(row, whereClause));
    }
}
```

此外，结果 message 会追加 `使用索引: <indexName>`，便于答辩演示“优化确实发生”。

### 5.5 idx_demo 演示脚本

索引加速查询的完整可执行 SQL 已写入 `README.md` 的 `idx_demo` 部分。答辩时建议演示：

- `dept = 'HR'`（命中索引）
- `dept IN ('R&D','Sales')`（命中索引）
- `age >= 30`（不提示使用索引，回退普通过滤）

---

## 6. 懒加载（按需加载表数据）

### 6.1 为什么要懒加载

如果一次性把所有表数据加载到浏览器：

- 首屏慢
- 内存占用大
- 多表并发读写时更容易出现缓存过期

因此实现策略：

- 启动只加载元数据（`/api/databases`）
- 用到某张表时才 `GET /api/table-data/<db>/<table>`

`app.js` 关键接口：

- `getTableData(dbName, tableName)`：若缓存不存在则触发 `loadTableData`

后端：`server.js` 提供 `/api/table-data/:db/:table`

---

## 7. 并发控制（表级锁 + 乐观锁）

课程设计的一个答辩重点是“多进程/多页面并发写入如何避免相互覆盖”。本项目采用两层机制：

1) **表级锁（互斥）**：短时间内只允许一个写者写表文件
2) **乐观锁（版本号）**：避免 A 读旧版本、B 先写、A 后写覆盖 B 的结果

### 7.1 表级锁（`.lock` 文件）

实现文件：`server.js`

```js
function acquireTableLock(dbName, tableName, timeout = 3000) {
    const lockFile = path.join(LOCK_DIR, `${dbName}_${tableName}.lock`);
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            fs.writeFileSync(lockFile, process.pid.toString(), { flag: 'wx' });
            return true;
        } catch (e) {
            if (e.code === 'EEXIST') {
                // 锁超时清理 + 自旋等待
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
```

特点：

- 通过 `flag: 'wx'` 实现“创建文件即加锁”
- 通过 mtime 判断锁是否超时（>5s 则清理）

### 7.2 乐观锁（version 检查，冲突返回 409）

写入 API：`POST /api/save-table`

`server.js` 中会比较客户端 `expectedVersion` 与服务器 `existing.version`：

```js
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
        return;
    }
}
```

前端（`app.js`）在保存时会处理 409：

- 在 UI 中提示“数据冲突，请刷新”
- 避免静默覆盖

---

## 8. 事务支持（BEGIN/COMMIT/ROLLBACK）

### 8.1 设计目标

- 提供最小可用的事务语义用于课程设计演示
- 事务期间的更改暂存在内存
- COMMIT 统一落盘；ROLLBACK 通过快照回滚

### 8.2 实现方式：快照 + 变更集

`app.js` 的核心状态：

- `inTransaction`
- `transactionSnapshot`：BEGIN 时对 `databases` 深拷贝
- `transactionSnapshotTableData / transactionSnapshotTableVersions`
- `transactionModifiedTables / transactionModifiedDatabases`

BEGIN：

```js
function executeBegin() {
    inTransaction = true;
    transactionSnapshot = JSON.parse(JSON.stringify(databases));
    transactionSnapshotTableData = JSON.parse(JSON.stringify(tableData));
    transactionSnapshotTableVersions = JSON.parse(JSON.stringify(tableVersions));
    transactionModifiedTables.clear();
    transactionModifiedDatabases.clear();
}
```

COMMIT：

- 把变更过的表逐个 `saveTableData` 写入
- 把变更过的元数据 `saveMetadata`

ROLLBACK：

- 直接恢复快照变量

### 8.3 事务与索引

在表级存储模式下：

- 事务期间仍可在内存中维护索引结构
- 直到 COMMIT 才会把元数据（含索引 data）落盘

---

## 9. 备份/恢复（快照 + 冲突重命名）

### 9.1 备份导出

后端路由：`GET /api/backup`

支持：

- `scope=all`：导出所有库
- `scope=db&database=<db>`：导出指定库

输出是一个 JSON 快照，包含：

- `databases`：库元数据
- `tableData`：每张表的数据与版本
- `tableVersions`：每张表的版本

### 9.2 恢复导入（合并 + 重名自动改名）

后端路由：`POST /api/restore?mode=merge&conflict=rename`

策略：

- 如果导入库名与现有库冲突：自动改为 `<db>_import1/_import2...`
- 表名同理
- 外键引用表名也会同步更新

在答辩中可强调：

- 这是“数据工程能力”的体现：处理冲突与引用一致性

---

## 10. 可视化与交互细节（答辩加分项）

### 10.1 ER 图

- Web 工具栏提供“ER 图”入口
- 自动识别主键/外键
- SVG 方式绘制连接线

### 10.2 查询结果区

- 表格结果支持 CSV 导出
- 单表 SELECT 且包含主键列时启用“行删除”按钮（便于演示 DML）

### 10.3 执行历史

- 保存最近 N 条 SQL 到 localStorage
- 点击历史项可回填编辑器

---

## 11. 边界条件与限制说明（答辩必须讲清楚）

- **索引加速查询**：仅优化“单表 + 简单 WHERE（= / IN）”，复杂条件回退普通过滤
- **索引结构**：`indexes.data` 是课程设计中的“模拟索引结构”，用 key→rowIndex[] 表示
- **类型系统**：字段类型主要用于展示与元数据保存，未实现严格的类型强制与转换规则
- **事务隔离级别**：未实现 MVCC/锁升级等复杂隔离，仅提供快照回滚与延迟提交
- **JOIN 优化**：JOIN 为嵌套循环实现，未做哈希 JOIN/索引 JOIN

---

## 12. 推荐答辩演示顺序（可直接照着讲）

1) 启动服务与界面概览（Web/CLI/数据目录）
2) 展示分库分表文件结构（`data/` 下多个 json）
3) `idx_demo`：创建索引 -> `WHERE =` 与 `WHERE IN` -> 结果提示“使用索引”
4) 并发控制：打开两个页面对同一表写入，触发 409 冲突提示（讲乐观锁）
5) 事务：BEGIN -> UPDATE -> ROLLBACK（讲快照与延迟提交）
6) 备份/恢复：导出 -> 导入合并 -> 冲突重命名（讲健壮性）
7) ER 图：展示外键连线
