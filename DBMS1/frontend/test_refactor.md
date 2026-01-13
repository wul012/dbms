# 重构测试清单

## 已完成的修改

### ✅ 核心函数已改为异步
1. `executeInsert` - 使用 `await getTableData()`
2. `executeSelect` - 使用 `await getTableData()`
3. `executeUpdate` - 使用 `await getTableData()`
4. `executeDelete` - 使用 `await getTableData()`
5. `executeTruncate` - 使用 `await getTableData()`
6. `executeCreateIndex` - 使用 `await getTableData()`
7. `executeJoinSelect` - 使用 `await getTableData()`
8. `executeAlterTable` - 外键验证部分使用 `await getTableData()`
9. `executeCreateTable` - 初始化空表数据
10. `executeDropTable` - 删除表数据和版本号

### ✅ 事务处理已更新
1. `executeBegin` - 快照包含 databases 和 tableData
2. `executeCommit` - 保存所有修改的表
3. `executeRollback` - 恢复 databases 和 tableData

### ✅ 主执行函数已更新
1. `executeSQL` - 跟踪修改的表并保存
2. 保存元数据（表结构变更时）
3. 保存表数据（数据变更时）

### ✅ UI 函数已更新
1. `renderTableList` - 使用 tableData 显示行数
2. `updateStorageInfo` - 计算已加载的表数据大小
3. `showERDiagram` - 使用 tableData 显示行数

## 测试步骤

### 1. 启动新服务器
```bash
node server_new.js
```

### 2. 打开浏览器
访问 http://localhost:8080

### 3. 测试基本功能

#### 测试1：查看数据库列表
- 应该看到 school 和 ecommerce 两个数据库
- 点击 school，应该看到 3 个表（students, classes, enrollments）
- 表名旁边显示 "?" 或行数（如果已加载）

#### 测试2：查询数据（按需加载）
```sql
SELECT * FROM students LIMIT 10;
```
- 第一次查询会加载表数据
- 控制台应该显示：✅ 表数据已加载: school.students, XX 行
- 查询结果应该显示数据
- 表名旁边的行数应该从 "?" 变为实际数字

#### 测试3：插入数据
```sql
INSERT INTO students (id, name, age) VALUES (100, '测试用户', 25);
```
- 应该成功插入
- 控制台应该显示：✅ 表数据已保存: school.students
- 再次查询应该能看到新数据

#### 测试4：更新数据
```sql
UPDATE students SET age = 26 WHERE id = 100;
```
- 应该成功更新
- 控制台应该显示保存信息

#### 测试5：删除数据
```sql
DELETE FROM students WHERE id = 100;
```
- 应该成功删除
- 控制台应该显示保存信息

#### 测试6：事务
```sql
BEGIN;
INSERT INTO students (id, name, age) VALUES (101, '事务测试', 30);
SELECT * FROM students WHERE id = 101;
ROLLBACK;
SELECT * FROM students WHERE id = 101;
```
- BEGIN 后应该显示 "🔒 事务进行中"
- 第一次 SELECT 应该能看到数据
- ROLLBACK 后第二次 SELECT 应该看不到数据

#### 测试7：并发冲突（表级）
1. 打开两个浏览器窗口
2. 窗口A：`SELECT * FROM students LIMIT 10;`（加载数据）
3. 窗口B：`SELECT * FROM students LIMIT 10;`（加载数据）
4. 窗口A：`INSERT INTO students (id, name, age) VALUES (102, 'A', 20);`
5. 窗口B：`INSERT INTO students (id, name, age) VALUES (103, 'B', 21);`
6. 窗口B 应该显示冲突错误："数据冲突：其他进程已修改此表"

#### 测试8：不同表不冲突
1. 打开两个浏览器窗口
2. 窗口A：修改 students 表
3. 窗口B：修改 classes 表
4. 两个窗口都应该成功（不冲突）

#### 测试9：ER 图
- 点击 "📊 ER图" 按钮
- 应该显示表结构和外键关系
- 表名旁边显示行数（已加载的显示数字，未加载的显示 "?"）

#### 测试10：创建新表
```sql
CREATE TABLE test_table (
    id INT PRIMARY KEY,
    name VARCHAR(50)
);
```
- 应该成功创建
- 控制台应该显示：✅ 元数据已保存: school
- 表列表应该显示新表，行数为 0

### 4. 检查文件结构
打开 data 目录，应该看到：
- `school_metadata.json` - 元数据
- `school_students.json` - students 表数据
- `school_classes.json` - classes 表数据
- `school_enrollments.json` - enrollments 表数据
- `ecommerce_metadata.json` - 元数据
- `ecommerce_*.json` - 各表数据

### 5. 检查版本号
打开任意表数据文件（如 `school_students.json`），应该看到：
```json
{
  "version": "2026-01-13T...",
  "data": [...]
}
```

## 预期行为

### 内存占用
- 页面加载时：只加载元数据（几KB）
- 第一次查询表时：加载该表数据
- 未查询的表：不占用内存

### 网络传输
- 初始加载：只传输元数据
- 查询时：只传输需要的表数据
- 保存时：只传输修改的表数据

### 并发控制
- 修改不同表：不冲突 ✅
- 修改同一表：检测冲突 ✅
- 表级版本号：精确控制

## 常见问题

### Q: 表名旁边显示 "?"
A: 正常，表示该表数据尚未加载。第一次查询后会显示实际行数。

### Q: 控制台显示 "表数据已加载"
A: 正常，这是按需加载的日志信息。

### Q: 保存时提示冲突
A: 其他窗口已修改该表，刷新页面后重试。

### Q: 某些表数据丢失
A: 检查 data 目录下是否有对应的表数据文件。

## 回滚方案

如果出现问题：
```bash
# 1. 停止新服务器
# 2. 恢复旧数据
cp data/minisql_data_backup.json data/minisql_data.json
# 3. 启动旧服务器
node server.js
```
