# MiniSQL 数据库管理系统

> 数据库原理课程设计项目 - 基于 Web 的轻量级数据库管理系统

## 📋 项目概述

MiniSQL 是一个完整的数据库管理系统，支持：
- **Web图形界面** - 可视化操作数据库、表、外键
- **命令行工具** - 支持交互式和批量执行SQL
- **标准SQL语法** - DDL/DML/事务/索引/外键约束
- **ER图可视化** - 自动生成实体关系图
- **乐观锁机制** - 多进程并发写入冲突检测
- **数据持久化** - JSON文件存储，支持导入导出

---

## 🚀 快速开始

### 环境要求
- **Node.js** 14+
- **浏览器** Chrome 86+ / Firefox / Edge

### 启动Web服务器

```bash
cd frontend
node server.js
```

访问: **http://localhost:8080**

### 命令行工具

```bash
# 交互模式
node cli.js

# 指定数据库
node cli.js -d testdb

# 直接执行SQL
node cli.js -e "SHOW DATABASES"
node cli.js -d testdb -e "SELECT * FROM users"
```

### 数据存储

```
frontend/data/minisql_data.json
```

### 示例数据库（README 可直接运行）

项目默认数据文件中已预置示例数据库 **test1**（包含 `users/products/orders/employees/customers` 等表及少量样例数据）。

运行 README 中的查询示例前，请先执行：

```sql
USE test1;
```

---

## ✨ 功能特性

### 1. DDL (数据定义语言)

| 命令 | 语法 | 说明 |
|------|------|------|
| 创建数据库 | `CREATE DATABASE db_name;` | 创建新数据库 |
| 删除数据库 | `DROP DATABASE db_name;` | 删除数据库及所有表 |
| 切换数据库 | `USE db_name;` | 切换当前数据库 |
| 查看数据库 | `SHOW DATABASES;` | 列出所有数据库 |
| 创建表 | `CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(50));` | 创建表 |
| 删除表 | `DROP TABLE t;` | 删除表 |
| 重命名表 | `RENAME TABLE old TO new;` | 重命名表 |
| 查看表 | `SHOW TABLES;` | 列出当前库所有表 |
| 表结构 | `DESC table_name;` | 查看表结构 |

### 2. ALTER TABLE (表结构修改)

```sql
-- 添加字段
ALTER TABLE users ADD email VARCHAR(100);

-- 删除字段
ALTER TABLE users DROP COLUMN email;

-- 修改字段类型
ALTER TABLE users MODIFY name VARCHAR(200);

-- 重命名字段
ALTER TABLE users RENAME COLUMN name TO username;
```

### 索引管理

```sql
-- 创建普通索引
CREATE INDEX idx_name ON users (name);

-- 创建唯一索引
CREATE UNIQUE INDEX idx_email ON users (email);

-- 创建复合索引
CREATE INDEX idx_city_age ON users (city, age);

-- 查看表的索引
SHOW INDEXES FROM users;

-- 删除索引
DROP INDEX idx_name ON users;
```

### 外键约束

```sql
-- 创建表时定义外键
CREATE TABLE orders (
    id INT PRIMARY KEY,
    user_id INT,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 或使用内联语法
CREATE TABLE orders (
    id INT PRIMARY KEY,
    user_id INT REFERENCES users(id)
);

-- 添加外键约束
ALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users(id);

-- 带约束名和动作
ALTER TABLE orders ADD CONSTRAINT fk_user 
    FOREIGN KEY (user_id) REFERENCES users(id) 
    ON DELETE CASCADE ON UPDATE RESTRICT;

-- 查看表的外键
SHOW FOREIGN KEYS FROM orders;

-- 删除外键约束
ALTER TABLE orders DROP FOREIGN KEY fk_user;
```

**外键特性：**
- **约束检查**: INSERT时验证外键值在引用表中存在
- **删除保护**: DELETE时检查是否有其他表引用（RESTRICT模式）
- **ON DELETE/UPDATE**: 支持 CASCADE, SET NULL, RESTRICT, NO ACTION
- **JSON持久化**: 外键约束保存在数据文件中

### DML (数据操作语言)

```sql
USE test1;

-- 插入数据
INSERT INTO users (id, name, age) VALUES (1, '张三', 25);

-- 查询数据
SELECT * FROM users WHERE age > 20 ORDER BY id DESC LIMIT 10;

-- 更新数据
UPDATE users SET age = 26 WHERE id = 1;

-- 删除数据
DELETE FROM users WHERE id = 1;

-- 清空表
TRUNCATE TABLE users;
```

### 聚合函数

```sql
USE test1;

-- COUNT 计数
SELECT COUNT(*) AS total FROM users;
SELECT COUNT(email) AS has_email FROM users;

-- SUM 求和
SELECT SUM(amount) AS total_price FROM orders;

-- AVG 平均值
SELECT AVG(age) AS avg_age FROM users;

-- MAX/MIN 最大/最小值
SELECT MAX(price) AS max_price, MIN(price) AS min_price FROM products;

-- 组合使用
SELECT COUNT(*) AS cnt, SUM(amount) AS total, AVG(amount) AS avg FROM orders;
```

