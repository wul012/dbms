# MiniSQL 项目超详细说明（detail.md）

> 目标：把 `minisql_web` 这个项目“从里到外”讲清楚，覆盖架构、数据结构、文件格式、SQL 支持范围、执行流程、索引与约束、并发控制、事务、备份恢复、UI 交互与边界限制等全部细节。
>
> 说明：本文档篇幅很大，**将分批写入**，最终目标 **1000 行以上**。每一批都只做“追加”，不重排既有内容，方便你审阅与版本对比。
>
> 代码对照（重要）：
>
>- 前端（浏览器端）：`minisql_web/app.js`
>- 后端（Node.js）：`minisql_web/server.js`
>- 命令行（Node.js）：`minisql_web/cli.js`
>- 页面结构：`minisql_web/index.html`
>- 样式：`minisql_web/styles.css`
>- 数据迁移脚本：`minisql_web/migrate_data.js`
>- 数据目录：`minisql_web/data/`

---

## 目录（持续扩展）

- 1. 项目定位与总体架构
- 2. 目录结构与各文件职责
- 3. 数据持久化：分库分表 JSON 格式
- 4. 后端 server.js：静态资源 + REST API + 并发控制
- 5. 前端 index.html：UI 结构与交互入口
- 6. 前端 app.js：全局状态、懒加载、版本控制与落盘
- 7. 前端 app.js：UI 渲染（库/表列表、结果区、弹窗）
- 8. 前端 app.js：SQL 执行主流程（executeSQL/parseSingleSQL）
- 9. 前端 app.js：DDL 详解（库/表/结构）
- 10. 前端 app.js：DML 详解（INSERT/UPDATE/DELETE/TRUNCATE）
- 11. 前端 app.js：SELECT 详解（DISTINCT/WHERE/ORDER/LIMIT/聚合/GROUP BY/HAVING/JOIN）
- 12. 前端 app.js：WHERE 解析与求值引擎（evaluateWhere/evaluateCondition）
- 13. 索引系统：结构、维护、唯一性约束、索引加速查询
- 14. 外键系统：定义、校验、删除动作（RESTRICT/SET NULL/CASCADE）
- 15. 事务系统：BEGIN/COMMIT/ROLLBACK 的快照与落盘策略
- 16. 备份/恢复：格式、导出、合并导入、冲突重命名与引用更新
- 17. CLI：与 Web 共享数据目录的实现差异
- 18. 可视化能力：ER 图、CSV 导出、行删除
- 19. 关键边界、限制与可改进点（答辩必讲）
- 附录：API 清单、数据文件示例、常见问题

---

## 1. 项目定位与总体架构

### 1.1 课程设计目标

该项目是一个“课程设计级别”的轻量 DBMS（数据库管理系统）实现，核心目标不是替代真实数据库，而是把数据库课程中常见的概念与机制做成“可运行、可演示、可解释”的系统：

- DDL：创建/删除数据库、创建/删除/重命名表、查看表结构、ALTER TABLE
- DML：INSERT/SELECT/UPDATE/DELETE/TRUNCATE
- 查询能力：WHERE、LIKE、BETWEEN、IN、ORDER BY、LIMIT/OFFSET、聚合函数、GROUP BY/HAVING、JOIN
- 完整性约束：主键、外键、唯一索引
- 索引：创建/删除/展示索引，维护索引结构，并进行“简单索引加速查询”演示
- 并发控制：表级锁 + 乐观锁（版本号），避免多进程/多窗口写入覆盖
- 事务：BEGIN/COMMIT/ROLLBACK（快照 + 延迟提交）
- 备份/恢复：导出快照、合并导入，冲突自动重命名并维护外键引用一致性
- Web UI：可视化管理数据库/表/外键，ER 图展示

### 1.2 “浏览器端执行 SQL + 服务端负责落盘”的设计取舍

本项目采用一个很适合课程设计与演示的架构：

- **浏览器端（app.js）** 完成“绝大多数数据库语义”：SQL 解析、执行、约束校验、索引维护、事务快照、结果渲染。
- **服务端（server.js）** 尽量保持“薄”：
  - 负责静态文件服务（`index.html/styles.css/app.js`）
  - 提供数据 API（读元数据/读表数据/写表数据/写元数据/备份/恢复）
  - 负责文件锁与版本冲突检测（并发控制关键部分）

这样做的好处：

- 代码集中在 JS，容易阅读与调试
- 便于在答辩中直接展示“SQL -> 解析 -> 执行 -> 文件落盘”的完整链路
- 便于模拟数据库内部结构（例如索引结构存在 metadata 中）

代价与限制：

- 真正的 DBMS 通常在服务端实现执行引擎；本项目为了简化把执行逻辑放在前端
- 性能不会像真正数据库（尤其 JOIN/聚合/过滤都是 JS 循环）

---

## 2. 目录结构与各文件职责

`minisql_web/` 的核心文件如下：

- `index.html`
  - 页面结构：工具栏、侧栏（库/表列表）、SQL 编辑器、执行结果区、状态栏、多个弹窗（建库/建表/编辑表/ER 图）
- `styles.css`
  - UI 样式：布局、按钮、表格、弹窗、历史记录等
- `app.js`
  - 前端核心：SQL 执行引擎、数据缓存与懒加载、事务、索引、外键、渲染逻辑、导入导出/ER 图/行删除
- `server.js`
  - 后端核心：静态服务 + REST API + 表级锁 + 版本号冲突检测 + 备份/恢复
- `cli.js`
  - 命令行工具：与 Web 共用同一 data 目录；实现类似的 SQL 解析与执行、事务、备份恢复
- `migrate_data.js`
  - 将旧版单文件数据 `minisql_data.json` 拆分到分库分表格式
- `data/`
  - 分库分表数据文件 + locks 目录

后续章节将对每个文件进行“逐模块逐函数”解释。

---

## 3. 数据持久化：分库分表 JSON 格式

### 3.1 数据目录结构

`data/` 采用“三类文件”组合：

1) `data/<db>_metadata.json`

- 保存数据库元数据（schema）：
  - 表结构（columns）
  - 外键（foreignKeys）
  - 索引（indexes，含 indexes.data）

2) `data/<db>_<table>.json`

- 保存表数据与版本号：
  - `data`: 行数组
  - `version`: 版本号（乐观锁）

3) `data/locks/<db>_<table>.lock`

- 服务端/CLI 的表级锁文件

### 3.2 metadata.json 的语义

metadata 是“schema 层”的权威数据源。

- `metadata.tables` 是一个 map：key 为 `tableName`
- 每张表包含：
  - `columns`: 数组，每个元素是列对象
  - `foreignKeys`: 数组，每个元素是外键对象
  - `indexes`: 对象（map），key 为索引名

列对象在不同位置略有差异，但核心字段包括：

- `name`: 列名
- `type`: 类型字符串（展示用途为主）
- `size`: VARCHAR 长度等
- `primaryKey`: 是否主键
- `autoIncrement`: 是否自增（部分路径支持）
- `notNull`: 是否非空
- `default`: 默认值（字符串形式）

外键对象核心字段：

- `name`: 约束名（可选）
- `column`: 本表列
- `refTable`: 引用表
- `refColumn`: 引用列
- `onDelete`: RESTRICT / CASCADE / SET NULL / NO ACTION
- `onUpdate`: RESTRICT / CASCADE / SET NULL / NO ACTION

索引对象核心字段（本项目的“模拟索引”）：

- `name`: 索引名
- `columns`: 索引列数组（支持多列）
- `unique`: 是否唯一
- `data`: 核心结构：`key -> [rowIndex, rowIndex, ...]`
- `createdAt`: 创建时间（字符串）

### 3.3 table.json 的语义

表数据文件采用：

```json
{
  "version": "2026-01-15T09:43:59.601Z",
  "data": [ {"id": 1, "name": "Alice"}, ... ]
}
```

- `version`：用于乐观锁。每次写入都会生成新的 ISO 时间字符串。
- `data`：行数组。行是 JSON 对象，不做强类型系统。

### 3.4 版本号（version）与一致性

为什么要版本号：

- 多个浏览器窗口/多个 CLI 进程可能同时读写同一表。
- 如果仅靠“最后写入覆盖”，会出现“写丢失”。

因此设计：

- 读取到的表版本号记录在前端/CLI 的 `tableVersions[db.table]`。
- 写入时携带 `expectedVersion`，服务端比较：
  - 若服务端文件版本 != expectedVersion：返回 409
  - 前端提示用户刷新

后续第 7 章会结合 `server.js` 与 `app.js` 详解。

---

## 4. 后端 server.js：静态资源 + REST API + 并发控制

### 4.1 server.js 的启动与目录准备

- 端口：`PORT = 8080`
- 数据目录：`DATA_DIR = path.join(__dirname, 'data')`
- 锁目录：`LOCK_DIR = path.join(__dirname, 'data', 'locks')`

启动时确保目录存在：

- 若 `data/` 不存在则创建
- 若 `data/locks/` 不存在则创建

### 4.2 表级锁（acquireTableLock / releaseTableLock）

锁文件路径：`locks/<db>_<table>.lock`

锁获取策略：

- `fs.writeFileSync(lockFile, pid, { flag: 'wx' })`
- `wx` 表示：文件不存在才创建，存在则抛出 EEXIST
- 若 EEXIST：
  - 检查锁文件 mtime
  - 若超过 5 秒视为超时锁，删除后重试
  - 否则短暂自旋等待

锁释放：`unlinkSync(lockFile)`

这一层保证“同一时刻只有一个进程能写同一张表文件”。

### 4.3 API：/api/databases（懒加载元数据）

目的：一次性返回所有数据库的元数据（不含表数据），并返回每张表的版本号。

返回格式：

```json
{ "success": true, "databases": { ... }, "tableVersions": { "db.table": "version" } }
```

实现细节：

- 遍历 `DATA_DIR` 下所有 `*_metadata.json`
- 读出 `content.metadata`（兼容老格式）
- 对每个表文件 `<db>_<table>.json` 读出其 `version`

### 4.4 API：/api/table-data/:db/:table（按需加载表数据）

