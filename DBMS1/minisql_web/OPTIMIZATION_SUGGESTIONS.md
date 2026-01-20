# MiniSQL 项目优化建议（OPTIMIZATION_SUGGESTIONS.md）

> 本文档基于对 `minisql_web` 全量代码（`app.js/server.js/cli.js/index.html/styles.css/migrate_data.js`）的通读与对现有行为的推导，整理出“可落地、可解释、可答辩”的优化建议清单。
>
> 文档目标：
>
>- 明确指出当前实现存在的**功能缺口/一致性风险/边界问题**
>- 给出**可执行的优化方案**（包含推荐的改动位置、改动粒度、风险与验证方式）
>- 为后续迭代提供路线图（按优先级分层）

---

## 0. TL;DR（最高优先级结论）

1) **修复/补齐“绑定本地文件”功能入口**：`index.html` 里存在 `onclick="bindLocalFile()"`，但 `app.js` 中未找到该函数定义；同时 `app.js` 内确实存在 `fileHandle` + `writeBoundFileSnapshot(...)` 写回逻辑。建议要么补齐实现，要么移除入口/改名对齐。

2) **统一 SQL 语句拆分逻辑**：Web 端 `executeSQL()` 使用 `sql.split(';')`，对引号内 `;` 无法正确处理；CLI 端已有更健壮的 `splitStatements()`（支持引号）。建议 Web 端复用同样算法。

3) **增强 CREATE TABLE 字段解析**：`parseColumnDefinitions(def)` 用 `def.split(',')`，当列定义里出现复杂语法/嵌套括号或将来扩展时易错误。建议做“括号/引号感知”的分割器。

4) **表数据缓存与 UI 行数显示一致性**：表级存储模式下，`databases[db].tables[t].data` 与 `tableData[db.t].data` 可能不同步，导致 UI 行数/ER 图行数展示偏差。建议统一“表数据权威来源”。

---

## 1. 功能缺口与一致性问题（建议优先修）

### 1.1 `bindLocalFile()` 入口缺失（高优先级）

#### 现象

- `index.html` 工具栏按钮：

  - `onclick="bindLocalFile()"`

- `app.js` 中：

  - 存在 `let fileHandle = null;`
  - 多处写入成功后会执行：

    - `if (fileHandle) writeBoundFileSnapshot({ scope: 'all' })`

- 但通过全文检索未发现 `bindLocalFile` 函数实现。

#### 风险

- UI 有按钮但点击会报错（控制台 `bindLocalFile is not defined`）
- 使“绑定本地文件并自动写回”这一亮点无法在答辩中稳定展示

#### 建议方案 A（补齐实现，推荐）

在 `app.js` 增加 `async function bindLocalFile()`：

- 使用 File System Access API：
  - `window.showSaveFilePicker()` 或 `showOpenFilePicker()`
- 保存到 `fileHandle`
- 首次绑定后立即写出一份 snapshot（`writeBoundFileSnapshot({ scope: 'all' })`）
- 更新状态栏 `storage-info` 显示文件名（现有 `updateStorageInfo()` 已支持）

#### 建议方案 B（移除入口或改名对齐）

若你不想引入 File System Access API（兼容性问题）：

- 移除 `index.html` 的绑定按钮
- 或把 `onclick` 改为现有函数（若项目里已有替代入口）

#### 验证方式

- 点击“📂 绑定本地文件”不报错
- 绑定后执行 `CREATE DATABASE/INSERT/...`，观察本地文件内容随之更新

---

### 1.2 Web 端 SQL 拆分不支持引号（高优先级）

#### 现象

- Web：`executeSQL()` 里 `sql.split(';')`
- CLI：`splitStatements(sqlText)` 支持引号状态机（不会把字符串里的 `;` 当分隔符）

#### 风险

- 例如：

  - `INSERT INTO t (name) VALUES ('a;b');`

  在 Web 端会被错误拆分，导致语法错误或数据错误。

#### 建议方案

- 把 CLI 的 `splitStatements()` 复制/抽取到 Web 端并复用
- 或写一个公共模块（课程设计可不拆模块，但逻辑应一致）

#### 验证方式

- 在 Web UI 里执行包含字符串 `;` 的 INSERT
- 确认只执行一条语句且结果正确

---

### 1.3 表数据缓存一致性（中高优先级）

#### 现象

- 表级存储模式：

  - 表数据主要通过 `tableData[db.table]` 管理
  - 但一些 UI（例如 ER 图卡片显示行数、table list 行数）可能使用 `table.data.length`

#### 风险

- UI 展示与真实数据不一致（尤其是首次懒加载后、或事务回滚后）
- 容易在答辩时被追问“为什么行数不对”

