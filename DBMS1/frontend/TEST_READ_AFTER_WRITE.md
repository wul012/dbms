# 读写版本检测测试

## 测试目标
验证写操作后，其他窗口的读操作能够检测到版本更新并提示用户。

## 测试场景

### 场景1：写后读 - 自动检测版本更新

#### 步骤
1. **窗口A**：打开浏览器，访问 http://localhost:8080
2. **窗口A**：选择 school 数据库
3. **窗口A**：执行查询加载数据
   ```sql
   SELECT * FROM students LIMIT 10;
   ```
   - 控制台显示：`✅ 表数据已加载: school.students, 51 行`
   - 记录本地版本号（在控制台可以看到）

4. **窗口B**：打开另一个浏览器窗口，访问 http://localhost:8080
5. **窗口B**：选择 school 数据库
6. **窗口B**：执行查询加载数据
   ```sql
   SELECT * FROM students LIMIT 10;
   ```
   - 控制台显示：`✅ 表数据已加载: school.students, 51 行`

7. **窗口B**：修改数据
   ```sql
   INSERT INTO students (id, name, age) VALUES (300, '测试写后读', 25);
   ```
   - 控制台显示：`✅ 表数据已保存: school.students, 版本: xxx`
   - 服务器版本号已更新

8. **窗口A**：再次查询（不刷新页面）
   ```sql
   SELECT * FROM students WHERE id = 300;
   ```

#### 预期结果
- **窗口A** 应该弹出提示框：
  ```
  ⚠️ 表 students 数据已过期
  
  本地版本: 2026-01-13T12:34:56
  服务器版本: 2026-01-13T12:35:10
  
  其他窗口已修改此表数据。
  
  点击"确定"重新加载最新数据，点击"取消"使用本地缓存数据（可能过期）。
  ```

- 如果点击**"确定"**：
  - 控制台显示：`🔄 重新加载表数据: school.students`
  - 控制台显示：`✅ 表数据已加载: school.students, 52 行`
  - 结果区显示：`已重新加载表 students 的最新数据`
  - 查询结果应该包含 id=300 的新数据

- 如果点击**"取消"**：
  - 控制台显示：`⚠️ 使用本地缓存数据（可能过期）: school.students`
  - 结果区显示：`警告: 使用本地缓存数据，可能不是最新版本`
  - 查询结果不包含 id=300 的新数据（使用旧缓存）

### 场景2：写后读 - JOIN 查询

#### 步骤
1. **窗口A**：加载两个表
   ```sql
   SELECT * FROM students LIMIT 5;
   SELECT * FROM classes LIMIT 5;
   ```

2. **窗口B**：修改其中一个表
   ```sql
   INSERT INTO classes (id, title) VALUES (10, '新课程');
   ```

3. **窗口A**：执行 JOIN 查询
   ```sql
   SELECT s.name, c.title 
   FROM students s 
   JOIN enrollments e ON s.id = e.student_id 
   JOIN classes c ON e.class_id = c.id;
   ```

#### 预期结果
- 应该检测到 classes 表版本更新
- 弹出提示框询问是否重新加载
- 如果重新加载，JOIN 结果应该包含新课程

### 场景3：事务中不检查版本

#### 步骤
1. **窗口A**：开始事务并查询
   ```sql
   BEGIN;
   SELECT * FROM students LIMIT 10;
   ```

2. **窗口B**：修改数据
   ```sql
   INSERT INTO students (id, name, age) VALUES (301, '事务测试', 26);
   ```

3. **窗口A**：在事务中再次查询
   ```sql
   SELECT * FROM students WHERE id = 301;
   ```

#### 预期结果
- **不应该**弹出版本检测提示（事务中使用快照隔离）
- 查询结果不包含 id=301 的数据（事务隔离）

4. **窗口A**：提交事务后再查询
   ```sql
   COMMIT;
   SELECT * FROM students WHERE id = 301;
   ```