目的：当 Web 端首次访问某张表时拉取数据。

返回格式：

```json
{ "success": true, "data": [...], "version": "..." }
```

若表文件不存在：返回空数组与 null 版本。

### 4.5 API：/api/table-version/:db/:table（读版本号）

目的：Web 端在“读查询前”可检查服务器版本是否与本地缓存一致。

### 4.6 API：/api/save-table（写表数据）

请求体包含：

- `database`
- `table`
- `data`
- `version`（将要写入的版本号）
- `expectedVersion`（客户端认为当前表的版本号）

核心流程：

1) acquireTableLock(db, table)
2) 若 expectedVersion 存在且表文件存在：读取 existing.version
3) 若 existing.version != expectedVersion：
   - releaseLock
   - 返回 409 + serverVersion/clientVersion
4) 写入表文件 `{ version, data }`
5) releaseLock

### 4.7 API：/api/save-metadata（写元数据）

用于 DDL/索引/外键改变后持久化 `<db>_metadata.json`。

### 4.8 API：删除库/表/重命名表文件

server.js 还提供几个面向 Web 端的“文件级操作 API”：

- `POST /api/delete-database?database=...`
  - 删除 `<db>_metadata.json`
  - 删除该库下所有 `<db>_*.json` 表文件
  - 删除该库下所有锁文件

- `POST /api/delete-table?database=...&table=...`
  - 删除 `<db>_<table>.json` 与对应锁文件

- `POST /api/rename-table-file?database=...&from=...&to=...`
  - rename 表文件，并尝试 rename lock 文件

这些 API 让前端在执行 DROP/RENAME 时可以同步处理文件系统。

### 4.9 API：/api/backup 与 /api/restore

server.js 提供快照导出/导入：

- `GET /api/backup?scope=all`
- `GET /api/backup?scope=db&database=<db>`
- `POST /api/restore?mode=merge&conflict=rename`

快照结构（v2.0）包括：

- `databases`：所有库元数据
- `tableData`：每张表数据与版本
- `tableVersions`：冗余版本映射

导入合并的关键特性：

- 重名库/表自动重命名（`_import1/_import2...`）
- 更新外键的 `refTable` 指向新的表名
- 对每张表写入时同样使用表级锁

### 4.10 静态文件服务

对于不是 `/api/*` 的请求：

- 去掉 querystring
- `/` 映射到 `/index.html`
- 根据扩展名设置 Content-Type
- `fs.readFile` 返回静态资源

---

## 5. 前端 index.html：UI 结构与交互入口

### 5.1 页面布局

核心区域：

- header：标题与简介
- toolbar：
  - 新建数据库
  - 新建表
  - 导出/导入/清空
  - ER 图
  - SQL 帮助
- sidebar：
  - 数据统计卡
  - 数据库列表（带删除按钮）
  - 数据表列表（带编辑/删除）
- main-content：
  - SQL 编辑器 + 快捷按钮 + 执行历史
  - 结果展示区 + CSV 导出按钮 + 行删除开关
  - 状态栏（连接状态、当前库、事务状态、耗时、存储信息）

### 5.2 关键 DOM id 与 app.js 的绑定

- `#sql-editor`：SQL 输入
- `#result-area`：执行结果区域
- `#db-list` / `#table-list`：侧栏列表
- `#current-db`：状态栏当前库显示
- `#transaction-status`：事务进行中提示
- `#exec-time`：执行耗时
- `#storage-info`：存储大小/绑定文件名
- 各种 modal：`create-db-modal/create-table-modal/edit-table-modal/er-modal`

index.html 通过 `onclick="..."` 直接调用 `app.js` 的全局函数（例如 `executeSQL()`）。

---

## 6. 前端 app.js：全局状态、懒加载、版本控制与落盘

### 6.1 全局状态变量

`app.js` 顶部定义了核心状态：

- `databases`：仅存 schema（元数据）为主
- `tableData`：按需加载的表数据缓存（含 version）
- `tableVersions`：表级版本号字典（`db.table` -> version）
- `currentDatabase`：当前库
- `inTransaction`：事务标志
- 事务快照：`transactionSnapshot/transactionSnapshotTableData/transactionSnapshotTableVersions`
- 事务变更集：`transactionModifiedTables/transactionModifiedDatabases`
- `sqlHistory`：执行历史（localStorage）
- `enableRowDelete`：是否启用结果行删除
- `fileHandle`：绑定本地文件句柄（用于“导入/导出后自动写回”）

### 6.2 初始化入口 init()

`init()` 做的事：

1) `await loadFromLocalFile()`：优先走后端 API 获取元数据
2) 渲染列表：`renderDatabaseList()/renderTableList()`
3) 更新存储信息：`updateStorageInfo()`
4) 初始化“行删除开关”的 UI 与 localStorage
5) 为 SQL 编辑器绑定 `Ctrl+Enter` 执行
6) 初始化可视化建表编辑器：`addFieldRow()`

### 6.3 懒加载元数据：loadFromLocalFile()

优先策略：

- 请求 `/api/databases?t=...`
- 成功：
  - `databases` 只保留 tables 的 columns/foreignKeys/indexes
  - `tableVersions` 取后端返回
  - 写入 localStorage（minisql_metadata）
- 失败：回退到 localStorage

### 6.4 懒加载表数据：loadTableData() / getTableData()

- `loadTableData(db, table)`：
  - 若缓存已存在直接返回
  - 否则 `fetch /api/table-data/db/table`
  - 写入 `tableData[db.table] = { data, version }`
  - 同步 `tableVersions[db.table]`

- `getTableData(db, table)`：
  - 缓存不存在则触发 `loadTableData`
  - 返回 `tableData[db.table].data`

### 6.5 写表数据：saveTableData()

- 生成 `newVersion`（避免与 expectedVersion 相同）
- POST 到 `/api/save-table`
- 若 200：
  - 更新 `tableVersions` 与 `tableData[db.table].version`
  - 若绑定了 fileHandle，则 `writeBoundFileSnapshot(scope=all)` 写回本地文件
- 若 409：
  - UI 提示冲突

### 6.6 写元数据：saveMetadata() / persistCurrentDbMetadata()

- `saveMetadata(db)`：
  - 清洗元数据（只写 columns/foreignKeys/indexes）
  - POST `/api/save-metadata`

- `persistCurrentDbMetadata()`：
  - 仅在表级存储模式下启用
  - 若事务中：记录到 `transactionModifiedDatabases`，延迟到 COMMIT
  - 否则立即保存

---

## 【批次 2】前端 app.js：UI 渲染与可视化编辑器（答辩级细节）

本批次开始“逐函数”解释 UI 相关部分，覆盖：

- 左侧数据库/数据表列表渲染
- 选择数据库与快速预览表
- 删除确认与 SQL 注入（把 DROP/SELECT 写入编辑器再执行）
- 模态框（建库/建表/编辑表/ER 图）
- 可视化建表：字段行的增删、SQL 拼装
- 可视化编辑表：字段变更与外键变更的 SQL 生成策略

### 7. UI 渲染：renderDatabaseList()

目的：将 `databases`（仅元数据）映射为左侧数据库列表 UI。

关键点：

- 使用 `Object.keys(databases)` 得到库名数组
- 当前库 `currentDatabase` 用 `.active` 高亮
- 每个库条目都包含一个删除按钮（🗑）
- 删除按钮要 `event.stopPropagation()`，避免触发“选中库”的点击

代码片段（结构化理解）：

```js
function renderDatabaseList() {
    const container = document.getElementById('db-list');
    const dbNames = Object.keys(databases);
    if (dbNames.length === 0) {
        container.innerHTML = '暂无数据库';
        return;
    }
    container.innerHTML = dbNames.map(name => `
        <div class="db-item ${currentDatabase === name ? 'active' : ''}" onclick="selectDatabase('${name}')">
            <span>📁 ${name}</span>
            <div class="item-actions">
                <button onclick="event.stopPropagation();confirmDropDb('${name}')">🗑</button>
            </div>
        </div>
    `).join('');
}
```

### 7.1 UI 渲染：renderTableList()

目的：渲染“当前数据库”的表列表。

关键点：

- 若未选库：显示“请先选择数据库”
- 若已选库：遍历 `databases[currentDatabase].tables`
- 每个表条目支持：
  - 点击表名：快速预览（`quickSelectTable` -> `SELECT * ... LIMIT 50`）
  - 编辑按钮：打开 edit modal（`openEditTable`）
  - 删除按钮：`confirmDropTable`（写入 `DROP TABLE` 再执行）

在表级存储模式下：

- `databases[currentDatabase].tables[table].data` 可能是空数组或未实时同步
- 真实数据行数应该以 `tableData[db.table].data.length` 为准，但 UI 中有时仍展示 `table.data.length`
  - 这属于“课程设计简化”与“缓存一致性”之间的折中

### 7.2 选择数据库：selectDatabase(name)

该函数做了两类事：

1) 更新状态：

- `currentDatabase = name`
- 状态栏 `#current-db` 显示库名

2) 触发 UI 刷新 + 用户反馈：

- `renderDatabaseList()` / `renderTableList()`
- `showResult('已切换到数据库...', 'success')`

### 7.3 快速预览表：quickSelectTable(tableName)

通过把 SQL 直接写入编辑器并调用 `executeSQL()` 实现：

```js
document.getElementById('sql-editor').value = `SELECT * FROM ${tableName} LIMIT 50;`;
executeSQL();
```

这种方式的好处：

- 不需要额外 UI API
- 复用 SQL 执行主流程与结果渲染

风险点：

- 直接字符串拼接，如果 tableName 可控（理论上来自元数据，较安全）仍应注意注入

### 7.4 删除确认：confirmDropDb / confirmDropTable

两者的模式一致：

1) 弹出 `confirm(...)`
2) 把 `DROP ...` 写入编辑器
3) 调 `executeSQL()`

这让“删除”也走统一 SQL 执行路径（便于日志/历史/事务一致性）。

---

## 8. 模态框系统（Modal）

在 `index.html` 中，弹窗通过 `div.modal-overlay` + `show` class 控制显示。

### 8.1 showModal(id) / closeModal(id)