#### 建议方案

- 定义一个“权威读取函数”例如 `getTableRowCount(db, table)`：
  - 若 `tableData` 已加载则用 `tableData[db.table].data.length`
  - 否则可显示 `?` 或触发懒加载后显示
- 或在每次 `loadTableData()` 后同步 `databases[db].tables[table].data = tableData[db.table].data`（目前已有类似同步，但要保证所有路径一致）

---

## 2. SQL 语法与解析改进建议

### 2.1 CREATE TABLE 列定义分割器（中优先级）

#### 现状

- `parseColumnDefinitions(def)` 用 `def.split(',')`

#### 风险

- 遇到更复杂的语法（比如将来扩展 CHECK、复杂 DEFAULT、或更复杂 REFERENCES）会误拆分

#### 建议

- 写一个“括号/引号感知”的 `splitByCommaTopLevel(def)`
- 规则：括号深度 >0 或在引号内时不拆分

### 2.2 统一正则解析与错误提示（中优先级）

建议把每条 SQL 的正则与“格式提示”集中维护：

- 可以在 `detail.md`/`README_DESIGN.md` 中列出
- 也可以在代码里维护一个 `SQL_SYNTAX_HELP` 映射，提升一致性

---

## 3. 索引系统优化建议

### 3.1 索引数据维护策略（中优先级）

当前策略：写操作后全量 `rebuildIndexDataForTable()`。

优点：

- 实现简单
- 不容易出错

缺点：

- 大表下 O(n) 重建成本高

可选优化：

- 增量维护（INSERT/DELETE/UPDATE 时只更新相关 key 的 rowIndex 列表）
- 但要注意：当前索引存的是 rowIndex，DELETE 会导致索引中的 rowIndex 全部偏移，增量维护会复杂得多

建议（课程设计答辩口径）：

- 保留全量重建，并在文档中说明“为保证正确性、简化实现，采用全量重建；性能优化属于后续工作”。

### 3.2 索引加速查询扩展（中优先级）

当前只支持：

- `WHERE col = value`
- `WHERE col IN (...)`

可扩展方向：

- `AND` 的简单合取（两个等值条件分别命中索引后求交集）
- 多列索引的前缀匹配
- 范围查询（需要 BTree 有序结构，而当前是 hash-map 模拟）

---

## 4. 外键系统优化建议

### 4.1 UPDATE 时外键一致性（中优先级）

观察：

- DELETE 已实现 onDelete 的 RESTRICT/SET NULL/CASCADE 链式处理
- UPDATE 是否应支持 onUpdate 的 CASCADE/SET NULL/RESTRICT，需要统一口径

建议：

- 若课程要求包含 onUpdate：在 `executeUpdate` 中对被更新的“被引用列”进行级联处理
- 若不实现：在文档里明确“onUpdate 当前仅保存元数据/展示，未实现级联语义”

---

## 5. 并发控制与事务优化建议

### 5.1 读一致性策略（中优先级）

当前策略：

- 纯读查询时，Web 端可调用 `/api/table-version` 比对版本号，发现过期则抛错提示刷新

建议：

- 为更好的 UX：提供“自动刷新并重试”的选项（按钮/弹窗）
- 或提供“强制覆盖提交”的开关（已存在 409 冲突提示，可扩展）

### 5.2 事务隔离级别声明（文档层，建议补充）

建议在文档中明确：

- 当前事务是“单客户端内存快照 + 延迟提交”
- 不提供 MVCC/锁升级/隔离级别

---

## 6. 可维护性与工程化建议

### 6.1 抽取公共逻辑（Web 与 CLI）

重复逻辑包括：

- WHERE 求值
- 聚合
- JOIN
- SQL 拆分

建议：

- 抽取到 `core/` 模块（例如 `core/sql.js`）
- 但课程设计也可以只在文档里说明“CLI 与 Web 为两份实现，保持功能一致但代码存在重复”

### 6.2 增加最小测试脚本（加分项）

- 以 Node 脚本方式跑一组 SQL（DDL/DML/索引/外键/事务/备份恢复）
- 输出对比结果

---

## 7. 建议的迭代路线图

- **P0（马上修，答辩风险最高）**
  - bindLocalFile 入口缺失
  - Web SQL 拆分不支持引号
  - UI 行数一致性

- **P1（增强体验/稳定性）**
  - CREATE TABLE/ALTER TABLE 的更健壮解析
  - onUpdate 语义统一
  - 自动刷新/重试的 UX

- **P2（性能/工程化）**
  - 抽取公共模块
  - 增量索引（可选）
  - 自动化测试