#### 预期结果
- **应该**弹出版本检测提示
- 重新加载后能看到 id=301 的数据

### 场景4：多次写后读

#### 步骤
1. **窗口A**：加载数据
   ```sql
   SELECT * FROM students LIMIT 10;
   ```

2. **窗口B**：第一次修改
   ```sql
   INSERT INTO students (id, name, age) VALUES (302, '第一次修改', 27);
   ```

3. **窗口A**：查询（检测到版本更新，选择重新加载）
   ```sql
   SELECT * FROM students WHERE id = 302;
   ```

4. **窗口B**：第二次修改
   ```sql
   INSERT INTO students (id, name, age) VALUES (303, '第二次修改', 28);
   ```

5. **窗口A**：再次查询
   ```sql
   SELECT * FROM students WHERE id = 303;
   ```

#### 预期结果
- 每次查询都应该检测到版本更新
- 每次都提示用户重新加载

## 实现细节

### 版本检查时机
```javascript
// executeSelect 中
if (tableData[tableKey] && !inTransaction) {
    await ensureTableFresh(currentDatabase, tableName);
}
```

### 版本检查逻辑
```javascript
async function ensureTableFresh(dbName, tableName) {
    const remoteVersion = await getRemoteTableVersion(dbName, tableName);
    const localVersion = tableVersions[tableKey];
    
    if (remoteVersion !== localVersion) {
        // 弹出提示，询问用户是否重新加载
        if (confirm(...)) {
            // 重新加载
            delete tableData[tableKey];
            await loadTableData(dbName, tableName);
        } else {
            // 使用本地缓存
            showResult('警告: 使用本地缓存数据', 'warning');
        }
    }
}
```

### API 调用
```javascript
// 获取服务器端表版本号
GET /api/table-version/:dbName/:tableName
→ { version: "2026-01-13T12:35:10.123Z" }
```

## 控制台日志

### 正常流程
```
✅ 表数据已加载: school.students, 51 行
⚠️ 检测到版本更新: school.students
🔄 重新加载表数据: school.students
✅ 表数据已加载: school.students, 52 行
```

### 使用缓存
```
✅ 表数据已加载: school.students, 51 行
⚠️ 检测到版本更新: school.students
⚠️ 使用本地缓存数据（可能过期）: school.students
```

## 注意事项

1. **只在表已加载时检查**
   - 如果表尚未加载（第一次查询），直接加载最新数据，不需要检查版本

2. **事务中不检查**
   - 事务使用快照隔离，不检查版本更新

3. **用户选择**
   - 用户可以选择重新加载或使用本地缓存
   - 使用本地缓存时会显示警告

4. **性能考虑**
   - 每次读操作都会发送一个 HTTP 请求获取版本号
   - 可以考虑添加版本号缓存（如 5 秒内不重复检查）

## 优化建议

### 1. 版本号缓存
```javascript
const versionCheckCache = {};  // { 'db.table': { version, timestamp } }

async function ensureTableFresh(dbName, tableName) {
    const tableKey = `${dbName}.${tableName}`;
    const now = Date.now();
    const cached = versionCheckCache[tableKey];
    
    // 5秒内不重复检查
    if (cached && now - cached.timestamp < 5000) {
        return;
    }
    
    const remoteVersion = await getRemoteTableVersion(dbName, tableName);
    versionCheckCache[tableKey] = { version: remoteVersion, timestamp: now };
    
    // ... 版本比较逻辑
}
```

### 2. 批量版本检查
```javascript
// 一次请求检查多个表的版本
GET /api/table-versions?tables=school.students,school.classes
→ { 
    "school.students": "v1",
    "school.classes": "v2"
}
```

### 3. WebSocket 推送
```javascript
// 服务器主动推送版本更新通知
ws.on('table-updated', (data) => {
    const { database, table, version } = data;
    // 更新本地版本号或提示用户
});
```