- `showModal(id)`：给 overlay 加 `.show`，并对特定 modal 做 focus
- `closeModal(id)`：移除 `.show`

```js
function showModal(id) {
    document.getElementById(id).classList.add('show');
    if (id === 'create-db-modal') document.getElementById('new-db-name').focus();
    if (id === 'create-table-modal') document.getElementById('new-table-name').focus();
}
```

### 8.2 createDatabaseFromModal()

把用户输入的库名转为 SQL：

```js
document.getElementById('sql-editor').value = `CREATE DATABASE ${name};`;
executeSQL();
```

注意：

- UI 仅做 `trim()` + 空串校验
- 库名的合法性校验主要靠 `executeCreateDatabase` 的正则与存在性检查

### 8.3 可视化建表：addFieldRow / removeFieldRow / createTableFromModal

#### 8.3.1 addFieldRow()

内部维护 `fieldRowCounter`，每添加一行：

- 生成唯一 id
- 在 `#field-rows` 追加一行输入控件：字段名、类型、长度、主键、非空

#### 8.3.2 createTableFromModal()

把可视化输入拼成 `CREATE TABLE` SQL：

1) 读取所有 `.field-row`
2) 对每行拼装列定义：

- `${name} ${type}`
- 若 size 填了则加 `(size)`
- 若 pk 勾选则加 `PRIMARY KEY`
- 若 nn 勾选则加 `NOT NULL`

3) 用 `cols.join(',\n')` 拼出完整 SQL
4) 写入编辑器并执行

答辩解释点：

- 该“可视化编辑器”本质是 SQL 生成器
- 数据库语义仍由 SQL 引擎执行器保证

---

## 9. 可视化编辑表（字段/外键/重命名）

### 9.1 openEditTable(tableName)

核心流程：

- 设置全局 `editingTable`
- 填充 tab1（字段列表）
- 调用 `renderEditFKRows(tableName)` 填充 tab2（外键列表）
- 打开 modal

### 9.2 外键编辑：renderEditFKRows / addEditFKRow / markFKDeleted / updateRefColumns

外键编辑行的实现非常“工程化”，每一行都把原始值写入 `data-*`：

- `data-fk-original-column`
- `data-fk-original-ref-table`
- `data-fk-original-ref-column`
- `data-fk-original-on-delete`
- `data-fk-original-on-update`

这样在保存时能判断“外键是否发生变化”，如果变化则生成 `DROP FOREIGN KEY` + `ADD CONSTRAINT`。

### 9.3 保存变更：saveTableChanges()

这是 UI 编辑器最关键的函数：它把用户在 modal 里做的更改转换为**一组 SQL**，并保证执行顺序尽可能正确。

生成 SQL 的总体顺序：

1) 先 DROP 外键（`fkDropSqls`）
2) 再做列相关变更（`colSqls`：ADD/DROP/RENAME COLUMN）
3) 最后 ADD 外键（`fkAddSqls`）

原因：

- 先删外键才能删列/改列
- 列改完后再重建外键

最终执行方式：

```js
document.getElementById('sql-editor').value = sqls.join(';\n') + ';';
executeSQL();
```

---

## 10. 文件导入导出、清空数据

### 10.1 exportToFile()

导出走后端 `GET /api/backup`：

- confirm：导出 all 还是仅当前 db
- `fetchBackupSnapshot({ scope, database })`
- 把 JSON 文本打包成 Blob，下载为文件

### 10.2 importFromFile(event)

导入走后端 `POST /api/restore?mode=merge&conflict=rename`：

- 先读文件文本并 `JSON.parse` 验证
- confirm：合并导入且重名会自动改名
- POST raw JSON
- 成功后 `loadFromLocalFile()` 重新加载元数据与版本号

### 10.3 clearAllData()

调用后端 `POST /api/clear-all`，并在前端清空所有缓存：

- `databases = {}`
- `tableData = {}`
- `tableVersions = {}`
- `currentDatabase = null`
- `localStorage.removeItem('minisql_metadata')`

---

## 11. ER 图可视化（showERDiagram / generateERDiagram）

ER 图实现是纯前端渲染：

- 从 `tables[table].foreignKeys` 提取关系边
- 计算每个表卡片的位置（最多三列布局）
- 使用 SVG 绘制折线连接（带箭头 marker）
- 表卡片中用 🔑 表示 PK，用 🔗 表示 FK

重要细节：

- `relations` 的构造会用列名匹配找到字段行号，用于定位连线的 Y 坐标
- 连线颜色循环数组：`colors = ['#e74c3c', '#3498db', ...]`

---

## 12. SQL 执行主流程（executeSQL / parseSingleSQL）

### 12.1 isReadOnlySQL(sql)

用于判断语句是否“读操作”或“事务控制命令”。

被认定为 read-only 的包括：

- `SELECT/SHOW/DESC/DESCRIBE/USE`
- 事务命令：`BEGIN/COMMIT/ROLLBACK`

这影响 `executeSQL()` 中的逻辑：

- 如果本次执行只有读查询，且不在事务中：会先做 `ensureReadFreshTableLevel`（表级版本检查）

### 12.2 executeSQL()

`executeSQL()` 是 Web 端最核心的“批处理执行器”。

关键步骤：

1) 预处理输入：

- 把换行变空格：`sql.replace(/[\r\n]+/g, ' ')`
- 把多空格压缩：`replace(/\s+/g, ' ')`

2) 拆分语句：

- `sql.split(';')`
- 过滤空语句与以 `--` 开头的语句

3) 分析语句集合：

- 是否包含读查询（SELECT/SHOW/DESC）
- 是否包含写操作（非 read-only）
- 是否包含事务控制（COMMIT/ROLLBACK）

4) 若是纯读且不在事务：执行 `ensureReadFreshTableLevel(statements)`

5) 循环执行每条语句：`await parseSingleSQL(trimmedStmt)`

6) 多条 INSERT 汇总：如果检测到多个 INSERT，覆盖 message 为“共插入 N 行”

7) 更新 UI：耗时、结果、历史、列表刷新

### 12.3 parseSingleSQL(sql)

这是 SQL 的“分发器”，按优先级路由到不同执行器：

- 事务：BEGIN/COMMIT/ROLLBACK
- DDL：CREATE/DROP DATABASE、USE、SHOW、CREATE/DROP/RENAME TABLE、DESC
- DML：INSERT/SELECT/UPDATE/DELETE/ALTER/TRUNCATE
- 索引：CREATE/DROP/SHOW INDEXES
- 外键：SHOW FOREIGN KEYS

这套分发器是 detail.md 后续“逐语句解释”的入口。

---

## 13. 事务执行器（executeBegin/executeCommit/executeRollback）

事务模型：快照 + 延迟提交。

- BEGIN：深拷贝 `databases`，表级存储模式下也拷贝 `tableData/tableVersions`
- COMMIT：
  - 对 `transactionModifiedTables` 中的表逐个 `saveTableData`
  - 对 `transactionModifiedDatabases` 中的库逐个 `saveMetadata`
- ROLLBACK：
  - 恢复快照变量

注意：

- 表级存储模式下，事务期间的改动不会立即写文件（只记录 modified set）
- 旧版单文件模式下（`useTableStorage=false`）走 `saveToStorage`（目前多为 stub）

---

## 14. DDL 概览（本批次只做入口说明）

以下执行器已在代码中实现：

- `executeCreateDatabase / executeDropDatabase / executeUse / executeShowDatabases`
- `executeShowTables / executeCreateTable / executeDropTable / executeRenameTable / executeDescribe`
- `executeAlterTable`（含外键 ADD/DROP、列 ADD/DROP/MODIFY/RENAME）

下一批会对 DDL 的每条路径做“逐正则、逐校验、逐副作用（写元数据/删文件/改引用）”展开。

---

## 15. DML/查询/索引/外键：本批次的关键信息汇总

为了保证你读后能在脑中建立“执行引擎全景图”，这里把最核心的执行点做一次汇总（详细将在后续批次逐条展开）：

- INSERT：
  - 处理自增主键
  - 校验主键唯一、唯一索引
  - 校验外键引用存在
  - 写入 `tableDataArray.push(row)`
  - 如存在索引：`rebuildIndexDataForTable` + `persistCurrentDbMetadata`
  - 落盘：`saveTableData`（事务中仅标记）

- SELECT：
  - 支持 DISTINCT/WHERE/GROUP BY/HAVING/ORDER BY/LIMIT OFFSET
  - 纯单表：WHERE 优先尝试索引候选集（= / IN）
  - JOIN：目前为嵌套循环连接
  - 返回 message 可附带 `使用索引: xxx`

- UPDATE：
  - 支持 `SET col = literal` 与 `SET col = col + number` 等简单表达式
  - 更新后如存在索引：重建索引 + 校验唯一性
  - 失败回滚：用 snapshot 恢复数组

- DELETE：
  - 支持 WHERE
  - 若被其他表外键引用：根据 onDelete 做 RESTRICT/SET NULL/CASCADE
  - 对所有被修改表重建索引并落盘

- TRUNCATE：
  - 清空表数据
  - 若有索引：重建索引并保存元数据

- 索引：
  - CREATE INDEX：验证列存在/唯一性（unique）/构建 indexes.data
  - DROP INDEX：删除 indexes[indexName]
 - SHOW INDEXES：展示 PRIMARY + 用户索引

- 外键：
 - SHOW FOREIGN KEYS：展示 `foreignKeys` 数组
  - ALTER TABLE ADD FOREIGN KEY：检查引用表/列存在 + 检查现有数据满足
  - ALTER TABLE DROP FOREIGN KEY：删除对应 fk

 ---

 ## 【批次 3】补齐关键“实现状态/缺口”与全量清单（用于答辩追问）

 本批次的目标：把一些“答辩时最容易被追问的点”写清楚写透，尤其是：

 1. `index.html` 与 `app.js` 的入口是否完全对齐（例如 `bindLocalFile`）
 2. Web 与 CLI 的行为差异（尤其 SQL 拆分）
 3. `server.js` 的全部 API 路由与行为边界
 4. 项目支持的 SQL 语法清单（以实际分发器/正则为准）

说明：

