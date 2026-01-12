# MiniSQL 数据库管理系统

> 数据库原理课程设计项目 - 基于Web的轻量级数据库管理系统

## 📋 项目概述

MiniSQL 是一个纯前端实现的数据库管理系统，支持标准SQL语法，提供图形化界面进行数据库操作。数据持久化存储到本地JSON文件。

## 🚀 快速开始

### 环境要求
- Node.js 14+
- 现代浏览器 (Chrome 86+, Firefox, Edge)

### 启动服务器

```bash
cd frontend
node server.js
```

服务器启动后访问: **http://localhost:8080**

### 数据存储位置

```
frontend/data/minisql_data.json
```

## ✨ 功能特性

### DDL (数据定义语言)

| 命令 | 语法 | 说明 |
|-----|------|-----|
| 创建数据库 | `CREATE DATABASE db_name;` | 创建新数据库 |
| 删除数据库 | `DROP DATABASE db_name;` | 删除数据库及其所有表 |
| 切换数据库 | `USE db_name;` | 切换当前数据库 |
| 查看数据库 | `SHOW DATABASES;` | 列出所有数据库 |
| 创建表 | `CREATE TABLE t (col1 INT, col2 VARCHAR(50));` | 创建数据表 |
| 删除表 | `DROP TABLE t;` | 删除数据表 |
| 重命名表 | `RENAME TABLE old TO new;` | 重命名表 |
| 查看表 | `SHOW TABLES;` | 列出当前数据库所有表 |
| 表结构 | `DESC table_name;` | 查看表结构 |

### ALTER TABLE (表结构修改)

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

### DML (数据操作语言)

```sql
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

### JOIN 多表查询

```sql
-- 内连接
SELECT u.name, o.product 
FROM users u 
JOIN orders o ON u.id = o.user_id;

-- 左连接
SELECT u.name, o.product 
FROM users u 
LEFT JOIN orders o ON u.id = o.user_id;

-- 多表连接
SELECT u.name, o.product, p.price
FROM users u
JOIN orders o ON u.id = o.user_id
JOIN products p ON o.product_id = p.id;
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

- **导出**: 点击工具栏"📤 导出"按钮，下载JSON备份文件
- **导入**: 点击工具栏"📥 导入"按钮，选择JSON文件导入

## ⌨️ 快捷键

| 快捷键 | 功能 |
|-------|-----|
| `Ctrl + Enter` | 执行SQL语句 |

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

-- 5. 更新数据
UPDATE students SET grade = '大三' WHERE name = '张三';

-- 6. 事务操作
BEGIN;
DELETE FROM students WHERE id = 3;
ROLLBACK;  -- 撤销删除
```

## 🛠️ 技术栈

- **前端**: HTML5, CSS3, JavaScript (原生)
- **后端**: Node.js (原生HTTP模块)
- **存储**: JSON文件 + localStorage

## 📄 版本信息

- **版本**: 1.0
- **更新日期**: 2026-01-12
- **作者**: 数据库原理课程设计