### GROUP BY 分组查询

```sql
USE test1;

-- 按分类分组统计
SELECT category, COUNT(*) AS cnt FROM products GROUP BY category;

-- 分组聚合
SELECT department, AVG(salary) AS avg_salary, MAX(salary) AS max_salary
FROM employees
GROUP BY department;

-- HAVING 过滤分组
SELECT category, COUNT(*) AS cnt, SUM(price) AS total
FROM products
GROUP BY category
HAVING COUNT(*) > 1
ORDER BY total DESC;
```

### LIKE 模糊查询

```sql
USE test1;

-- % 匹配任意字符
SELECT * FROM users WHERE name LIKE '张%';     -- 以"张"开头
SELECT * FROM users WHERE name LIKE '%三';     -- 以"三"结尾
SELECT * FROM users WHERE name LIKE '%明%';    -- 包含"明"

-- _ 匹配单个字符
SELECT * FROM users WHERE name LIKE '张_';     -- "张"后跟一个字符
```

### DISTINCT 去重查询

```sql
USE test1;

-- 查询不重复的值
SELECT DISTINCT category FROM products;
SELECT DISTINCT city, country FROM customers;
```

### BETWEEN 范围查询

```sql
USE test1;

-- 数值范围
SELECT * FROM products WHERE price BETWEEN 100 AND 500;

-- 结合其他条件
SELECT * FROM orders WHERE amount BETWEEN 100 AND 500 AND status = 'completed';
```

### IN 集合查询

```sql
USE test1;

-- IN 包含
SELECT * FROM users WHERE status IN ('active', 'pending');
SELECT * FROM products WHERE category_id IN (1, 2, 5);

-- NOT IN 排除
SELECT * FROM orders WHERE status NOT IN ('cancelled', 'refunded');
```

### LIMIT OFFSET 分页查询

```sql
USE test1;

-- 限制返回条数
SELECT * FROM products LIMIT 10;

-- 分页查询（跳过前20条，取10条）
SELECT * FROM products ORDER BY id LIMIT 10 OFFSET 20;

-- 第3页数据（每馇10条）
SELECT * FROM users LIMIT 10 OFFSET 20;
```

### JOIN 多表查询

```sql
USE test1;

-- 内连接
SELECT u.name, o.product 
FROM users u 
JOIN orders o ON u.id = o.user_id;

-- 带别名的连接
SELECT students.name, enrollments.class_id
FROM students
JOIN enrollments ON students.id = enrollments.student_id;
```

### 事务支持

```sql
-- 开始事务
BEGIN;
-- 或 START TRANSACTION;

-- 执行操作
INSERT INTO users (id, name) VALUES (1, '张三');
UPDATE users SET name = '李四' WHERE id = 1;

-- 提交事务 (保存更改)
COMMIT;

-- 或回滚事务 (撤销更改)
ROLLBACK;
```

## 📁 数据类型支持

| 类型 | 说明 | 示例 |
|-----|------|-----|
| INT | 整数 | `age INT` |
| VARCHAR(n) | 可变长字符串 | `name VARCHAR(50)` |
| TEXT | 长文本 | `content TEXT` |
| DATETIME | 日期时间 | `created_at DATETIME` |
| DECIMAL(p,s) | 精确小数 | `price DECIMAL(10,2)` |

## 🔧 字段约束

```sql
CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(50) NOT NULL,
    email VARCHAR(100) UNIQUE,
    age INT DEFAULT 18
);
```

- **PRIMARY KEY** - 主键
- **AUTO_INCREMENT** - 自增
- **NOT NULL** - 非空
- **DEFAULT** - 默认值

## 📂 文件结构

```
frontend/
├── index.html          # 主页面 (HTML + CSS + JS)
├── server.js           # Node.js 后端服务器
├── data/
│   └── minisql_data.json   # 数据存储文件
└── README.md           # 说明文档
```

## 💾 数据存储

### 存储机制

1. **主存储**: 通过后端API保存到 `data/minisql_data.json`
2. **备份**: 同时保存到浏览器 localStorage

### 数据文件格式

```json
{
  "version": "1.0",
  "lastModified": "2026-01-12T04:00:00.000Z",
  "databases": {
    "mydb": {
      "tables": {
        "users": {
          "columns": [
            {"name": "id", "type": "INT", "primaryKey": true},
            {"name": "name", "type": "VARCHAR", "size": 50}
          ],
          "data": [
            {"id": 1, "name": "张三"},
            {"id": 2, "name": "李四"}
          ]
        }
      }
    }
  }
}
```

### 导入导出

- **导出JSON**: 点击工具栏"📤 导出"按钮，下载JSON备份文件
- **导入JSON**: 点击工具栏"📥 导入"按钮，选择JSON文件导入
- **导出CSV**: 执行查询后，点击结果区"📥 导出CSV"按钮下载查询结果