- 这是一个纯字符串包含判断
- 因此只要写了 `JOIN`，就不会走单表解析正则，而是交给 `executeJoinSelect`

### 32.2 DISTINCT：先抹掉关键字，最后用 Set 去重

DISTINCT 的实现方式是：

1) 判断是否存在 DISTINCT：

```js
const hasDistinct = /SELECT\s+DISTINCT\s+/i.test(sql);
```

2) 统一解析：把 `SELECT DISTINCT` 替换为 `SELECT`，便于复用同一条 SELECT 正则：

```js
const sqlNorm = sql.replace(/SELECT\s+DISTINCT\s+/i, 'SELECT ');
```

3) 投影结束后：

- 用 `JSON.stringify(row)` 作为去重 key
- 用 `Set` 去重

这个策略的优点：简单、可解释、对课程设计足够。

### 32.3 单表 SELECT 正则：一次性捕获所有子句

代码中的正则：

```js
const match = sqlNorm.match(
  /SELECT\s+(.*?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+GROUP\s+BY\s+([\w,\s]+))?(?:\s+HAVING\s+(.+?))?(?:\s+ORDER\s+BY\s+([\w.]+)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?)?$/i
);
```

解析结果对应：

- `selectCols`
- `tableName`
- `whereClause`
- `groupBy`
- `havingClause`
- `orderBy` / `orderDir`
- `limit` / `offset`

这也界定了项目 SELECT 的“真实语法边界”：

- ORDER BY 只支持一个字段
- LIMIT/OFFSET 是最后出现
- FROM 只支持一个表名（不支持多表逗号、子查询）

### 32.4 数据来源：table-level storage 懒加载

```js
const tableDataArray = useTableStorage
  ? await getTableData(currentDatabase, tableName)
  : table.data;
let data = [...tableDataArray];
```

这意味着：

- `table.data` 在 table-level 模式下不是权威数据源
- 真实数据在 `tableData[db.table].data` 中

### 32.5 WHERE：索引预过滤（候选集） + evaluateWhere（精过滤）

核心代码：

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

解释：

- `tryApplyIndexWhere` 只负责“能不能快速缩小候选集”
- 不负责完整语义等价（因此仍需 `evaluateWhere` 再判断一次）
- 命中索引会在 message 里提示 `使用索引: xxx`（便于答辩展示优化点）

### 32.6 聚合/分组路径：executeAggregateSelect

进入聚合路径的条件：

- `selectCols` 中出现 `COUNT/SUM/AVG/MAX/MIN`
- 或存在 `GROUP BY`

聚合执行器返回的 message 默认是 `聚合查询到 N 行数据`，如果 WHERE 走过索引，会把 `| 使用索引: idx` 拼上。

### 32.7 ORDER BY / LIMIT OFFSET

- ORDER BY：
  - 只支持单列
  - 支持 `t.col` 形式（会取 `col`)
- LIMIT：
  - `LIMIT n OFFSET m` 或 `LIMIT n`
  - 若只有 OFFSET：`data.slice(offset)`

### 32.8 输出结构（type/table/meta）

SELECT 返回：

- `type: 'table'`
- `columns`：输出列数组
- `data`：投影后的行对象数组
- `meta.pkColumn`：用于 UI “按行删除”定位主键

---

## 33. 聚合 SELECT：executeAggregateSelect(...)

聚合执行器的关键机制：

1) 用 `selectCols.split(',')` 拆 item
2) 用正则识别聚合函数并支持 `AS alias`
3) 若有 HAVING：扫描 HAVING 中出现的聚合表达式，并加入“必须计算”的集合
4) GROUP BY 用 Map 分组
5) HAVING 直接复用 `evaluateWhere(row, havingClause)`（因此 WHERE 引擎必须能读到 `COUNT(*)` 这类 key）

---

## 34. JOIN SELECT：executeJoinSelect(sql)

### 34.1 JOIN 语法正则

```js
const joinMatch = sql.match(
  /SELECT\s+(.*?)\s+FROM\s+(\w+)(?:\s+(\w+))?\s+JOIN\s+(\w+)(?:\s+(\w+))?\s+ON\s+(.+?)(?:\s+WHERE\s+(.+))?$/i
);
```

支持：

- `FROM t1 alias1 JOIN t2 alias2 ON ...`
- 可选 WHERE

不支持：

- 多表 JOIN 链
- LEFT/RIGHT JOIN
- JOIN 后的 ORDER BY/LIMIT（正则未覆盖）

### 34.2 ON 条件：只支持等值连接

```js
const onMatch = onCondition.match(/([\w.]+)\s*=\s*([\w.]+)/);
```

- 只支持 `=`
- 只支持一条等值条件

 ### 34.3 Join 算法：Nested Loop Join（嵌套循环）

```js
for (const row1 of data1) {
  for (const row2 of data2) {
    if (row1[leftCol] == row2[rightCol]) {
      // merge
    }
  }
}
```

JOIN 算法特点：

- 时间复杂度：O(n*m)
- 优点：实现非常直观（数据库原理课最基础的连接算法），答辩可解释
- 缺点：数据量变大时性能较差（后续可优化：基于索引做 Index Nested Loop Join / Hash Join 等）

### 34.4 merge 的列名策略：既保留别名前缀，也保留无前缀字段

合并时对表 1 的每个列（伪代码表达）：

- `merged["alias1.col"] = row1[col]`
- `merged["col"] = row1[col]`

合并时对表 2 的每个列：

- `merged["alias2.col"] = row2[col]`
- `merged["col"] = row2[col]`（**仅当** `merged[col]` 尚未存在时才写入，用于避免覆盖表 1 的无前缀字段）

因此 joined row 同时包含两套字段名：

- 带前缀字段：`o.id`、`p.id`（用于消除歧义）
- 无前缀字段：`id`、`name`（用于简化查询，但在列同名场景会产生歧义）

这个策略在答辩中的说法通常是：

- “为了兼容简单写法，默认保留无前缀字段；为了支持精确访问，也保留别名前缀字段。”

### 34.5 JOIN 的 WHERE：对 merged row 做过滤

JOIN 生成 `joinedData` 后，如果存在 WHERE，会执行：

- `joinedData = joinedData.filter(row => evaluateWhere(row, whereClause))`

由于 row 同时包含 `col` 与 `alias.col` 两种 key，因此 WHERE 可以写：

- `WHERE id = 1`
- `WHERE o.id = 1`

且 `evaluateCondition` 的 key 正则允许 `\w.`，因此 `o.id = 1` 这种写法可用。

### 34.6 JOIN 的投影：列列表 + `t.*` 展开

JOIN 的输出列 `columns` 生成规则：

- `SELECT *`：
  - 输出表 1 的所有列：`alias1.col`
  - 输出表 2 的所有列：`alias2.col`
- `SELECT t.*`：
  - 展开成 `tAlias` 对应表的全部 `tAlias.col`
- `SELECT o.id, p.name`：
  - 直接按用户列清单输出

投影阶段会对每行构造 `newRow`：

- 对每个输出列名 `col`：`newRow[col] = row[col] ?? null`

最终结果：

- `type: 'table'`
- `columns`: 投影列
- `data`: 投影后的 joined rows
- `message`: `JOIN查询到 N 行数据`

---

## 【批次 7】WHERE 引擎：evaluateWhere / splitTopLevel / evaluateCondition（字符级状态机）

本批次目标：把 WHERE 求值引擎讲清楚：它如何在不引入完整 AST/Parser 的前提下，支持 AND/OR、括号、引号、BETWEEN、IN/NOT IN、LIKE、IS NULL 等。

---

## 35. evaluateWhere(row, whereClause)：OR/AND 两层拆分 + 短路

`evaluateWhere` 的结构非常“数据库原理直觉化”：

1) 先把表达式按顶层 `OR` 拆分成多个分支
2) 对每个 OR 分支，再按顶层 `AND` 拆分成多个条件
3) OR 用 `some(...)`，AND 用 `every(...)`


这等价于：

- `(A OR B OR C) AND (D AND E)`

的计算方式（带短路）。

---

## 36. splitTopLevel(expr, keyword, betweenAware)：引号/括号/BETWEEN 的状态机

splitTopLevel 的目标是：只在“顶层语义位置”拆分 AND/OR。

它在逐字符扫描时维护：

- `quote`：是否在 `'` 或 `"` 引号内
- `depth`：括号深度（遇到 `(` +1，遇到 `)` -1）
- `pendingBetween`：是否刚遇到 `BETWEEN`（用于保护 `BETWEEN a AND b` 的 AND 不被拆成逻辑 AND）

拆分条件：

- 只有当 `quote==null && depth==0` 时才允许识别关键字

BETWEEN 的特殊规则：

- 当 `betweenAware=true` 且关键字是 `AND`，如果 `pendingBetween=true`，则把这个 AND 当成 BETWEEN 的语法组成，不拆分。

这保证了如下表达式能正确解析：

- `(a = 1 OR b = 2) AND c = 3`
- `age BETWEEN 10 AND 20`
- `name LIKE 'A%';`（引号内字符不会干扰拆分）

---

## 37. evaluateCondition(row, condition)：原子条件的匹配顺序

evaluateCondition 按顺序匹配：

1) `BETWEEN ... AND ...`
2) `NOT IN (...)`
3) `IN (...)`
4) `LIKE 'pattern'`
5) `IS NULL` / `IS NOT NULL`
6) 比较运算符：`= != <> < > <= >=`

其中 LIKE 的实现方式是：

- 把 `%` 替换成 `.*`
- 把 `_` 替换成 `.`
- 构造正则 `^...$` 做匹配

---

## 【批次 8】样例数据文件：idx_demo（索引 indexes.data 的可视化解释）

本批次目标：把 `data/idx_demo_*` 这套样例文件讲到可以“拿着文件就解释索引怎么命中”。

---

## 38. idx_demo 的文件列表

在 `minisql_web/data/` 下与 idx_demo 相关的文件：

- `idx_demo_metadata.json`
- `idx_demo_employees.json`

---

## 39. idx_demo_metadata.json：indexes.data = “值 -> 行下标列表”

`idx_demo_metadata.json` 的结构（概念上）：

- `metadata.tables[tableName].columns`
- `metadata.tables[tableName].foreignKeys`
- `metadata.tables[tableName].indexes[indexName]`

`employees` 表的索引 `idx_employees_dept`（列：`dept`）中，最关键的是 `data` 字段：

- `"R&D": [0, 1]`
- `"HR": [2, 4]`
- `"Sales": [3]`

含义：

- key：索引列的取值（dept）
- value：表数据数组中命中该取值的行下标（rowIndex）

因此当执行 `WHERE dept = 'HR'` 时，索引预过滤阶段可以立即得到候选下标 `[2,4]`.

---

## 40. idx_demo_employees.json：version + data

表文件结构：

- `version`：后端乐观锁版本号（ISO 时间戳）
- `data`：行对象数组

 例如 `data[0]` / `data[1]` 都是 `dept='R&D'`，因此索引里 "R&D": [0,1] 就是对 data 下标的引用。
 
 ---

 ## 【批次 9】索引系统（Indexes）：结构、维护、唯一性约束、索引加速查询

 本批次目标：把索引系统讲到可以“拿着 metadata 文件 + 对照 app.js 代码”完整解释：

 - 索引在什么位置保存
 - indexes.data 的结构到底是什么
 - 写操作后为什么要重建索引
 - 唯一索引与主键唯一性如何校验
 - SELECT 的 WHERE 如何走索引预过滤（tryApplyIndexWhere）

 ---

 ## 41. 索引元数据结构：table.indexes

 在 Web 端的内存元数据中，每张表对象 `table` 都可能包含：

 - `table.indexes`：对象字典（key 为 indexName）

 每个索引对象大致为：

 - `name`：索引名
 - `columns`：索引列数组
 - `unique`：是否唯一索引
 - `data`：索引数据（值 -> 行下标列表）
 - `createdAt`：创建时间戳

 这一结构会在 `saveMetadata(dbName)` 时被清洗并写入 `data/<db>_metadata.json`。

 ---

 ## 42. 索引数据结构：idx.data = { keyString: [rowIndex, ...] }

 索引 `data` 的核心形态（与 idx_demo 的文件一致）：

 - key：`String`（把索引列取值拼成一个字符串）
 - value：数组（存储命中该 key 的“行下标”）

 这里的行下标指的是：

 - 表数据数组 `tableDataArray`（即 `tableData[db.table].data` 或 `table.data`）
 - 其元素位置 `i`

 因此索引并不是传统数据库里“物理地址/页号/指针”，而是：

 - **JS 数组下标**

 这是课程设计里的一个很典型取舍：

 - 优点：实现简单、可演示
 - 缺点：DELETE 会让数组下标整体变化，导致“增量维护索引”变复杂（因此本项目采用重建策略）

 ---

 ## 43. rebuildIndexDataForTable(table, dataArray)：写操作后的全量重建

 重建函数的代码核心：

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

 ### 43.1 key 的构造规则（非常关键）

 对每个索引列 `c`：

 - 用 `getRowValueCaseInsensitive(row, c)` 取值（大小写不敏感）
 - 若值是 `null/undefined`：写入空串 `''`
 - 否则写入 `String(v)`

 多列索引时：

 - 用 `|` 拼接：`col1|col2|...`

 ### 43.2 为什么需要全量重建

 因为索引里存的是 rowIndex：

 - INSERT：新增行只会影响末尾下标（可增量）
 - UPDATE：不改变行位置，但会改变 key（可增量）
 - **DELETE**：会让“后续所有行”的下标整体左移

 如果要增量维护，DELETE 需要更新大量 rowIndex，非常复杂。

 因此本项目选择：

 - 任何会影响数据数组的操作后，都直接重建 `idx.data`

 答辩口径：

 - “为了保证正确性与实现简洁，采用全量重建；性能优化属于后续工作。”

 ---

 ## 44. 唯一性约束：主键唯一 + 唯一索引唯一

 本项目把“唯一性”分为两层：

 - **主键唯一**（PRIMARY KEY）
 - **唯一索引唯一**（CREATE UNIQUE INDEX）

 ### 44.1 ensurePrimaryKeyUnique(table, dataArray)

 核心逻辑：

 - 找到 `table.columns` 中 `primaryKey=true` 的列
 - 用 `Set` 记录已出现的主键值
 - 若重复：抛错 `主键 'pk' 值 'x' 已存在`

 注意：

 - 主键值为 `null/undefined` 会被跳过（不参与重复判断）

 ### 44.2 ensureUniqueIndexes(table, dataArray)

 核心逻辑：

 - 遍历 `table.indexes`
 - 只检查 `idx.unique=true` 的索引
 - 对每行取出索引列的值列表
 - 如果该行任何列值为 `null/undefined`：跳过（不参与唯一性检查）
 - 否则构造 key：`String(v1)|String(v2)|...`，用 Set 查重

 这也解释了一个重要语义：

 - **唯一索引对 NULL 的处理**：本项目采取“包含 NULL 就不校验”的策略
 - 这与很多数据库中“NULL 不参与唯一性约束”的效果类似（但细节可能不同）

 ---

 ## 45. CREATE INDEX：executeCreateIndex(sql)

 CREATE INDEX 的执行流程（按代码顺序）：

 1) SQL 正则匹配：
   - `CREATE [UNIQUE] INDEX idx ON table (col1, col2, ...)`
 2) 取出：`isUnique/indexName/tableName/columns[]`
 3) 规范化列名：`normalizedColumns = columns.map(resolveColumnNameFromTable)`
 4) 校验列存在
 5) 如果是唯一索引：对现有数据做一次唯一性检查（Set 去重）
 6) 构建 `indexData`（与 rebuildIndexDataForTable 同样的 key 规则）
 7) 写入 `table.indexes[indexName] = { name, columns, unique, data, createdAt }`
 8) `await persistCurrentDbMetadata()` 落盘 metadata

 关键点：

 - 代码注释写了“B树模拟结构”，但实际实现是：
   - **hash-map（对象字典） + rowIndex 列表**
 - 这同样是课程设计里常见的“概念对齐 + 实现简化”。

 ---

 ## 46. DROP INDEX / SHOW INDEXES

 ### 46.1 DROP INDEX：executeDropIndex

 - 正则：`DROP INDEX idx_name ON table_name`
 - 直接 `delete table.indexes[indexName]`
 - 之后 `persistCurrentDbMetadata()` 保存元数据

 ### 46.2 SHOW INDEXES：executeShowIndexes

 输出表格列：

 - `Table`
 - `Index_name`
 - `Unique`
 - `Columns`
 - `Type`（固定 `BTREE`，用于“展示对齐数据库概念”）

 其中：

 - 主键会额外以 `PRIMARY` 形式展示
 - 用户索引来自 `table.indexes`

 ---

 ## 47. 索引加速查询：tryApplyIndexWhere(table, dataArray, whereClause)

 这是本项目“索引查询优化”的核心入口，SELECT 的 WHERE 会优先调用它。

 ### 47.1 parseSimpleWhereForIndex：只解析最简单 WHERE

 函数 `parseSimpleWhereForIndex(whereClause)` 的约束非常明确：

 - 只要 WHERE 含有 `AND` 或 `OR`，直接返回 null（不使用索引）
 - 支持两种模式：
   - `col = value`
   - `col IN (v1, v2, ...)`

 返回结构：

 - `{ column: colName, values: [v1, v2, ...] }`

 注意：

 - 解析得到的 `column` 会对 `t.col` 做 `split('.').pop()`
 - values 会过滤掉 `null/undefined`

 ### 47.2 候选索引选择：优先选择 unique 的单列索引

 tryApplyIndexWhere 的候选筛选：

 - 只考虑单列索引（`idx.columns.length === 1`）
 - 要求索引列名与 WHERE 列名大小写一致（用 toLowerCase 比较）
 - 如果多个索引都能用：
   - 按 `unique` 优先排序

 最终选出一个索引：

 - `[indexName, idx] = candidates[0]`

 ### 47.3 命中行下标：indexData[key] -> hitIndices

 对每个查询值 `v`：

 - `key = String(v)`
 - 取 `indexData[key]` 得到 rowIndex 列表
 - 合并到 `hitIndices`

 之后做去重与边界检查：

 - 保证 rowIndex 在 `[0, dataArray.length)`
 - 用 Set 去重
 - 最终把 `dataArray[rowIndex]` 收集为 `rows`

 返回：

 - `{ indexName, rows }`

 ### 47.4 与 evaluateWhere 的关系（正确性保证）

 即便命中索引，SELECT 仍会对 `rows` 再执行一次：

 - `rows.filter(row => evaluateWhere(row, whereClause))`

 这是为了：

 - 保证结果正确（索引预过滤只负责候选集缩小，不保证完整语义）
 - 例如未来扩展 whereClause，索引预过滤依然不会破坏正确性

 ---

 ## 48. 索引系统的边界与潜在坑（必须写进答辩口径）

 ### 48.1 NULL 与空字符串在 index key 上可能混淆

 rebuild/create index 时把 `null/undefined` 转成 `''`，这会导致：

 - `NULL` 与 `''` 可能落到同一个 key

 影响：

 - 若表里既有 NULL 又有空字符串，会在 `indexData['']` 下混在一起

 课程设计的答辩说法：

 - “当前实现做了简化，NULL 在索引 key 中被映射为空串，若要严格区分可在后续版本引入特殊标记（如 '\\0NULL'）。”

 ### 48.2 只支持单列等值/IN 命中索引

 当前索引加速只支持：

 - `WHERE col = value`
 - `WHERE col IN (...)`

 不支持：

 - `AND/OR` 组合条件的索引优化
 - 范围查询（需要有序结构，如 BTree）
 - 多列索引的联合匹配

 这些都可以作为“后续工作”写入优化建议。
 
 ---

 ## 【批次 10】实现缺口与端到端一致性（答辩高频追问点集合）

 本批次目标：把“系统看起来很完整，但实际上容易被追问的缺口/一致性问题”讲清楚。

 这些点往往不是 SQL 语法本身，而是：

 - UI 入口是否真的有实现
 - Web 与 CLI 行为是否一致
 - 数据落盘/快照/版本号机制是否能闭环解释

 ---

 ## 49. `bindLocalFile()`：UI 有入口，但 app.js 缺少实现（当前仓库状态）

 ### 49.1 index.html 中的入口

 工具栏按钮：

 - `onclick="bindLocalFile()"`

 这说明 UI 期望存在一个全局函数 `bindLocalFile()`。

 ### 49.2 app.js 中已经存在的“绑定后写回”基础设施

 即使没有 `bindLocalFile()`，app.js 仍然已经实现了“如果 `fileHandle` 存在，就自动写回”的机制：

 - 全局变量：`fileHandle`
 - 写回函数：`writeBoundFileSnapshot({ scope, database })`
 - 获取快照：`fetchBackupSnapshot({ scope, database })`（走后端 `/api/backup`）
 - UI 显示：`updateStorageInfo()` 会拼接 `fileHandle.name`

 典型写回触发点（以 `saveMetadata` 为例）：

 - 元数据保存成功后：
  - `if (fileHandle) writeBoundFileSnapshot({ scope: 'all' }).catch(() => {})`

 这意味着：

 - 系统设计上已经把“绑定文件”作为一个可选能力
 - 但是缺少“如何获得 fileHandle 并赋值给全局变量”的入口

 ### 49.3 这会导致什么现象（答辩风险）

 - 点击按钮会在浏览器控制台报错：`bindLocalFile is not defined`
 - 进而无法演示“绑定本地文件后自动写回”的亮点

 ### 49.4 修复方向（只写口径，不在本次实现）

 可行方向：

 - 基于 File System Access API（Chrome/Edge 支持）
 - 在 `bindLocalFile()` 中调用 `window.showSaveFilePicker()` 或 `showOpenFilePicker()` 获取句柄
 - 赋值给 `fileHandle`，并立即调用一次 `writeBoundFileSnapshot({ scope: 'all' })`

 该点的工程化建议已在 `OPTIMIZATION_SUGGESTIONS.md` 中作为 P0 说明。

 ---

 ## 50. Web 与 CLI 的 SQL 拆分差异：`sql.split(';')` vs `splitStatements()`

 ### 50.1 Web：executeSQL 的拆分方式（语义上）

 Web 端 `executeSQL()` 的多语句拆分是：

 - `sql.split(';')`

 这会导致一个典型边界：

 - 字符串字面量内部出现 `;` 会被误拆

 示例：

 - `INSERT INTO t (name) VALUES ('a;b');`

 在 Web 端可能被拆成两段，触发语法错误。

 ### 50.2 CLI：splitStatements 的状态机拆分

 CLI 端提供 `splitStatements(sqlText)`，其核心思想是：

 - 扫描字符
 - 用 `quote` 状态记录是否在引号内
 - 只有在 `quote==null` 时才把 `;` 当作语句结束

 因此 CLI 更接近“真实数据库对多语句输入的处理方式”。

 ### 50.3 一致性影响

 - 同一条 SQL 在 CLI 可执行，但 Web 不可执行
 - 这属于“跨入口行为不一致”问题，答辩中容易被追问

 建议口径：

 - 以 CLI 的 `splitStatements` 为准，Web 端应复用同样算法

 ---

 ## 51. “后端薄、前端重”架构下的接口边界复述（用于答辩总结）

 本项目最关键的边界是：

 - **server.js 不解析 SQL**
 - **server.js 不实现 SELECT/WHERE/JOIN 等语义**
 - server.js 只做：静态服务 + 文件读写 + 并发控制（锁/版本）+ 备份恢复

 因此你在答辩中可以把责任边界讲清楚：
 
 - SQL 语义的“正确性”主要由 app.js 保证
 - 数据持久化的“原子性/并发安全/版本冲突检测”主要由 server.js 保证
 
 ---

 ## 【批次 11】ALTER TABLE（Web 端）：匹配优先级、边界检查、典型报错与原因

 本批次目标：把 `executeAlterTable(sql)` 这一条“容易被追问的 DDL”讲透。

 ALTER TABLE 在本项目里不仅仅是“改 columns 数组”，还牵涉：

 - 外键约束的新增/删除
 - 删除列时的“是否被引用/是否属于外键列”检查
 - 修改列/重命名列后对数据行对象的同步更新
 - table-level storage 模式下的 metadata 落盘与 localStorage 同步

 ---

 ## 52. executeAlterTable 的匹配顺序（顺序决定语义）

 `executeAlterTable` 的结构是“按正则依次 match，命中即返回”，所以**写在前面的规则优先级更高**。

 代码中有两个很重要的“优先级注释”（决定你答辩时如何解释）：

 - `ALTER TABLE ADD FOREIGN KEY (必须在 ADD COLUMN 之前检查)`
 - `ALTER TABLE DROP FOREIGN KEY (必须在 DROP COLUMN 之前检查)`

 解释：

 - ADD FOREIGN KEY 的 SQL 形态也是 `ALTER TABLE ... ADD ...`，如果先匹配了 ADD COLUMN 的正则，可能会把“ADD FOREIGN KEY”误判成“ADD COLUMN”，造成逻辑错误
 - DROP FOREIGN KEY 同理：如果先匹配 DROP COLUMN，会把 `DROP FOREIGN KEY fk_xxx` 误当成要删列

 因此**优先匹配外键相关 ALTER 子句**是必须的。

 ---

 ## 53. ALTER TABLE ADD FOREIGN KEY：现有数据校验 + 默认 onDelete/onUpdate

 支持语法（正则语义）：

 - `ALTER TABLE t ADD [CONSTRAINT name] FOREIGN KEY(col) REFERENCES refTable(refCol) [ON DELETE ...] [ON UPDATE ...]`

 默认值：

 - `onDelete` 默认 `RESTRICT`
 - `onUpdate` 默认 `RESTRICT`

 关键检查点：

 1) 本表存在
 2) 本表外键列存在
 3) 引用表存在、引用列存在
 4) 本列是否已存在外键（同一列只允许一个外键）
 5) **校验现有数据满足外键约束**：
    - 取引用表数据 `refData`
    - 构造 `refValues = new Set(refData.map(r => r[refColumn]))`
    - 遍历本表每行：如果 `row[column]` 非空且不在 refValues 中，抛错：
      - `无法添加外键：现有数据 column=value 在 refTable.refColumn 中不存在`

 通过该策略，你可以在答辩中强调：

 - 本项目并非只保存元数据，而是保证“加入外键后数据库仍处于一致状态”。

 ---

 ## 54. ALTER TABLE DROP FOREIGN KEY：名称解析与大小写不敏感

 DROP FOREIGN KEY 的难点在于：

 - fk 可能没有显式 name
 - 代码支持两种 name 形式：
  - `fk.name`（如果存在）
  - 或默认命名：`fk_${tableName}_${fk.column}`

 删除时会把“解析后的名字”与用户输入 `fkName` 做 `toLowerCase()` 比较。

 典型报错：

 - `外键约束 'fkName' 不存在`

 ---

 ## 55. ALTER TABLE ADD COLUMN：只改 schema（不回填历史行）

 ADD COLUMN 做了：

 - `table.columns.push(newCol)`
 - `persistCurrentDbMetadata()`

 注意：

 - 这里没有对历史 `table.data`/`tableDataArray` 的每一行补齐该列
 - 因此历史行对新增列的读取通常会表现为 `undefined`（在 SELECT 投影时会被补成 `null`）

 这是一个可解释的简化点：

 - 真实数据库会把“缺失列”视为 NULL 或 DEFAULT
 - 本项目把该行为交给 SELECT 的投影阶段（缺失 -> null）

 ---

 ## 56. ALTER TABLE DROP COLUMN：最强约束路径（两类引用检查）

 DROP COLUMN 的安全性检查是本项目 DDL 的“重点答辩点”。

 它至少包含三类风险检查：

 ### 56.1 要删的列是否存在

 - `colIndex === -1` -> 报错：`列 'colName' 不存在`

 ### 56.2 列是否“自己就是外键列”（ownedFk）

 如果本表 `table.foreignKeys` 中存在 `fk.column == colName`：

 - 报错：
  - `无法删除列 'table.col'：该列存在外键约束 'fk_xxx'（请先 DROP FOREIGN KEY）`

 这对应数据库里常见的：

 - 先删约束，再删列

 ### 56.3 列是否“被其他表外键引用”（referencing）

 代码会遍历同库所有其他表的外键：

 - 如果 `fk.refTable == tableName && fk.refColumn == colName`
 - 把 `otherTableName.fk.column` 收集到数组 `referencing`

 如果 `referencing.length > 0`：

 - 报错：
  - `无法删除列 'table.col'：被外键引用（请先删除相关外键）: a.b, c.d`

 这对应数据库的“引用完整性”要求：

 - 被引用的列不能随意删除

 ### 56.4 真正执行删除：schema + 数据行对象同步

 通过检查后：

 - `table.columns.splice(colIndex, 1)`
 - 对每行数据：`delete row[colName]`
 - `persistCurrentDbMetadata()`

 这保证：

 - schema 与数据行对象保持一致

 ---

 ## 57. ALTER TABLE MODIFY COLUMN / RENAME COLUMN：只改元数据，不做强制类型转换

 ### 57.1 MODIFY COLUMN

 - 修改 `col.type` 与 `col.size`
 - 不会把历史数据强制转换（仍保留原值）

 ### 57.2 RENAME COLUMN

 - 修改 `col.name = newColName`
 - 遍历每行：
  - `row[newColName] = row[oldColName]`
  - `delete row[oldColName]`

 典型报错：

 - `列 'old' 不存在`
 - `列 'new' 已存在`

 ---

 ## 【批次 12】CLI vs Web：行为一致性差异清单（答辩可用的“对比表”口径）

 本批次目标：把 CLI 与 Web 的差异讲清楚，避免答辩时被问到“为什么 CLI/网页不一样”。

 ---

 ## 58. 数据与落盘模型差异：Web 是 table-level 懒加载 + server API，CLI 是本地全量加载 + 直接写文件

 ### 58.1 Web

 - `databases` 主要承载 schema（columns/foreignKeys/indexes）
 - 表数据走 `tableData[db.table]` 缓存，并通过 `/api/table-data` 懒加载
 - 表写入走 `/api/save-table`（包含 expectedVersion，用于 409 冲突检测）
 - 元数据写入走 `/api/save-metadata`

 ### 58.2 CLI

 - 启动时 `loadData()` 会扫描 `data/*_metadata.json`，并把每张表文件 `data/<db>_<table>.json` 一并读入内存
 - 表写入直接 `fs.writeFileSync`（通过内部 `persistTable/saveTableData` 等封装）
 - 元数据写入直接 `saveMetadata/persistDbMetadata`
 - CLI 自己维护 `locks/` 锁文件（`acquireTableLock/releaseTableLock`）

 ---

 ## 59. SQL 拆分差异：Web split(';')，CLI splitStatements（引号感知）

 该点已在批次 10 说明，这里补一条“答辩总结句”：

 - **CLI 的拆分策略更健壮**，Web 应复用 CLI 的状态机拆分算法以保证一致性。

 ---

 ## 60. SELECT 的索引加速：Web 有 tryApplyIndexWhere，CLI 当前没有

 Web 的 SELECT WHERE 会先：

 - `tryApplyIndexWhere(table, tableDataArray, whereClause)` 预过滤

 CLI 的 SELECT WHERE 当前是：

 - `data = data.filter(row => evaluateWhere(row, whereClause))`

 这导致：

 - Web 端能展示 `使用索引: idx_xxx`
 - CLI 端同一条查询即使存在索引，也不会走索引候选集优化

 这就是“功能一致性（feature parity）”上最明显的差异之一。

 ---

 ## 61. 索引 key 规则差异（NULL/大小写/字段取值）

 Web 端索引构建与重建使用：

 - `getRowValueCaseInsensitive(row, col)`（大小写不敏感）
 - `null/undefined -> ''`（空串）

 CLI 的 `executeCreateIndexCli` 使用：

 - `row[c]` 直接取值（大小写敏感）
 - key = `columns.map(c => row[c]).join('|')`（未做 null->'' 的统一）

 因此在一些极端场景下：

 - 两端的 `indexes.data` 可能对同一份数据产生不同 key
 - 进一步导致“索引命中/索引展示”行为不一致

 ---
 
 ## 62. 事务与版本号差异：Web 强依赖 tableVersions + server 409，CLI 自己维护 tableVersions

 Web：

 - `tableVersions` 来自 `/api/databases` 扫描或 `/api/table-data` 返回
 - 写表时传 expectedVersion，后端冲突返回 409
 - Web 的 COMMIT 会把 modifiedTables 逐个写入，遇到冲突会提示刷新

 CLI：

 - `tableVersions` 来自读取表文件中的 `version`
 - COMMIT 时也会把 expectedVersion 传给内部 `saveTableData`
 - 但冲突语义主要在 CLI 自己的锁/版本逻辑中实现，不经过 HTTP

 ---
 
 ## 【批次 13】备份/恢复（server.js）：snapshot 格式、merge+rename 算法、外键引用更新

 本批次目标：把 `/api/backup` 与 `/api/restore` 的实现讲到“你能用它在答辩里回答追问”。

 你需要在答辩里讲清楚的关键点是：

 - 备份输出的 snapshot 格式是什么（字段是什么，为什么这么设计）
 - 恢复为什么只支持 merge+rename（简化策略）
 - 冲突时如何改名（数据库/表）
 - 改名后如何保证外键仍然指向正确目标（更新 fk.refTable）
 - 写入表文件时如何保证并发安全（表级锁）

 ---
 
 ## 63. /api/backup：导出 v2.0 快照（scope=all / scope=db）

 路由：

 - `GET /api/backup?scope=all`
 - `GET /api/backup?scope=db&database=<db>`

 ### 63.1 snapshot 顶层结构

 后端返回的不是 `{success:true,...}` 包装，而是直接返回 snapshot JSON：

 - `version: '2.0'`
 - `exportTime: <ISO>`
 - `scope: { type: 'all' }` 或 `{ type: 'db', database }`
 - `databases: { [dbName]: metadata }`
 - `tableData: { [db.table]: { version, data } }`
 - `tableVersions: { [db.table]: version }`

 这套结构的目的非常明确：

 - `databases`：存 schema（columns/foreignKeys/indexes）
 - `tableData`：存行数据 + 版本号
 - `tableVersions`：为快速校验/对齐提供一份冗余索引

 ### 63.2 scope=db 的校验

 当 `scope=db`：

 - 如果没传 `database`：400
 - 如果 `<db>_metadata.json` 不存在：404

 这保证了：

 - 只对“真实存在的数据库”导出

 ### 63.3 数据来源与一致性

 对每个 db：

 - 读 `<db>_metadata.json` 得到 metadata
 - 遍历 metadata.tables 的表名列表
 - 逐表读 `<db>_<table>.json`，构造 `tableData[db.table]`

 注意：

 - backup 完全以磁盘文件为准，不依赖 app.js 内存
 - 因此“备份一致性”由写入侧（save-table 的锁/版本）保证

 ---
 
 ## 64. /api/restore：只支持 mode=merge&conflict=rename

 路由：

 - `POST /api/restore?mode=merge&conflict=rename`

 服务器在入口处直接限制：

 - 只接受 `mode=merge` 且 `conflict=rename`
 - 其他组合返回 400：`仅支持 mode=merge&conflict=rename`

 这是一种很典型的课程设计取舍：

 - 真实数据库的导入策略非常复杂（覆盖/跳过/交互式映射/冲突合并等）
 - 本项目选择“永远不覆盖旧数据”，全部通过重命名规避冲突

 ---
 
 ## 65. merge+rename 的核心算法（逐步骤）

 恢复入口把 incoming snapshot 拆成两部分：

 - `incomingDbs = snapshot.databases || {}`
 - `incomingTableData = snapshot.tableData || {}`

 并准备两个“最终给前端展示的改名映射”：

 - `renamedDatabases: { srcDbName -> targetDbName }`
 - `renamedTables: { targetDbName -> { srcTableName -> targetTableName } }`

 ### 65.1 数据库名冲突处理：makeUniqueName

 先扫描当前磁盘现有 db：

 - `existingDbs = new Set(listDatabasesFromMetadataFiles())`

 对每个 incoming db：

 - `targetDbName = makeUniqueName(srcDbName, existsFn)`
 - 如果发生改名：记录到 `renamedDatabases`
 - 将 `targetDbName` 加入 existingDbs（避免后续冲突）

 解释：

 - 这一步保证：导入永远不会覆盖已有数据库

 ### 65.2 表名冲突处理：对每个 targetDbName 内建立 tableRenameMap

 读取当前磁盘已有 metadata（如果没有则当作空库）：

 - `existingMeta = readJsonIfExists(getMetadataFile(targetDbName), ...).metadata || { tables:{} }`
 - `existingTables = new Set(Object.keys(existingMeta.tables || {}))`

 对 incoming 的每张表：

 - `targetTableName = makeUniqueName(srcTableName, existsFn)`
 - 若改名：
   - 记录到 `renamedTables[targetDbName][srcTableName]`
   - 同时写入 `tableRenameMap[srcTableName] = targetTableName`
 - 把 `tableMeta` 深拷贝进 `outTables[targetTableName]`

 ### 65.3 关键步骤：更新外键引用 fk.refTable

 这一步是“答辩最值钱的细节”：

 - 如果在同一库内重命名了某张表
 - 那么导入元数据中所有外键 `fk.refTable` 指向旧表名的必须同步更新

 实现逻辑：

 - 遍历 `outTables` 里每张表的 `foreignKeys`
 - 若 `fk.refTable` 在 `tableRenameMap` 中，则替换成新表名

 这样保证：

 - “表重命名”不会造成外键悬空

 备注：

 - 该实现只处理“同库内的引用表重命名”（符合项目的建模方式）

 ### 65.4 合并元数据并写入 `<db>_metadata.json`

 生成 outMeta：

 - `outMeta.tables = { ...(existingMeta.tables || {}) }`
 - 再把 `outTables` 覆盖进去：`outMeta.tables[tName] = tMeta`

 最后写入：

 - `fs.writeFileSync(getMetadataFile(targetDbName), JSON.stringify({ metadata: outMeta }, null, 2))`

 解释：

 - 旧表保留
 - 新导入表追加
 - 同名冲突已通过 rename 避免

 ### 65.5 写表文件 `<db>_<table>.json`（表级锁 + 版本号）

 对每个 src table：

 - `srcKey = srcDb.srcTable`
 - `payload = incomingTableData[srcKey] || { version:null, data:[] }`

 生成 outPayload：

 - `version = payload.version ?? null`
 - `data = payload.data || []`

 最终写盘版本：

 - `const version = outPayload.version || new Date().toISOString();`

 写盘前的并发保护：

 - `acquireTableLock(targetDbName, targetTableName)`
 - 成功后写 `fs.writeFileSync(getTableFile(...), JSON.stringify({ version, data }, null, 2))`
 - finally `releaseTableLock(...)`