## 📊 ER图可视化

- 点击工具栏 **📊 ER图** 按钮打开
- 显示所有表的字段结构和数据类型
- 自动识别主键(🔑)和外键(🔗)
- SVG连线显示表间外键关系
- 底部列出所有外键引用关系

## 📊 数据统计

左侧边栏顶部显示实时统计卡片：
- **数据库数**: 当前数据库数量
- **数据表数**: 所有表的总数
- **总记录数**: 所有表的数据行总和

## ⌨️ 快捷键

| 快捷键 | 功能 |
|-------|-----|
| `Ctrl + Enter` | 执行SQL语句 |

## 📜 执行历史

- 点击工具栏 **📜 历史** 按钮查看执行历史
- 保存最近20条SQL语句
- 点击历史记录可快速回填到编辑器
- 历史记录保存在浏览器localStorage中

## 👆 快捷操作

- **点击表名**: 快速预览表数据（最多50条）
- **SQL模板**: 点击快捷按钮插入常用SQL语句
- **快捷键**: Ctrl+Enter 执行SQL

## 🔒 事务说明

- `BEGIN` 开始事务后，状态栏显示"🔒 事务进行中"
- 事务期间的所有更改暂存在内存中
- `COMMIT` 提交后数据永久保存到本地文件
- `ROLLBACK` 回滚后数据恢复到事务开始前的状态

## 📝 示例操作

```sql
-- 1. 创建数据库
CREATE DATABASE testdb;
USE testdb;

-- 2. 创建表
CREATE TABLE students (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(50) NOT NULL,
    age INT,
    grade VARCHAR(20)
);

-- 3. 插入数据
INSERT INTO students (name, age, grade) VALUES ('张三', 20, '大二');
INSERT INTO students (name, age, grade) VALUES ('李四', 21, '大三');
INSERT INTO students (name, age, grade) VALUES ('王五', 19, '大一');

-- 4. 查询数据
SELECT * FROM students WHERE age >= 20 ORDER BY age DESC;

-- 5. 聚合查询
SELECT COUNT(*) AS total, AVG(age) AS avg_age FROM students;

-- 6. 分组统计
SELECT grade, COUNT(*) AS cnt FROM students GROUP BY grade;

-- 7. 模糊查询
SELECT * FROM students WHERE name LIKE '%三%';

-- 8. 事务操作
BEGIN;
DELETE FROM students WHERE id = 3;
ROLLBACK;  -- 撤销删除
```

## � 并发控制

### 乐观锁机制

系统采用乐观锁防止多进程并发写入冲突：

1. **加载时**：记录服务器数据版本号
2. **保存时**：发送版本号给服务器比对
3. **版本不匹配**：返回409冲突，提示用户刷新或强制覆盖

### 文件锁

服务器端使用文件锁（`.minisql.lock`）防止同时写入，锁超时5秒自动释放。

---

## �🛠️ 技术栈

| 组件 | 技术 |
|------|------|
| 前端 | HTML5, CSS3, JavaScript (原生) |
| 后端 | Node.js (原生HTTP模块) |
| 存储 | JSON文件 + localStorage |
| 并发控制 | 乐观锁 + 文件锁 |

## 📂 文件结构

```
frontend/
├── index.html      # 主页面
├── styles.css      # 样式文件
├── app.js          # 前端逻辑
├── server.js       # Node.js 服务器
├── cli.js          # 命令行工具
├── data/
│   └── minisql_data.json   # 数据存储
└── README.md       # 说明文档
```

## 📄 版本信息

- **版本**: 1.5
- **更新日期**: 2026-01-12

### 更新日志

**v1.5** (2026-01-12)
- 新增命令行工具 cli.js（交互模式 + 批量执行）
- 新增乐观锁并发写入冲突检测
- 新增文件锁机制防止同时写入
- 修复 UPDATE SET col = col + 1 表达式计算
- 修复多行SQL换行符拼接问题
- 修复多条INSERT语句结果显示
- 前端样式优化（渐变背景、毛玻璃效果）
- 代码重构：分离 HTML/CSS/JS 文件

**v1.4** (2026-01-12)
- 新增完整外键约束支持
- 新增可视化外键管理界面
- 新增 ER图外键关系连线
- 支持 ON DELETE/UPDATE 动作

**v1.3** (2026-01-12)
- 新增索引管理: CREATE INDEX, DROP INDEX, SHOW INDEXES
- 新增唯一索引和复合索引支持

**v1.2** (2026-01-12)
- 新增聚合函数和GROUP BY
- 新增DISTINCT/BETWEEN/IN查询
- 新增CSV导出和ER图

**v1.1** (2026-01-12)
- 新增LIKE模糊查询
- 新增执行历史记录

**v1.0** (2026-01-12)
- 基础DDL/DML/JOIN/事务支持

---

**课程**: 数据库原理课程设计