典型 409：

 - 如果表被锁（例如另一个窗口正在写同名目标表），restore 会返回 409 并终止。

 ---
 
 ## 【批次 14】并发控制与读一致性：锁文件、409、tableVersions、read freshness

 本批次目标：把“为什么不会互相覆盖、为什么能检测到过期数据”讲成端到端闭环。

 ---
 
 ## 66. server.js 表级锁：locks/<db>_<table>.lock

 ### 66.1 加锁协议（acquireTableLock）

 核心做法：

 - lockFile 路径：`data/locks/<db>_<table>.lock`
 - 用 `fs.writeFileSync(lockFile, pid, { flag: 'wx' })` 原子创建
 - 如果已存在（EEXIST）：
   - 若 lock 文件 mtime 超过 5s：认为 stale lock，删除并重试
   - 否则 busy-wait 10ms 再继续循环
 - 超时时间默认 3000ms，超时返回 false

 这套机制可以用数据库术语解释为：

 - 简化的“表级互斥锁”（mutex），用文件系统做锁载体
 - stale lock 清理相当于“死锁/异常退出的锁回收”

 ### 66.2 释放锁（releaseTableLock）

 - `fs.unlinkSync(lockFile)`

 解释：

 - 锁是“存在即持有”的状态

 ---
 
 ## 67. 乐观锁：expectedVersion 与 409 冲突

 ### 67.1 写入端：/api/save-table

 前端在写表时会发送：

 - `expectedVersion`：客户端认为的当前版本
 - `version`：本次要写入的新版本（ISO 时间戳）

 后端在写之前读取磁盘 existing.version 并比较：

 - 如果 `existing.version !== expectedVersion`：返回 409
 - 同时返回 `serverVersion/clientVersion` 便于前端提示

 这解决了一个典型问题：

 - 两个窗口同时修改同一表
 - 如果没有版本检查，后写入者会覆盖前写入者（lost update）

 ### 67.2 读一致性：tableVersions 的来源

 Web 端的 `tableVersions` 主要来自：

 - `/api/databases`：扫描所有表文件里的 version
 - `/api/table-data`：读表时返回 version
 - `/api/save-table`：写成功后把 newVersion 写回到 `tableVersions[db.table]`

 CLI 端的 `tableVersions` 则来自：

 - 启动加载表文件时读取 version
 - 以及每次写文件时同步更新

 ---
 
 ## 68. 读新鲜度检查：app.js ensureReadFreshTableLevel

 Web 端为了避免“读到过期缓存”，在**纯读查询且不在事务中**会主动做 read freshness：

 - 解析本次 statements 中涉及的表（SELECT FROM + JOIN + DESC）
 - 对每个表调用 `/api/table-version/<db>/<table>` 获取 serverVer
 - 如果 `serverVer !== localVer(tableVersions)`：直接抛错
   - `数据已过期：检测到其他窗口已提交更新，请刷新页面后再查询`

 这是一个很适合答辩的点：

 - 没有实现复杂的隔离级别/MVCC
 - 但用版本号做了“读一致性提示”，避免用户误以为读到的是最新

 ---
 
 ## 【批次 15】data/ 真实样例库逐文件解释（test1 / ecommerce / school）
 
 本批次目标：把 `minisql_web/data/` 中的样例库文件讲清楚——你可以在答辩时直接打开这些 JSON 文件，并说明：
 
 - 哪个文件代表元数据（schema）
 - 哪些文件代表表数据（含 version）
 - foreignKeys / indexes 在文件里如何体现
 - 这些文件如何被 Web/CLI 读取并参与执行
 
 ---
 
 ## 69. data/ 目录的“分库分表”文件命名规则（再强调一次）
 
 1) 数据库元数据：
 
 - `data/<db>_metadata.json`
 
 内容结构是：
 
 - `{ "metadata": { "tables": { ... } } }`
 
 2) 表数据文件：
 
 - `data/<db>_<table>.json`
 
 内容结构是：
 
 - `{ "version": "...", "data": [ ... ] }`
 
 其中：
 
 - `version` 是“乐观锁版本号”
 - `data` 是“行数组”（每行是一个对象）
 
 ---
 
 ## 70. test1：带外键但无索引的“基础演示库”
 
 ### 70.1 test1_metadata.json（schema）
 
 test1 的 `metadata.tables` 包含（至少）：
 
 - `users`
 - `products`
 - `orders`
 - `employees`
 - `customers`
 
 其中最重要的是 `orders` 表的外键：
 
 - `fk_orders_user_id`: `orders.user_id -> users.id`
 - `onDelete/onUpdate = RESTRICT`
 
 这意味着：
 
 - 插入 orders 时会检查 user_id 必须在 users.id 中存在（若非空）
 - 删除 users 中被引用的 id，会被 RESTRICT 阻止（Web 端 DELETE 的 onDelete 处理会抛错）
 
 注意一个“课程设计口径可讲”的细节：
 
 - `orders` 表里虽然有 `product_id` 字段，但元数据里并没有给它配置外键（这是一种“只做部分约束”的示例库）
 
 ### 70.2 test1_users.json（数据文件）
 
 数据特征：
 
 - 有 3 行用户（id=1..3）
 - `email` 字段允许 null（第二行 email 为 null）
 - `status/city/country` 是典型的 VARCHAR 字段示例
 
 这份数据适合演示：
 
 - `WHERE email IS NULL`
 - `LIKE` / `IN` / `BETWEEN`
 
 ### 70.3 test1_products.json（数据文件）
 
 数据特征：
 
 - 有 5 个商品
 - `category_id`/`category` 字段存在，但 test1 库里没有 categories 表
 
 因此它更像是：
 
 - 一个“包含冗余字段”的示例（category 是反范式字段）
 
 ### 70.4 test1_orders.json（数据文件 + 外键演示）
 
 关键演示点：
 
 - orders 里有 user_id=1/2
 - 与 test1_users.json 对照可以说明外键为什么能通过
 
 例如：
 
 - `id=1` 的订单引用 `user_id=1`（users 表存在 id=1）
 - `id=2` 的订单引用 `user_id=2`（users 表存在 id=2）
 
 ---
 
 ## 71. ecommerce：多表外键链路完整，但当前数据文件为空（适合“自己插入演示”）
 
 ### 71.1 ecommerce_metadata.json（schema）
 
 ecommerce 典型表：
 
 - `users`
 - `categories`
 - `products`
 - `orders`
 - `order_items`
 - `reviews`
 
 外键关系是“电商课设的标准模型”：
 
 - `products.category_id -> categories.id`
 - `orders.user_id -> users.id`
 - `order_items.order_id -> orders.id`
 - `order_items.product_id -> products.id`
 - `reviews.user_id -> users.id`
 - `reviews.product_id -> products.id`
 
 这套 schema 非常适合在答辩中展示：
 
 - “外键引用存在性校验”
 - “删除时 RESTRICT”
 - “JOIN 查询”
 
 ### 71.2 ecommerce_* 表文件：为什么 data 为空但 version 存在
 
 你会看到多个 `ecommerce_*.json` 的内容形如：
 
 - `{ "version": "2026-01-13T07:13:26.069Z", "data": [] }`
 
 解释：
 
 - 这些表文件已经创建并落盘了（所以有 version）
 - 但当前没有插入数据（所以 data 数组为空）
 
 这在课程设计里是常见场景：
 
 - 你可以用 SQL 在答辩现场“从空库开始插入数据”，演示外键与 JOIN
 
 ### 71.3 ecommerce.products 中一个异常字段：`g`
 
 metadata 里 products 表出现了一个字段：
 
 - `name: "g"`、type VARCHAR(50)
 - 且该字段对象没有 `default/autoIncrement` 等完整属性
 
 这意味着：
 
 - 元数据结构允许“字段对象不完全一致”（课程设计实现对缺失字段会按 undefined 处理）
 - 也暗示了：该库可能经历过调试/手工改动/版本演进
 
 答辩口径：
 
 - “schema 字段结构允许可选属性缺失，不影响基本执行；如果要更严谨可在保存元数据时做 schema normalize。”
 
 ---
 
 ## 72. school：包含真实索引 data 的样例库（非常适合展示索引命中与边界）
 
 ### 72.1 school_metadata.json（schema）
 
 school 库包含：
 
 - `students(id,name,age)`
 - `classes(id,title)`
 - `enrollments(id,student_id,class_id)`
 
 外键：
 
 - `enrollments.class_id -> classes.id`
 - `enrollments.student_id -> students.id`
 
 索引：
 
 - `students` 表存在 `idx_name`（列：name）
 - 且 `idx_name.data` 在 metadata 文件中真实保存了“值 -> 行下标列表”映射
 
 这意味着：
 
 - school 是一个“索引可直接从 metadata 文件展示出来”的样例库
 
 ### 72.2 school_students.json（数据文件）与“主键缺失行”的边界
 
 `school_students.json` 的行数据中，你会看到：
 
 - 第一行有 `id: 2`
 - 后续多行只有 `name/age`，缺失 id
 
 结合 schema：
 
 - students.id 是 primaryKey=true
 - 但 `notNull=false` 且 `autoIncrement=false`
 
 结合执行器语义（见前文主键唯一性校验）：
 
 - 主键唯一性检查会跳过 `null/undefined` 的 pk 值
 - 因此“未填写 id 的行”不会触发 pk 冲突
 
 答辩解释建议：
 
 - “该样例库包含一些调试/事务/锁测试过程中插入的行，部分行主键缺失体现了当前实现对 `NULL PK` 的容忍策略；若课程要求更严格，可在 schema 层设置 NOT NULL 或在插入时强制主键非空。”
 
 ### 72.3 school_metadata.json 的 idx_name.data：如何对应到 data 数组行下标
 
 `idx_name.data` 里有大量 key，例如：
 
 - `"李四": [0]`
 - `"回滚测试": [18,20,21]`
 - `"value1": [52,53,54,55,56,57]`
 
 解释：
 
 - 这些数组元素是 rowIndex（行下标）
 - rowIndex 对应 `school_students.json` 的 `data[i]`
 
 因此你可以在答辩现场这样演示索引：
 
 - 先打开 `school_students.json`，找到某个 name
 - 再打开 `school_metadata.json`，找到 idx_name.data[name]
 - 说明索引如何“直接定位候选行集合”
 
 ### 72.4 school_enrollments.json：外键列允许 null（FK 只在非空时校验）
 
 enrollments 的数据里有：
 
 - `student_id: null`
 - `class_id: 1/2`
 
 这在本项目中是允许的，因为外键检查逻辑是：
 
 - 只有当 `fk.column` 的值非 `null/undefined` 时才做引用存在性校验
 
 因此 `student_id=null` 不会触发约束错误。
 
 ---
 
 <!-- DETAIL_MD_APPEND_MARKER -->
 
 下一批将继续补齐：
 
 1. （可选）README/README_DESIGN 增加 detail.md 入口 + 推荐答辩演示顺序
 2. 全局一致性问题清单：Web/CLI/文件快照三方在极端边界下的行为对照（答辩 Q&A 版)
 3. （可选）补充 idx_test / test 等其他样例库文件说明（若你需要把 data/ 全部讲完)
