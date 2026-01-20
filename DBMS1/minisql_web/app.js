// ==================== 数据库存储结构 ====================
        let databases = {}; // 只存储元数据：{ dbName: { tables: { tableName: { columns, foreignKeys, indexes } } } }
        let tableData = {}; // 按需加载的表数据：{ 'dbName.tableName': { data: [...], version: 'v1' } }
        let currentDatabase = null;
        let editingTable = null;
        let fileHandle = null; // 本地文件句柄
        let useTableStorage = true;
        
        // ==================== 事务支持 ====================
        let inTransaction = false;
        let transactionSnapshot = null; // 事务开始时的数据快照
        let transactionSnapshotTableData = null;
        let transactionSnapshotTableVersions = null;
        let transactionModifiedTables = new Set(); // 事务期间修改的表
        let transactionModifiedDatabases = new Set();
        
        // ==================== 执行历史 ====================
        let sqlHistory = JSON.parse(localStorage.getItem('sql_history') || '[]');

        let enableRowDelete = (() => {
            try {
                return JSON.parse(localStorage.getItem('enable_row_delete') || 'false') === true;
            } catch {
                return false;
            }
        })();

        // ==================== 表级版本号 ====================
        let tableVersions = {}; // { 'dbName.tableName': 'version' }

        // ==================== 初始化 ====================
        async function init() {
            // 优先从本地文件加载，其次从localStorage
            await loadFromLocalFile();

            renderDatabaseList();
            renderTableList();
            updateStorageInfo();
            const toggle = document.getElementById('toggle-row-delete');
            if (toggle) {
                toggle.checked = !!enableRowDelete;
                toggle.addEventListener('change', () => {
                    enableRowDelete = !!toggle.checked;
                    try { localStorage.setItem('enable_row_delete', JSON.stringify(enableRowDelete)); } catch {}
                    if (lastQueryResult) displayResult(lastQueryResult);
                });
            }
            document.getElementById('sql-editor').addEventListener('keydown', (e) => {
                if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); executeSQL(); }
            });
            addFieldRow();
        }

        // 从本地文件加载数据
        async function loadFromLocalFile() {
            useTableStorage = true;
            try {
                const response = await fetch('/api/databases?t=' + Date.now());
                if (response.ok) {
                    const data = await response.json();
                    databases = {};
                    for (const [dbName, dbMeta] of Object.entries((data && data.databases) || {})) {
                        databases[dbName] = { tables: {} };
                        for (const [tableName, tableMeta] of Object.entries(dbMeta.tables || {})) {
                            databases[dbName].tables[tableName] = {
                                columns: tableMeta.columns || [],
                                foreignKeys: tableMeta.foreignKeys || [],
                                indexes: tableMeta.indexes || {},
                                data: []
                            };
                        }
                    }
                    tableVersions = (data && data.tableVersions) ? data.tableVersions : {};
                    localStorage.setItem('minisql_metadata', JSON.stringify({ databases, tableVersions }));
                    console.log('✅ 元数据已加载（懒加载模式）:', Object.keys(databases).length, '个数据库');
                    return;
                }
            } catch (e) {
                console.log('分库分表API不可用，尝试从localStorage加载');
            }

            const saved = localStorage.getItem('minisql_metadata');
            if (saved) {
                const parsed = JSON.parse(saved);
                databases = parsed.databases || {};
                tableVersions = parsed.tableVersions || {};
                console.log('✅ 元数据已从localStorage加载');
                return;
            }

            databases = {};
            tableVersions = {};
        }

        // 保存到本地文件（通过后端API，带乐观锁冲突检测）
        // isWriteOperation: true表示写操作（需要版本检查），false表示读操作（跳过版本检查）
        async function saveToStorage(isWriteOperation = true, showFeedback = true) {
            updateStorageInfo();
            return { ok: true, skipped: true };
        }

        async function getRemoteLastModified() {
            return null;
        }

        async function ensureReadFresh() {
            return;
        }

        async function ensureReadFreshTableLevel(statements) {
            let dbName = currentDatabase;
            const checked = new Set();

            for (const stmt of statements) {
                const s = (stmt || '').trim();
                if (!s) continue;

                const useMatch = s.match(/^USE\s+(\w+)/i);
                if (useMatch) {
                    dbName = useMatch[1];
                    continue;
                }

                if (!dbName) continue;

                const upper = s.toUpperCase();
                const tables = new Set();

                if (upper.startsWith('SELECT')) {
                    const fromMatch = s.match(/\bFROM\s+(\w+)/i);
                    if (fromMatch) tables.add(fromMatch[1]);

                    const joinRe = /\bJOIN\s+(\w+)/ig;
                    let m;
                    while ((m = joinRe.exec(s)) !== null) {
                        tables.add(m[1]);
                    }
                } else if (upper.startsWith('DESC') || upper.startsWith('DESCRIBE')) {
                    const descMatch = s.match(/(?:DESC|DESCRIBE)\s+(\w+)/i);
                    if (descMatch) tables.add(descMatch[1]);
                } else {
                    continue;
                }

                for (const tableName of tables) {
                    const tableKey = `${dbName}.${tableName}`;
                    if (checked.has(tableKey)) continue;
                    checked.add(tableKey);

                    const localVer = (tableVersions[tableKey] ?? null);
                    
                    // 如果本地没有版本号（新建表或首次访问），先加载数据获取版本
                    if (localVer === null) {
                        await loadTableData(dbName, tableName);
                        continue; // 加载后版本已同步，跳过检查
                    }
                    
                    let serverVer = null;

                    try {
                        const resp = await fetch(`/api/table-version/${encodeURIComponent(dbName)}/${encodeURIComponent(tableName)}?t=${Date.now()}`);
                        if (!resp.ok) continue;
                        const json = await resp.json();
                        serverVer = (json && Object.prototype.hasOwnProperty.call(json, 'version')) ? (json.version ?? null) : null;
                    } catch (e) {
                        continue;
                    }

                    if (serverVer !== localVer) {
                        // 版本不匹配时，重新加载数据而不是报错
                        console.log(`⚠️ 版本不匹配 ${tableKey}: 本地=${localVer}, 服务器=${serverVer}, 正在刷新...`);
                        delete tableData[tableKey];
                        delete tableVersions[tableKey];
                        await loadTableData(dbName, tableName);
                    }
                }
            }
        }

        // ==================== 懒加载：按需加载表数据 ====================
        async function loadTableData(dbName, tableName) {
            const tableKey = `${dbName}.${tableName}`;
            
            // 如果已加载，直接返回
            if (tableData[tableKey]) {
                return tableData[tableKey].data;
            }
            
            try {
                const response = await fetch(`/api/table-data/${encodeURIComponent(dbName)}/${encodeURIComponent(tableName)}?t=${Date.now()}`);
                if (response.ok) {
                    const result = await response.json();
                    tableData[tableKey] = {
                        data: result.data || [],
                        version: result.version || new Date().toISOString()
                    };
                    tableVersions[tableKey] = tableData[tableKey].version;
                    if (databases[dbName] && databases[dbName].tables && databases[dbName].tables[tableName]) {
                        databases[dbName].tables[tableName].data = tableData[tableKey].data;
                    }
                    console.log(`📥 表数据已加载: ${tableKey}, ${result.data.length} 行`);
                    return tableData[tableKey].data;
                }
            } catch (e) {
                console.error(`加载表数据失败: ${tableKey}`, e);
            }
            
            // 失败时返回空数组
            tableData[tableKey] = { data: [], version: new Date().toISOString() };
            return [];
        }
        
        // 获取表数据（自动按需加载）
        async function getTableData(dbName, tableName) {
            const tableKey = `${dbName}.${tableName}`;
            if (!tableData[tableKey]) {
                await loadTableData(dbName, tableName);
            }
            return tableData[tableKey].data;
        }

        // 保存表数据到服务器（表级版本号 + 表级锁）
        async function saveTableData(dbName, tableName, showFeedback = true) {
            const tableKey = `${dbName}.${tableName}`;
            const data = tableData[tableKey]?.data || [];
            const expectedVersion = tableVersions[tableKey];
            
            // 备份到localStorage
            localStorage.setItem(`table_${tableKey}`, JSON.stringify({ data, version: expectedVersion }));
            
            try {
                let newVersion = new Date().toISOString();
                if (expectedVersion && newVersion === expectedVersion) {
                    newVersion = new Date(Date.now() + 1).toISOString();
                }
                
                const response = await fetch('/api/save-table', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        database: dbName,
                        table: tableName,
                        expectedVersion: expectedVersion,
                        version: newVersion,
                        data: data
                    })
                });
                
                if (response.ok) {
                    tableVersions[tableKey] = newVersion;
                    if (tableData[tableKey]) {
                        tableData[tableKey].version = newVersion;
                    }
                    console.log(`✅ 表数据已保存: ${tableKey}, 版本: ${newVersion}`);
                    if (fileHandle) {
                        writeBoundFileSnapshot({ scope: 'all' }).catch(() => {});
                    }
                    return { ok: true, status: response.status };
                } else if (response.status === 409) {
                    const result = await response.json();
                    const errorMessage = result.error || '数据冲突：其他进程已修改此表，请刷新页面';
                    console.warn('⚠️ 保存冲突:', errorMessage);
                    if (showFeedback) showResult(`错误: ${errorMessage}`, 'error');
                    return { ok: false, status: response.status, errorMessage };
                } else {
                    const errorMessage = `保存失败 (HTTP ${response.status})`;
                    console.warn('⚠️ 保存失败:', errorMessage);
                    if (showFeedback) showResult(`错误: ${errorMessage}`, 'error');
                    return { ok: false, status: response.status, errorMessage };
                }
            } catch (e) {
                console.log('后端API不可用，数据已保存到localStorage');
                if (showFeedback) showResult('错误: 后端API不可用，数据仅保存到localStorage', 'error');
                return { ok: false, status: 0, errorMessage: '后端API不可用' };
            }
        }

        // 保存元数据到服务器
        async function saveMetadata(dbName) {
            const metadata = databases[dbName];
            if (!metadata) return { ok: false, errorMessage: '数据库不存在' };

            const cleanMetadata = { tables: {} };
            for (const [tableName, table] of Object.entries(metadata.tables || {})) {
                cleanMetadata.tables[tableName] = {
                    columns: table.columns || [],
                    foreignKeys: table.foreignKeys || [],
                    indexes: table.indexes || {}
                };
            }
            
            try {
                const response = await fetch('/api/save-metadata', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ database: dbName, metadata: cleanMetadata })
                });
                
                if (response.ok) {
                    console.log(`✅ 元数据已保存: ${dbName}`);
                    if (fileHandle) {
                        writeBoundFileSnapshot({ scope: 'all' }).catch(() => {});
                    }
                    return { ok: true };
                } else {
                    return { ok: false, errorMessage: `保存失败 (HTTP ${response.status})` };
                }
            } catch (e) {
                return { ok: false, errorMessage: '后端API不可用' };
            }
        }

        async function persistCurrentDbMetadata() {
            if (!useTableStorage) return;
            if (!currentDatabase) return;
            if (inTransaction) {
                transactionModifiedDatabases.add(currentDatabase);
                return;
            }
            const saveResult = await saveMetadata(currentDatabase);
            if (!saveResult || !saveResult.ok) {
                throw new Error(saveResult && saveResult.errorMessage ? saveResult.errorMessage : '保存元数据失败');
            }
            localStorage.setItem('minisql_metadata', JSON.stringify({ databases, tableVersions }));
        }

        function resolveColumnNameFromTable(table, name) {
            const n = String(name || '').trim();
            if (!n) return n;
            const found = (table && table.columns ? table.columns : []).find(c => c && c.name && c.name.toLowerCase() === n.toLowerCase());
            return found ? found.name : n;
        }

        function getRowValueCaseInsensitive(row, name) {
            if (!row) return undefined;
            if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
            const lower = String(name || '').toLowerCase();
            const key = Object.keys(row).find(k => String(k).toLowerCase() === lower);
            return key ? row[key] : undefined;
        }

        function ensurePrimaryKeyUnique(table, dataArray) {
            const pkCol = (table && table.columns ? table.columns : []).find(c => c && c.primaryKey);
            if (!pkCol) return;
            const seen = new Set();
            for (const row of dataArray || []) {
                const v = getRowValueCaseInsensitive(row, pkCol.name);
                if (v === null || v === undefined) continue;
                const k = String(v);
                if (seen.has(k)) throw new Error(`主键 '${pkCol.name}' 值 '${v}' 已存在`);
                seen.add(k);
            }
        }

        function ensureUniqueIndexes(table, dataArray) {
            const indexes = table && table.indexes ? table.indexes : {};
            for (const [idxName, idx] of Object.entries(indexes)) {
                if (!idx || !idx.unique) continue;
                const cols = Array.isArray(idx.columns) ? idx.columns : [];
                if (cols.length === 0) continue;
                const seen = new Set();
                for (const row of dataArray || []) {
                    const values = cols.map(c => getRowValueCaseInsensitive(row, c));
                    if (values.some(v => v === null || v === undefined)) continue;
                    const key = values.map(v => String(v)).join('|');
                    if (seen.has(key)) throw new Error(`唯一索引约束失败: ${idxName}(${cols.join(', ')}) 存在重复值`);
                    seen.add(key);
                }
            }
        }

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

        function tryApplyIndexWhere(table, dataArray, whereClause) {
            if (!table || !table.indexes || !dataArray) return null;
            const parsed = parseSimpleWhereForIndex(whereClause);
            if (!parsed) return null;

            const colName = resolveColumnNameFromTable(table, parsed.column);
            const candidates = Object.entries(table.indexes).filter(([name, idx]) => {
                if (!idx || !Array.isArray(idx.columns) || idx.columns.length !== 1) return false;
                return String(idx.columns[0]).toLowerCase() === String(colName).toLowerCase();
            });
            if (candidates.length === 0) return null;

            candidates.sort((a, b) => (b[1] && b[1].unique ? 1 : 0) - (a[1] && a[1].unique ? 1 : 0));
            const [indexName, idx] = candidates[0];
            const indexData = idx && idx.data ? idx.data : null;
            if (!indexData || typeof indexData !== 'object') return null;

            const hitIndices = [];
            for (const v of parsed.values) {
                const key = String(v);
                const arr = indexData[key];
                if (Array.isArray(arr)) hitIndices.push(...arr);
            }

            const seen = new Set();
            const rows = [];
            for (const i of hitIndices) {
                const n = Number(i);
                if (!Number.isFinite(n)) continue;
                if (n < 0 || n >= dataArray.length) continue;
                if (seen.has(n)) continue;
                seen.add(n);
                rows.push(dataArray[n]);
            }

            return { indexName, rows };
        }

        async function fetchBackupSnapshot({ scope, database }) {
            const url = scope === 'db'
                ? `/api/backup?scope=db&database=${encodeURIComponent(database)}`
                : '/api/backup?scope=all';

            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`备份失败 (HTTP ${resp.status})`);
            return await resp.text();
        }

        async function writeBoundFileSnapshot({ scope, database }) {
            if (!fileHandle) return;
            const jsonText = await fetchBackupSnapshot({ scope, database });
            const writable = await fileHandle.createWritable();
            try {
                await writable.write(jsonText);
            } finally {
                await writable.close();
            }
        }

        function updateStorageInfo() {
            const size = new Blob([JSON.stringify(databases)]).size;
            const fileStatus = fileHandle ? ` | 📁 ${fileHandle.name}` : '';
            const el = document.getElementById('storage-info');
            if (el) el.textContent = `存储: ${(size/1024).toFixed(1)}KB${fileStatus}`;

            const dbCountEl = document.getElementById('stat-db');
            const tableCountEl = document.getElementById('stat-table');

            if (dbCountEl && tableCountEl) {
                const dbCount = Object.keys(databases).length;
                let tableCount = 0;
                for (const db of Object.values(databases)) {
                    tableCount += Object.keys(db.tables || {}).length;
                }
                dbCountEl.textContent = dbCount;
                tableCountEl.textContent = tableCount;
            }
        }

        // ==================== UI 渲染 ====================
        function renderDatabaseList() {
            const container = document.getElementById('db-list');
            const dbNames = Object.keys(databases);
            if (dbNames.length === 0) {
                container.innerHTML = '<div class="empty-state" style="padding:12px;font-size:11px">暂无数据库</div>';
                return;
            }
            container.innerHTML = dbNames.map(name => `
                <div class="db-item ${currentDatabase === name ? 'active' : ''}" onclick="selectDatabase('${name}')" style="cursor:pointer">
                    <span>📁 ${name}</span>
                    <div class="item-actions">
                        <button onclick="event.stopPropagation();confirmDropDb('${name}')" title="删除">🗑</button>
                    </div>
                </div>
            `).join('');
        }

        function renderTableList() {
            const container = document.getElementById('table-list');
            if (!currentDatabase || !databases[currentDatabase]) {
                container.innerHTML = '<div class="empty-state" style="padding:12px;font-size:11px">请先选择数据库</div>';
                return;
            }
            const tables = Object.keys(databases[currentDatabase].tables || {});
            if (tables.length === 0) {
                container.innerHTML = '<div class="empty-state" style="padding:12px;font-size:11px">暂无数据表</div>';
                return;
            }
            container.innerHTML = tables.map(name => `
                <div class="table-item" onclick="quickSelectTable('${name}')" style="cursor:pointer">
                    <span>📋 ${name} <small style="color:#666">(${useTableStorage ? ((tableData[currentDatabase + '.' + name] && tableData[currentDatabase + '.' + name].data) ? tableData[currentDatabase + '.' + name].data.length : '…') : databases[currentDatabase].tables[name].data.length})</small></span>
                    <div class="item-actions">
                        <button onclick="event.stopPropagation();openEditTable('${name}')" title="编辑">✏</button>
                        <button onclick="event.stopPropagation();confirmDropTable('${name}')" title="删除">🗑</button>
                    </div>
                </div>
            `).join('');
        }

        function selectDatabase(name) {
            currentDatabase = name;
            document.getElementById('current-db').textContent = name;
            renderDatabaseList();
            renderTableList();
            showResult(`已切换到数据库: ${name}`, 'success');
        }

        function quickSelectTable(tableName) {
            document.getElementById('sql-editor').value = `SELECT * FROM ${tableName} LIMIT 50;`;
            executeSQL();
        }

        function confirmDropDb(name) {
            if (confirm(`确定删除数据库 "${name}" 吗？此操作不可恢复！`)) {
                document.getElementById('sql-editor').value = `DROP DATABASE ${name};`;
                executeSQL();
            }
        }

        function confirmDropTable(name) {
            if (confirm(`确定删除表 "${name}" 吗？`)) {
                document.getElementById('sql-editor').value = `DROP TABLE ${name};`;
                executeSQL();
            }
        }

        // ==================== 模态框 ====================
        function showModal(id) {
            document.getElementById(id).classList.add('show');
            if (id === 'create-db-modal') document.getElementById('new-db-name').focus();
            if (id === 'create-table-modal') document.getElementById('new-table-name').focus();
        }

        function closeModal(id) {
            document.getElementById(id).classList.remove('show');
        }

        function createDatabaseFromModal() {
            const name = document.getElementById('new-db-name').value.trim();
            if (!name) { alert('请输入数据库名称'); return; }
            document.getElementById('sql-editor').value = `CREATE DATABASE ${name};`;
            executeSQL();
            closeModal('create-db-modal');
            document.getElementById('new-db-name').value = '';
        }

        // ==================== 可视化表编辑器 ====================
        let fieldRowCounter = 0;
        function addFieldRow() {
            const container = document.getElementById('field-rows');
            const id = fieldRowCounter++;
            container.innerHTML += `
                <div class="field-row" id="field-row-${id}">
                    <input type="text" placeholder="字段名" id="fname-${id}">
                    <select id="ftype-${id}">
                        <option value="INT">INT</option>
                        <option value="VARCHAR">VARCHAR</option>
                        <option value="TEXT">TEXT</option>
                        <option value="FLOAT">FLOAT</option>
                        <option value="DOUBLE">DOUBLE</option>
                        <option value="DATETIME">DATETIME</option>
                        <option value="DATE">DATE</option>
                        <option value="BOOLEAN">BOOLEAN</option>
                    </select>
                    <input type="number" placeholder="长度" id="fsize-${id}" value="">
                    <input type="checkbox" id="fpk-${id}">
                    <input type="checkbox" id="fnn-${id}">
                    <button class="btn btn-xs btn-danger" onclick="removeFieldRow(${id})">×</button>
                </div>
            `;
        }

        function removeFieldRow(id) {
            const row = document.getElementById(`field-row-${id}`);
            if (row) row.remove();
        }

        function createTableFromModal() {
            if (!currentDatabase) { alert('请先选择或创建数据库'); return; }
            const tableName = document.getElementById('new-table-name').value.trim();
            if (!tableName) { alert('请输入表名'); return; }
            
            const rows = document.querySelectorAll('#field-rows .field-row');
            if (rows.length === 0) { alert('请至少添加一个字段'); return; }
            
            let sql = `CREATE TABLE ${tableName} (\n`;
            const cols = [];
            rows.forEach(row => {
                const id = row.id.split('-')[2];
                const name = document.getElementById(`fname-${id}`).value.trim();
                const type = document.getElementById(`ftype-${id}`).value;
                const size = document.getElementById(`fsize-${id}`).value;
                const pk = document.getElementById(`fpk-${id}`).checked;
                const nn = document.getElementById(`fnn-${id}`).checked;
                if (name) {
                    let col = `    ${name} ${type}`;
                    if (size) col += `(${size})`;
                    if (pk) col += ' PRIMARY KEY';
                    if (nn) col += ' NOT NULL';
                    cols.push(col);
                }
            });
            sql += cols.join(',\n') + '\n);';
            
            document.getElementById('sql-editor').value = sql;
            executeSQL();
            closeModal('create-table-modal');
            document.getElementById('new-table-name').value = '';
            document.getElementById('field-rows').innerHTML = '';
            fieldRowCounter = 0;
            addFieldRow();
        }

        // ==================== 编辑表结构 ====================
        function openEditTable(tableName) {
            editingTable = tableName;
            document.getElementById('edit-table-name').textContent = tableName;
            document.getElementById('rename-table-name').value = tableName;
            
            const table = databases[currentDatabase].tables[tableName];
            const container = document.getElementById('edit-field-rows');
            container.innerHTML = table.columns.map((col, i) => `
                <div class="field-row" data-original="${col.name}">
                    <input type="text" value="${col.name}" class="edit-fname">
                    <span style="color:#666;font-size:12px">${col.type}</span>
                    <span style="color:#666;font-size:12px">${col.size || '-'}</span>
                    <span style="color:#666;font-size:12px">${col.primaryKey ? '✓' : '-'}</span>
                    <span style="color:#666;font-size:12px">${col.notNull ? '✓' : '-'}</span>
                    <button class="btn btn-xs btn-danger" onclick="markFieldDeleted(this)">×</button>
                </div>
            `).join('');

            renderEditFKRows(tableName);
            showModal('edit-table-modal');
        }

        function renderEditFKRows(tableName) {
            const table = databases[currentDatabase].tables[tableName];
            const foreignKeys = table.foreignKeys || [];
            const fkContainer = document.getElementById('edit-fk-rows');
            const otherTables = Object.keys(databases[currentDatabase].tables).filter(t => t !== tableName);

            fkContainer.innerHTML = foreignKeys.map((fk, i) => `
                <div style="display:grid;grid-template-columns:2fr 2fr 2fr 1fr 1fr 40px;gap:8px;padding:6px 0;border-bottom:1px solid #e9ecef;font-size:11px" data-fk-name="${fk.name || ('fk_' + tableName + '_' + fk.column)}" data-fk-original-column="${fk.column}" data-fk-original-ref-table="${fk.refTable}" data-fk-original-ref-column="${fk.refColumn}" data-fk-original-on-delete="${fk.onDelete || 'RESTRICT'}" data-fk-original-on-update="${fk.onUpdate || 'RESTRICT'}">
                    <select class="fk-column" style="padding:5px;font-size:11px">
                        ${table.columns.map(c => `<option value="${c.name}" ${c.name===fk.column?'selected':''}>${c.name}</option>`).join('')}
                    </select>
                    <select class="fk-ref-table" style="padding:5px;font-size:11px" onchange="updateRefColumns(this)">
                        ${otherTables.map(t => `<option value="${t}" ${t===fk.refTable?'selected':''}>${t}</option>`).join('')}
                    </select>
                    <select class="fk-ref-column" style="padding:5px;font-size:11px">
                        ${(databases[currentDatabase].tables[fk.refTable]?.columns || []).map(c => `<option value="${c.name}" ${c.name===fk.refColumn?'selected':''}>${c.name}</option>`).join('')}
                    </select>
                    <select class="fk-on-delete" style="padding:5px;font-size:11px">
                        <option value="RESTRICT" ${fk.onDelete==='RESTRICT'?'selected':''}>RESTRICT</option>
                        <option value="CASCADE" ${fk.onDelete==='CASCADE'?'selected':''}>CASCADE</option>
                        <option value="SET NULL" ${fk.onDelete==='SET NULL'?'selected':''}>SET NULL</option>
                        <option value="NO ACTION" ${fk.onDelete==='NO ACTION'?'selected':''}>NO ACTION</option>
                    </select>
                    <select class="fk-on-update" style="padding:5px;font-size:11px">
                        <option value="RESTRICT" ${fk.onUpdate==='RESTRICT'?'selected':''}>RESTRICT</option>
                        <option value="CASCADE" ${fk.onUpdate==='CASCADE'?'selected':''}>CASCADE</option>
                        <option value="SET NULL" ${fk.onUpdate==='SET NULL'?'selected':''}>SET NULL</option>
                        <option value="NO ACTION" ${fk.onUpdate==='NO ACTION'?'selected':''}>NO ACTION</option>
                    </select>
                    <button class="btn btn-xs btn-danger" onclick="markFKDeleted(this)">×</button>
                </div>
            `).join('');
        }
        
        function updateRefColumns(select) {
            const row = select.parentElement;
            const refTable = databases[currentDatabase].tables[select.value];

            const refColSelect = row.querySelector('.fk-ref-column');
            refColSelect.innerHTML = refTable.columns.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
        }
        
        function markFKDeleted(btn) {
            const row = btn.parentElement;
            if (row.dataset.fkNew) {
                row.remove();
            } else {
                row.style.opacity = '0.3';
                row.dataset.fkDeleted = 'true';
                btn.textContent = '↩';
                btn.onclick = () => { row.style.opacity = '1'; delete row.dataset.fkDeleted; btn.textContent = '×'; btn.onclick = () => markFKDeleted(btn); };
            }
        }

        function addEditFKRow() {
            const table = databases[currentDatabase].tables[editingTable];
            const otherTables = Object.keys(databases[currentDatabase].tables).filter(t => t !== editingTable);
            if (otherTables.length === 0) { alert('需要先创建其他表才能添加外键'); return; }
            const firstRefTable = databases[currentDatabase].tables[otherTables[0]];
            const fkContainer = document.getElementById('edit-fk-rows');
            fkContainer.innerHTML += `
                <div style="display:grid;grid-template-columns:2fr 2fr 2fr 1fr 1fr 40px;gap:8px;padding:6px 0;border-bottom:1px solid #e9ecef;font-size:11px" data-fk-new="true">
                    <select class="fk-column" style="padding:5px;font-size:11px">
                        ${table.columns.map(c => `<option value="${c.name}">${c.name}</option>`).join('')}
                    </select>
                    <select class="fk-ref-table" style="padding:5px;font-size:11px" onchange="updateRefColumns(this)">
                        ${otherTables.map(t => `<option value="${t}">${t}</option>`).join('')}
                    </select>
                    <select class="fk-ref-column" style="padding:5px;font-size:11px">
                        ${firstRefTable.columns.map(c => `<option value="${c.name}">${c.name}</option>`).join('')}
                    </select>
                    <select class="fk-on-delete" style="padding:5px;font-size:11px">
                        <option value="RESTRICT" selected>RESTRICT</option>
                        <option value="CASCADE">CASCADE</option>
                        <option value="SET NULL">SET NULL</option>
                        <option value="NO ACTION">NO ACTION</option>
                    </select>
                    <select class="fk-on-update" style="padding:5px;font-size:11px">
                        <option value="RESTRICT" selected>RESTRICT</option>
                        <option value="CASCADE">CASCADE</option>
                        <option value="SET NULL">SET NULL</option>
                        <option value="NO ACTION">NO ACTION</option>
                    </select>
                    <button class="btn btn-xs btn-danger" onclick="this.parentElement.remove()">×</button>
                </div>
            `;
        }
        
        function addEditFieldRow() {
            const container = document.getElementById('edit-field-rows');
            container.innerHTML += `
                <div class="field-row" data-new="true">
                    <input type="text" placeholder="新字段名" class="edit-fname">
                    <select class="edit-ftype">
                        <option value="INT">INT</option>
                        <option value="VARCHAR" selected>VARCHAR</option>
                        <option value="TEXT">TEXT</option>
                        <option value="FLOAT">FLOAT</option>
                        <option value="DATETIME">DATETIME</option>
                    </select>
                    <input type="number" placeholder="长度" class="edit-fsize" value="50">
                    <input type="checkbox" class="edit-fpk">
                    <input type="checkbox" class="edit-fnn">
                    <button class="btn btn-xs btn-danger" onclick="this.parentElement.remove()">×</button>
                </div>
            `;
        }

        function markFieldDeleted(btn) {
            const row = btn.parentElement;
            if (row.dataset.new) {
                row.remove();
            } else {
                row.style.opacity = '0.3';
                row.dataset.deleted = 'true';
                btn.textContent = '↩';
                btn.onclick = () => { row.style.opacity = '1'; delete row.dataset.deleted; btn.textContent = '×'; btn.onclick = () => markFieldDeleted(btn); };
            }
        }

        function switchEditTab(tab) {
            document.querySelectorAll('#edit-table-modal .tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('#edit-table-modal .tab-content').forEach(c => c.classList.remove('active'));
            event.target.classList.add('active');
            document.getElementById(`edit-${tab}-tab`).classList.add('active');
        }

        function saveTableChanges() {
            const newName = document.getElementById('rename-table-name').value.trim();
            if (newName && newName !== editingTable) {
                document.getElementById('sql-editor').value = `RENAME TABLE ${editingTable} TO ${newName};`;
                executeSQL();
                editingTable = newName;
            }
            
            const rows = document.querySelectorAll('#edit-field-rows .field-row');
            const colSqls = [];
            rows.forEach(row => {
                const fname = row.querySelector('.edit-fname').value.trim();
                
                if (row.dataset.deleted) {
                    colSqls.push(`ALTER TABLE ${editingTable} DROP COLUMN ${row.dataset.original}`);
                } else if (row.dataset.new && fname) {
                    const ftype = row.querySelector('.edit-ftype') ? row.querySelector('.edit-ftype').value : '';
                    const fsize = row.querySelector('.edit-fsize') ? row.querySelector('.edit-fsize').value : '';
                    colSqls.push(`ALTER TABLE ${editingTable} ADD ${fname} ${ftype}${fsize ? `(${fsize})` : ''}`);
                } else if (row.dataset.original && fname !== row.dataset.original) {
                    colSqls.push(`ALTER TABLE ${editingTable} RENAME COLUMN ${row.dataset.original} TO ${fname}`);
                }
            });
            
            // 处理外键更改
            const fkRows = document.querySelectorAll('#edit-fk-rows > div');
            const fkDropSqls = [];
            const fkAddSqls = [];
            fkRows.forEach(row => {
                if (row.dataset.fkDeleted && row.dataset.fkName) {
                    fkDropSqls.push(`ALTER TABLE ${editingTable} DROP FOREIGN KEY ${row.dataset.fkName}`);
                } else if (row.dataset.fkNew) {
                    const col = row.querySelector('.fk-column').value;
                    const refTable = row.querySelector('.fk-ref-table').value;
                    const refCol = row.querySelector('.fk-ref-column').value;
                    const onDelete = row.querySelector('.fk-on-delete').value;
                    const onUpdate = row.querySelector('.fk-on-update').value;
                    fkAddSqls.push(`ALTER TABLE ${editingTable} ADD FOREIGN KEY (${col}) REFERENCES ${refTable}(${refCol}) ON DELETE ${onDelete} ON UPDATE ${onUpdate}`);
                } else if (row.dataset.fkName) {
                    const fkName = row.dataset.fkName;
                    const col = row.querySelector('.fk-column').value;
                    const refTable = row.querySelector('.fk-ref-table').value;
                    const refCol = row.querySelector('.fk-ref-column').value;
                    const onDelete = row.querySelector('.fk-on-delete').value;
                    const onUpdate = row.querySelector('.fk-on-update').value;

                    const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
                    const normAction = (v) => String(v || 'RESTRICT').toUpperCase();

                    const originalColumn = row.dataset.fkOriginalColumn;
                    const originalRefTable = row.dataset.fkOriginalRefTable;
                    const originalRefColumn = row.dataset.fkOriginalRefColumn;
                    const originalOnDelete = row.dataset.fkOriginalOnDelete;
                    const originalOnUpdate = row.dataset.fkOriginalOnUpdate;

                    const changed = !eq(col, originalColumn)
                        || !eq(refTable, originalRefTable)
                        || !eq(refCol, originalRefColumn)
                        || normAction(onDelete) !== normAction(originalOnDelete)
                        || normAction(onUpdate) !== normAction(originalOnUpdate);

                    if (changed) {
                        fkDropSqls.push(`ALTER TABLE ${editingTable} DROP FOREIGN KEY ${fkName}`);
                        fkAddSqls.push(`ALTER TABLE ${editingTable} ADD CONSTRAINT ${fkName} FOREIGN KEY (${col}) REFERENCES ${refTable}(${refCol}) ON DELETE ${onDelete} ON UPDATE ${onUpdate}`);
                    }
                }
            });

            const sqls = [...fkDropSqls, ...colSqls, ...fkAddSqls];
            
            if (sqls.length > 0) {
                document.getElementById('sql-editor').value = sqls.join(';\n') + ';';
                executeSQL();
            }
            closeModal('edit-table-modal');
        }

        function deleteCurrentTable() {
            if (confirm(`确定删除表 "${editingTable}" 吗？`)) {
                document.getElementById('sql-editor').value = `DROP TABLE ${editingTable};`;
                executeSQL();
                closeModal('edit-table-modal');
            }
        }

        // ==================== SQL模板 ====================
        function insertTemplate(type) {
            const templates = {
                'create-db': 'CREATE DATABASE database_name;',
                'create-table': `CREATE TABLE table_name (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(50) NOT NULL,
    age INT,
    created_at DATETIME
);`,
                'alter': `-- 添加字段
ALTER TABLE table_name ADD column_name VARCHAR(50);
-- 删除字段
ALTER TABLE table_name DROP COLUMN column_name;
-- 修改字段类型
ALTER TABLE table_name MODIFY column_name INT;
-- 重命名字段
ALTER TABLE table_name RENAME COLUMN old_name TO new_name;`,
                'rename': 'RENAME TABLE old_table_name TO new_table_name;',
                'insert': "INSERT INTO table_name (col1, col2) VALUES ('value1', 'value2');",
                'select': 'SELECT * FROM table_name WHERE column = value ORDER BY column DESC LIMIT 10;',
                'join': `-- 多表连接查询
SELECT t1.*, t2.column_name 
FROM table1 t1 
JOIN table2 t2 ON t1.id = t2.foreign_id 
WHERE t1.column = value;`,
                'update': "UPDATE table_name SET col1 = 'value1' WHERE condition;",
                'delete': 'DELETE FROM table_name WHERE condition;',
                'aggregate': `-- 聚合函数示例
SELECT COUNT(*) AS total FROM table_name;
SELECT SUM(column) AS sum_val, AVG(column) AS avg_val FROM table_name;
SELECT MAX(column), MIN(column) FROM table_name WHERE condition;`,
                'groupby': `-- GROUP BY 分组查询
SELECT category, COUNT(*) AS cnt, SUM(price) AS total
FROM products
GROUP BY category
HAVING COUNT(*) > 1
ORDER BY total DESC;`,
                'begin': `-- 事务示例
BEGIN;
INSERT INTO table_name (col1) VALUES ('value1');
UPDATE table_name SET col1 = 'new_value' WHERE id = 1;
COMMIT;  -- 或 ROLLBACK; 撤销更改`,
                'commit': 'COMMIT;',
                'rollback': 'ROLLBACK;'
            };
            document.getElementById('sql-editor').value = templates[type] || '';
        }
        function toggleHelp() {
            document.getElementById('syntax-help').classList.toggle('show');
        }

        // ==================== 文件导入导出 ====================
        function exportToFile() {
            if (Object.keys(databases).length === 0) { alert('没有数据可导出'); return; }

            const exportAll = confirm('导出全部数据库？\n确定=导出全部，取消=仅导出当前数据库');
            if (!exportAll && !currentDatabase) {
                alert('请先选择一个数据库');
                return;
            }

            const scope = exportAll ? 'all' : 'db';
            const dbName = exportAll ? null : currentDatabase;

            fetchBackupSnapshot({ scope, database: dbName }).then((jsonText) => {
                const blob = new Blob([jsonText], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const date = new Date().toISOString().slice(0, 10);
                a.download = exportAll ? `minisql_backup_all_${date}.json` : `minisql_backup_${dbName}_${date}.json`;

                a.click();
                URL.revokeObjectURL(url);
                showResult('数据已导出为JSON文件', 'success');
            }).catch((e) => {
                showResult('导出失败: ' + e.message, 'error');
            });
        }

        async function importFromFile(event) {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            try {
                const raw = await file.text();
                JSON.parse(raw);

                if (!confirm('导入将合并现有数据，重名库/表会自动重命名，是否继续？')) {
                    return;
                }

                const resp = await fetch('/api/restore?mode=merge&conflict=rename', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: raw
                });
                if (!resp.ok) throw new Error(`导入失败 (HTTP ${resp.status})`);

                const result = await resp.json();
                await loadFromLocalFile();
                renderDatabaseList();
                renderTableList();

                const renamedDbCount = result && result.renamedDatabases ? Object.keys(result.renamedDatabases).length : 0;
                const renamedTableDbCount = result && result.renamedTables ? Object.keys(result.renamedTables).length : 0;
                const renamedInfo = (renamedDbCount > 0 || renamedTableDbCount > 0) ? '（已处理重名：自动重命名）' : '';
                const importedCount = (() => {
                    try {
                        const obj = JSON.parse(raw);
                        return obj && obj.databases ? Object.keys(obj.databases).length : 0;
                    } catch { return 0; }
                })();
                showResult(`导入成功：${importedCount} 个数据库 ${renamedInfo}`, 'success');

                if (fileHandle) {
                    writeBoundFileSnapshot({ scope: 'all' }).catch(() => {});
                }
            } catch (err) {
                showResult('导入失败: ' + err.message, 'error');
            } finally {
                event.target.value = '';
            }
        }

        async function clearAllData() {
            if (!confirm('确定清空所有数据吗？此操作不可恢复！')) return;
            try {
                const resp = await fetch('/api/clear-all', { method: 'POST' });
                if (!resp.ok) throw new Error(`清空失败 (HTTP ${resp.status})`);

                databases = {};
                tableData = {};
                tableVersions = {};
                currentDatabase = null;
                document.getElementById('current-db').textContent = '未选择';
                localStorage.removeItem('minisql_metadata');
                updateStorageInfo();
                renderDatabaseList();
                renderTableList();
                showResult('所有数据已清空', 'success');
                if (fileHandle) {
                    writeBoundFileSnapshot({ scope: 'all' }).catch(() => {});
                }
            } catch (e) {
                showResult('清空失败: ' + e.message, 'error');
            }
        }

        // ==================== ER图可视化 ====================
        function showERDiagram() {
            if (!currentDatabase) {
                alert('请先选择一个数据库');
                return;
            }
            const tables = databases[currentDatabase].tables;
            if (!tables || Object.keys(tables).length === 0) {
                alert('当前数据库没有表');
                return;
            }

            const container = document.getElementById('er-container');
            container.innerHTML = generateERDiagram(tables);
            showModal('er-modal');
        }

        function generateERDiagram(tables) {
            const tableNames = Object.keys(tables);
            const tableCount = tableNames.length;

            // 从表的foreignKeys数组加载外键关系
            const relations = [];
            for (const [tableName, table] of Object.entries(tables)) {
                const foreignKeys = table.foreignKeys || [];
                for (const fk of foreignKeys) {
                    const fromColIdx = table.columns.findIndex(c => c.name.toLowerCase() === fk.column.toLowerCase());
                    const refTable = tables[fk.refTable];
                    if (refTable) {
                        const toColIdx = refTable.columns.findIndex(c => c.name.toLowerCase() === fk.refColumn.toLowerCase());
                        relations.push({
                            fromTable: tableName,
                            fromCol: fk.column,
                            fromColIdx: fromColIdx >= 0 ? fromColIdx : 0,
                            toTable: fk.refTable,
                            toCol: fk.refColumn,
                            toColIdx: toColIdx >= 0 ? toColIdx : 0,
                            fkName: fk.name
                        });
                    }
                }
            }
            
            // 计算布局
            const cardWidth = 200, rowHeight = 26, headerHeight = 42, padding = 8;
            const gapX = 100, gapY = 40;
            const cols = Math.min(tableCount, 3);
            const marginLeft = 20; // 左边距
            
            // 计算每个表的高度和位置
            const tableInfo = {};
            let idx = 0;
            for (const [name, table] of Object.entries(tables)) {
                const height = headerHeight + table.columns.length * rowHeight + padding * 2;
                const row = Math.floor(idx / cols);
                const col = idx % cols;
                tableInfo[name] = {
                    x: col * (cardWidth + gapX) + marginLeft,
                    y: row * 260 + 30,
                    width: cardWidth,
                    height: height,
                    columns: table.columns
                };
                idx++;
            }
            
            const totalWidth = cols * (cardWidth + gapX) + marginLeft;
            const totalRows = Math.ceil(tableCount / cols);
            const totalHeight = totalRows * 260 + 120;
            
            // 生成SVG连线 - 从外键字段连接到主键字段
            const colors = ['#e74c3c', '#3498db', '#2ecc71', '#9b59b6', '#f39c12'];
            let svgContent = `<defs>`;
            relations.forEach((rel, i) => {
                svgContent += `<marker id="arrowhead${i}" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="${colors[i % colors.length]}"/></marker>`;
            });
            svgContent += `</defs>`;
            
            relations.forEach((rel, i) => {
                const from = tableInfo[rel.fromTable];
                const to = tableInfo[rel.toTable];
                if (!from || !to) return;
                
                const color = colors[i % colors.length];
                // 计算字段中心Y坐标
                const fromY = from.y + headerHeight + rel.fromColIdx * rowHeight + rowHeight / 2 + padding;
                const toY = to.y + headerHeight + rel.toColIdx * rowHeight + rowHeight / 2 + padding;
                
                // 判断连接方向并计算端点
                let x1, x2, midX;
                if (from.x > to.x + to.width) {
                    // from在右边，to在左边
                    x1 = from.x;
                    x2 = to.x + to.width;
                    midX = (x1 + x2) / 2;
                } else if (to.x > from.x + from.width) {
                    // from在左边，to在右边
                    x1 = from.x + from.width;
                    x2 = to.x;
                    midX = (x1 + x2) / 2;
                } else {
                    // 重叠情况
                    x1 = from.x + from.width;
                    x2 = to.x + to.width + 30;
                    midX = Math.max(x1, x2) + 20;
                }
                
                // 水平-垂直-水平 直角连线
                svgContent += `<path d="M${x1},${fromY} L${midX},${fromY} L${midX},${toY} L${x2},${toY}" 
                    fill="none" stroke="${color}" stroke-width="2" marker-end="url(#arrowhead${i})"/>`;
                // 起点圆点
                svgContent += `<circle cx="${x1}" cy="${fromY}" r="4" fill="${color}"/>`;
            });
            
            let html = `<div style="display:flex;flex-direction:column;align-items:center">`;
            html += `<div style="position:relative;width:${totalWidth}px;height:${totalHeight}px">`;
            
            // SVG层
            html += `<svg style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10">${svgContent}</svg>`;
            
            // 表卡片 - 浅色主题
            for (const [tableName, table] of Object.entries(tables)) {
                const info = tableInfo[tableName];
                const rowCount = tableData[currentDatabase + '.' + tableName]?.data?.length ?? table.data?.length ?? 0;
                html += `
                <div style="position:absolute;left:${info.x}px;top:${info.y}px;width:${info.width}px;background:#ffffff;border:2px solid #e9d5ff;border-radius:10px;box-shadow:0 4px 20px rgba(139,92,246,0.15);z-index:5">
                    <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6,#a855f7);color:#fff;padding:10px 12px;font-weight:600;border-radius:8px 8px 0 0;text-align:center;height:${headerHeight}px;box-sizing:border-box;letter-spacing:0.5px">
                        📋 ${tableName} <span style="font-size:10px;opacity:0.85;font-weight:400">(${rowCount})</span>
                    </div>
                    <div style="padding:${padding}px;background:#faf5ff">
                        ${table.columns.map((col, idx) => {
                            const isPK = col.primaryKey;
                            const isFK = col.name.endsWith('_id') && !col.primaryKey;
                            const relIdx = relations.findIndex(r => r.fromTable === tableName && r.fromCol === col.name);
                            const relColor = isFK && relIdx >= 0 ? colors[relIdx % colors.length] : null;
                            return `<div style="height:${rowHeight}px;padding:0 8px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f3e8ff;font-size:11px;background:${isFK && relColor ? relColor + '15' : '#ffffff'}">
                                <span style="color:#1e293b">
                                    ${isPK ? '<span style="color:#f59e0b">🔑</span>' : ''}
                                    ${isFK ? '<span style="color:' + (relColor || '#3b82f6') + '">🔗</span>' : ''}
                                    <strong style="${isPK ? 'color:#b45309' : isFK && relColor ? 'color:' + relColor : 'color:#1e293b'}">${col.name}</strong>
                                </span>
                                <span style="color:#64748b;font-size:10px;font-family:JetBrains Mono,monospace">${col.size ? col.type + '(' + col.size + ')' : col.type}</span>
                            </div>`;
                        }).join('')}
                    </div>
                </div>`;
            }
            html += `</div>`;
            
            // 关系说明 - 浅色主题
            if (relations.length > 0) {
                html += `<div style="margin-top:15px;padding:14px 20px;background:#ffffff;border:1px solid #e9d5ff;border-radius:10px;box-shadow:0 2px 8px rgba(139,92,246,0.1)">
                    <strong style="color:#7c3aed">🔗 外键关系:</strong>
                    <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:12px">
                        ${relations.map((r, i) => `
                            <div style="display:flex;align-items:center;padding:8px 14px;background:${colors[i % colors.length]}10;border:1px solid ${colors[i % colors.length]}30;border-radius:6px;font-size:12px">
                                <span style="color:${colors[i % colors.length]};margin-right:6px">●</span>
                                <strong style="color:#1e293b">${r.fromTable}</strong><span style="color:#94a3b8">.</span><span style="color:${colors[i % colors.length]}">${r.fromCol}</span>
                                <span style="margin:0 10px;color:#94a3b8">→</span>
                                <strong style="color:#1e293b">${r.toTable}</strong><span style="color:#94a3b8">.</span><span style="color:#b45309">${r.toCol}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>`;
            }
            
            // 图例 - 浅色主题
            html += `<div style="margin-top:12px;padding:10px 16px;font-size:11px;color:#64748b;display:flex;gap:24px;align-items:center;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">
                <span><span style="color:#f59e0b">🔑</span> 主键(PK)</span>
                <span><span style="color:#3b82f6">🔗</span> 外键(FK)</span>
                <span style="display:flex;align-items:center;gap:4px"><span style="color:#ef4444">●</span> <span style="color:#94a3b8">━━━▶</span> 外键引用</span>
            </div>`;
            html += `</div>`;
            
            return html;
        }

        // ==================== SQL 解析器 ====================
        // 判断SQL是否为读操作或事务控制命令（不需要额外同步）
        // 事务控制命令(COMMIT/ROLLBACK)内部已处理同步，避免重复
        function isReadOnlySQL(sql) {
            const upperSQL = sql.toUpperCase().trim();
            return upperSQL.startsWith('SELECT') || 
                   upperSQL.startsWith('SHOW') || 
                   upperSQL.startsWith('DESC') || 
                   upperSQL.startsWith('DESCRIBE') ||
                   upperSQL.startsWith('USE') ||
                   upperSQL === 'BEGIN' ||
                   upperSQL === 'START TRANSACTION' ||
                   upperSQL === 'BEGIN TRANSACTION' ||
                   upperSQL === 'COMMIT' ||
                   upperSQL === 'ROLLBACK';
        }
        
        async function executeSQL() {
            let sql = document.getElementById('sql-editor').value.trim();
            if (!sql) { showResult('请输入 SQL 语句', 'error'); return; }
            // 将换行符和多余空格统一处理为单个空格，防止多行SQL拼接错误
            sql = sql.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
            const startTime = performance.now();
            try {
                const statements = sql.split(';').filter(s => s.trim() && !s.trim().startsWith('--'));
                let hasWriteOperation = false;
                let hasTransactionControl = false;
                let hasReadQuery = false;
                for (const stmt of statements) {
                    const trimmedStmt = stmt.trim();
                    const upperStmt = trimmedStmt.toUpperCase();
                    if (upperStmt.startsWith('SELECT') || upperStmt.startsWith('SHOW') || upperStmt.startsWith('DESC') || upperStmt.startsWith('DESCRIBE')) {
                        hasReadQuery = true;
                    }
                    if (upperStmt === 'COMMIT' || upperStmt === 'ROLLBACK') hasTransactionControl = true;
                    if (!isReadOnlySQL(trimmedStmt)) hasWriteOperation = true;
                }
                if (hasReadQuery && !hasWriteOperation && !inTransaction) {
                    if (useTableStorage) {
                        await ensureReadFreshTableLevel(statements);
                    } else {
                        await ensureReadFresh();
                    }
                }

                let lastResult = null;
                let totalInserted = 0, insertCount = 0;
                for (const stmt of statements) {
                    const trimmedStmt = stmt.trim();
                    const upperStmt = trimmedStmt.toUpperCase();
                    const result = await parseSingleSQL(trimmedStmt);
                    // 累计INSERT结果
                    if (result && result.message && result.message.includes('插入')) {
                        const match = result.message.match(/(\d+)/);
                        if (match) { totalInserted += parseInt(match[1]); insertCount++; }
                    }
                    lastResult = result;
                }
                // 如果有多条INSERT，显示汇总结果
                if (insertCount > 1 && lastResult) {
                    lastResult.message = `成功执行 ${insertCount} 条INSERT语句，共插入 ${totalInserted} 行数据`;
                }
                const endTime = performance.now();
                document.getElementById('exec-time').textContent = `执行耗时: ${(endTime - startTime).toFixed(2)}ms`;
                if (lastResult) displayResult(lastResult);
                // 事务中不同步到服务器，等COMMIT/ROLLBACK时再同步
                // 只有写操作且不在事务中才同步到服务器（旧版单文件存储）
                if (!useTableStorage) {
                    const saveResult = await saveToStorage(hasWriteOperation && !inTransaction && !hasTransactionControl);
                    if (saveResult && !saveResult.ok) {
                        showResult(`错误: ${saveResult.errorMessage}`, 'error');
                    }
                }
                renderDatabaseList();
                renderTableList();
                // 添加到执行历史
                addToHistory(sql);
            } catch (error) {
                showResult(`错误: ${error.message}`, 'error');
            }
        }
        
        // ==================== 执行历史功能 ====================
        function addToHistory(sql) {
            const time = new Date().toLocaleTimeString();
            sqlHistory.unshift({ sql, time });
            if (sqlHistory.length > 20) sqlHistory.pop(); // 最多保存20条
            localStorage.setItem('sql_history', JSON.stringify(sqlHistory));
            renderHistory();
        }
        
        function renderHistory() {
            const list = document.getElementById('history-list');
            if (!list) return;
            list.innerHTML = sqlHistory.map((item, i) => 
                `<div class="history-item" onclick="loadHistory(${i})" title="${item.sql}">
                    <span class="history-time">${item.time}</span>${item.sql.substring(0, 60)}${item.sql.length > 60 ? '...' : ''}
                </div>`
            ).join('');
        }
        
        function loadHistory(index) {
            document.getElementById('sql-editor').value = sqlHistory[index].sql;
        }
        
        function toggleHistory() {
            const el = document.getElementById('sql-history');
            el.style.display = el.style.display === 'none' ? 'block' : 'none';
            if (el.style.display === 'block') renderHistory();
        }
        
        function clearHistory() {
            sqlHistory = [];
            localStorage.removeItem('sql_history');
            renderHistory();
        }

        async function parseSingleSQL(sql) {
            const upperSQL = sql.toUpperCase().trim();
            // 事务控制
            if (upperSQL === 'BEGIN' || upperSQL === 'START TRANSACTION' || upperSQL === 'BEGIN TRANSACTION') return executeBegin();
            if (upperSQL === 'COMMIT') return await executeCommit();
            if (upperSQL === 'ROLLBACK') return await executeRollback();
            // DDL
            if (upperSQL.startsWith('CREATE DATABASE')) return executeCreateDatabase(sql);
            if (upperSQL.startsWith('DROP DATABASE')) return executeDropDatabase(sql);
            if (upperSQL.startsWith('USE ')) return executeUse(sql);
            if (upperSQL === 'SHOW DATABASES') return executeShowDatabases();
            if (upperSQL === 'SHOW TABLES') return executeShowTables();
            if (upperSQL.startsWith('CREATE TABLE')) return executeCreateTable(sql);
            if (upperSQL.startsWith('DROP TABLE')) return executeDropTable(sql);
            if (upperSQL.startsWith('RENAME TABLE')) return executeRenameTable(sql);
            if (upperSQL.startsWith('DESC ') || upperSQL.startsWith('DESCRIBE ')) return executeDescribe(sql);
            // DML
            if (upperSQL.startsWith('INSERT')) return executeInsert(sql);
            if (upperSQL.startsWith('SELECT')) return executeSelect(sql);
            if (upperSQL.startsWith('UPDATE')) return executeUpdate(sql);
            if (upperSQL.startsWith('DELETE')) return executeDelete(sql);
            if (upperSQL.startsWith('ALTER TABLE')) return executeAlterTable(sql);
            if (upperSQL.startsWith('TRUNCATE')) return executeTruncate(sql);
            // 索引
            if (upperSQL.startsWith('CREATE INDEX') || upperSQL.startsWith('CREATE UNIQUE INDEX')) return executeCreateIndex(sql);
            if (upperSQL.startsWith('DROP INDEX')) return executeDropIndex(sql);
            if (upperSQL.startsWith('SHOW INDEX') || upperSQL.startsWith('SHOW INDEXES')) return executeShowIndexes(sql);
            // 外键
            if (upperSQL.startsWith('SHOW FOREIGN KEYS') || upperSQL.startsWith('SHOW REFERENCES')) return executeShowForeignKeys(sql);
            throw new Error(`不支持的 SQL 语句: ${sql}`);
        }

        // ==================== 事务执行器 ====================
        function updateTransactionStatus() {
            const el = document.getElementById('transaction-status');
            el.innerHTML = inTransaction ? '<span style="color:#f39c12">🔒 事务进行中</span>' : '';
        }

        function executeBegin() {
            if (inTransaction) throw new Error('事务已经开始，请先COMMIT或ROLLBACK');
            inTransaction = true;
            transactionSnapshot = JSON.parse(JSON.stringify(databases)); // 深拷贝
            if (useTableStorage) {
                transactionSnapshotTableData = JSON.parse(JSON.stringify(tableData));
                transactionSnapshotTableVersions = JSON.parse(JSON.stringify(tableVersions));
            }
            transactionModifiedTables.clear();
            transactionModifiedDatabases.clear();
            updateTransactionStatus();
            return { type: 'message', message: '🔒 事务已开始 (BEGIN TRANSACTION) - 更改将暂存，需要COMMIT提交或ROLLBACK撤销', status: 'info' };
        }

        async function executeCommit() {
            if (!inTransaction) throw new Error('没有活动的事务');
            // COMMIT时同步数据到服务器
            if (useTableStorage) {
                for (const tableKey of transactionModifiedTables) {
                    const dot = tableKey.indexOf('.');
                    const dbName = tableKey.substring(0, dot);
                    const tableName = tableKey.substring(dot + 1);
                    const result = await saveTableData(dbName, tableName, false);
                    if (!result || !result.ok) {
                        return { type: 'message', message: `错误: ${result && result.errorMessage ? result.errorMessage : '提交失败'}`, status: 'error' };
                    }
                }
                transactionModifiedTables.clear();

                for (const dbName of transactionModifiedDatabases) {
                    const result = await saveMetadata(dbName);
                    if (!result || !result.ok) {
                        return { type: 'message', message: `错误: ${result && result.errorMessage ? result.errorMessage : '提交失败'}`, status: 'error' };
                    }
                }
                transactionModifiedDatabases.clear();
            } else {
                const saveResult = await saveToStorage(true, false);
                if (!saveResult || !saveResult.ok) {
                    return { type: 'message', message: `错误: ${saveResult && saveResult.errorMessage ? saveResult.errorMessage : '提交失败'}`, status: 'error' };
                }
            }
            inTransaction = false;
            transactionSnapshot = null;
            if (useTableStorage) {
                transactionSnapshotTableData = null;
                transactionSnapshotTableVersions = null;
            }
            updateTransactionStatus();
            return { type: 'message', message: '✅ 事务已提交 (COMMIT) - 所有更改已永久保存', status: 'success' };
        }

        async function executeRollback() {
            if (!inTransaction) throw new Error('没有活动的事务');
            databases = transactionSnapshot; // 恢复快照
            if (useTableStorage) {
                tableData = transactionSnapshotTableData || {};
                tableVersions = transactionSnapshotTableVersions || {};
                transactionModifiedTables.clear();
                transactionModifiedDatabases.clear();
            }
            inTransaction = false;
            transactionSnapshot = null;
            if (useTableStorage) {
                transactionSnapshotTableData = null;
                transactionSnapshotTableVersions = null;
            }
            updateTransactionStatus();
            // ROLLBACK后同步恢复的数据到服务器（旧版单文件存储）
            if (!useTableStorage) {
                const saveResult = await saveToStorage(true, true);
                if (!saveResult || !saveResult.ok) {
                    return { type: 'message', message: `错误: ${saveResult && saveResult.errorMessage ? saveResult.errorMessage : '回滚同步失败'}`, status: 'error' };
                }
            }
            return { type: 'message', message: '⏪ 事务已回滚 (ROLLBACK) - 所有更改已撤销，数据已恢复', status: 'warning' };
        }

        // ==================== SQL 执行器 ====================
        async function executeCreateDatabase(sql) {
            const match = sql.match(/CREATE\s+DATABASE\s+(\w+)/i);
            if (!match) throw new Error('CREATE DATABASE 语法错误');
            
            const dbName = match[1];
            if (databases[dbName]) {
                throw new Error(`数据库 '${dbName}' 已存在`);
            }
            
            databases[dbName] = { tables: {} };
            currentDatabase = dbName;
            document.getElementById('current-db').textContent = dbName;

            if (useTableStorage) {
                const result = await saveMetadata(dbName);
                if (!result || !result.ok) {
                    delete databases[dbName];
                    currentDatabase = null;
                    document.getElementById('current-db').textContent = '未选择';
                    throw new Error(result && result.errorMessage ? result.errorMessage : '创建数据库失败');
                }
            }

            localStorage.setItem('minisql_metadata', JSON.stringify({ databases, tableVersions }));
            return { type: 'message', message: `数据库 '${dbName}' 创建成功`, status: 'success' };
        }

        async function executeDropDatabase(sql) {
            const match = sql.match(/DROP\s+DATABASE\s+(\w+)/i);
            if (!match) throw new Error('DROP DATABASE 语法错误');
            
            const dbName = match[1];
            if (!databases[dbName]) {
                throw new Error(`数据库 '${dbName}' 不存在`);
            }

            if (useTableStorage) {
                const resp = await fetch(`/api/delete-database?database=${encodeURIComponent(dbName)}`, { method: 'POST' });
                if (!resp.ok) throw new Error(`删除数据库失败 (HTTP ${resp.status})`);
            }
            
            delete databases[dbName];
            for (const key of Object.keys(tableData)) {
                if (key.startsWith(dbName + '.')) delete tableData[key];
            }
            for (const key of Object.keys(tableVersions)) {
                if (key.startsWith(dbName + '.')) delete tableVersions[key];
            }
            if (currentDatabase === dbName) {
                currentDatabase = null;
                document.getElementById('current-db').textContent = '未选择';
            }

            localStorage.setItem('minisql_metadata', JSON.stringify({ databases, tableVersions }));
            if (fileHandle) {
                writeBoundFileSnapshot({ scope: 'all' }).catch(() => {});
            }
            
            return { type: 'message', message: `数据库 '${dbName}' 已删除`, status: 'success' };
        }

        function executeUse(sql) {
            const match = sql.match(/USE\s+(\w+)/i);
            if (!match) throw new Error('USE 语法错误');
            
            const dbName = match[1];
            if (!databases[dbName]) {
                throw new Error(`数据库 '${dbName}' 不存在`);
            }
            
            currentDatabase = dbName;
            document.getElementById('current-db').textContent = dbName;
            
            return { type: 'message', message: `已切换到数据库 '${dbName}'`, status: 'success' };
        }

        function executeShowDatabases() {
            const dbNames = Object.keys(databases);
            return {
                type: 'table',
                columns: ['Database'],
                data: dbNames.map(name => ({ Database: name })),
                message: `共 ${dbNames.length} 个数据库`
            };
        }

        function executeShowTables() {
            if (!currentDatabase) throw new Error('请先选择数据库 (USE database_name)');
            
            const tables = Object.keys(databases[currentDatabase].tables || {});
            return {
                type: 'table',
                columns: [`Tables_in_${currentDatabase}`],
                data: tables.map(name => ({ [`Tables_in_${currentDatabase}`]: name })),
                message: `共 ${tables.length} 个表`
            };
        }

        async function executeCreateTable(sql) {
            if (!currentDatabase) throw new Error('请先选择数据库 (USE database_name)');
            
            const match = sql.match(/CREATE\s+TABLE\s+(\w+)\s*\(([\s\S]+)\)/i);
            if (!match) throw new Error('CREATE TABLE 语法错误');
            
            const tableName = match[1];
            const columnsDef = match[2];
            
            if (databases[currentDatabase].tables[tableName]) {
                throw new Error(`表 '${tableName}' 已存在`);
            }
            
            const { columns, foreignKeys } = parseColumnDefinitions(columnsDef);
            
            // 验证外键引用的表和列存在
            for (const fk of foreignKeys) {
                const refTable = databases[currentDatabase].tables[fk.refTable];
                if (!refTable) throw new Error(`外键引用的表 '${fk.refTable}' 不存在`);
                const refCol = refTable.columns.find(c => c.name.toLowerCase() === fk.refColumn.toLowerCase());
                if (!refCol) throw new Error(`外键引用的列 '${fk.refTable}.${fk.refColumn}' 不存在`);
            }
            
            databases[currentDatabase].tables[tableName] = {
                columns: columns,
                foreignKeys: foreignKeys,
                indexes: {},
                data: []
            };

            if (useTableStorage) {
                const saveResult = await saveMetadata(currentDatabase);
                if (!saveResult || !saveResult.ok) {
                    delete databases[currentDatabase].tables[tableName];
                    throw new Error(saveResult && saveResult.errorMessage ? saveResult.errorMessage : '保存元数据失败');
                }
                
                // 初始化表数据文件（空数组），确保版本号同步
                const tableKey = `${currentDatabase}.${tableName}`;
                tableData[tableKey] = { data: [], version: new Date().toISOString() };
                tableVersions[tableKey] = tableData[tableKey].version;
                const tableResult = await saveTableData(currentDatabase, tableName, false);
                if (!tableResult || !tableResult.ok) {
                    console.warn(`表数据初始化保存失败: ${tableKey}`);
                }
            }

            localStorage.setItem('minisql_metadata', JSON.stringify({ databases, tableVersions }));
            
            const fkMsg = foreignKeys.length > 0 ? `，${foreignKeys.length} 个外键` : '';
            return { type: 'message', message: `表 '${tableName}' 创建成功，共 ${columns.length} 个字段${fkMsg}`, status: 'success' };
        }

        function parseColumnDefinitions(def) {
            const columns = [];
            const foreignKeys = [];
            const parts = def.split(',');
            
            for (let part of parts) {
                part = part.trim();
                if (!part) continue;
                
                // 处理 PRIMARY KEY (col) 这种形式
                if (part.toUpperCase().startsWith('PRIMARY KEY')) {
                    const pkMatch = part.match(/PRIMARY\s+KEY\s*\((\w+)\)/i);
                    if (pkMatch) {
                        const pkCol = columns.find(c => c.name.toLowerCase() === pkMatch[1].toLowerCase());
                        if (pkCol) pkCol.primaryKey = true;
                    }
                    continue;
                }
                
                // 处理 FOREIGN KEY (col) REFERENCES table(col) 这种形式
                if (part.toUpperCase().startsWith('FOREIGN KEY')) {
                    const fkMatch = part.match(/FOREIGN\s+KEY\s*\((\w+)\)\s+REFERENCES\s+(\w+)\s*\((\w+)\)(?:\s+ON\s+DELETE\s+(CASCADE|SET NULL|RESTRICT|NO ACTION))?(?:\s+ON\s+UPDATE\s+(CASCADE|SET NULL|RESTRICT|NO ACTION))?/i);
                    if (fkMatch) {
                        foreignKeys.push({
                            column: fkMatch[1],
                            refTable: fkMatch[2],
                            refColumn: fkMatch[3],
                            onDelete: fkMatch[4] ? fkMatch[4].toUpperCase() : 'RESTRICT',
                            onUpdate: fkMatch[5] ? fkMatch[5].toUpperCase() : 'RESTRICT'
                        });
                    }
                    continue;
                }
                
                // 解析列定义（包含内联REFERENCES）
                const colMatch = part.match(/^(\w+)\s+(\w+)(?:\s*\((\d+)\))?(.*)$/i);
                if (colMatch) {
                    const col = {
                        name: colMatch[1],
                        type: colMatch[2].toUpperCase(),
                        size: colMatch[3] ? parseInt(colMatch[3]) : null,
                        primaryKey: false,
                        autoIncrement: false,
                        notNull: false,
                        default: null
                    };
                    
                    const options = colMatch[4];
                    const optionsUpper = options.toUpperCase();
                    if (optionsUpper.includes('PRIMARY KEY')) col.primaryKey = true;
                    if (optionsUpper.includes('AUTO_INCREMENT')) col.autoIncrement = true;
                    if (optionsUpper.includes('NOT NULL')) col.notNull = true;
                    
                    const defaultMatch = options.match(/DEFAULT\s+(\S+)/i);
                    if (defaultMatch) col.default = defaultMatch[1];
                    
                    // 内联外键: col_name INT REFERENCES table(col)
                    const refMatch = options.match(/REFERENCES\s+(\w+)\s*\((\w+)\)/i);
                    if (refMatch) {
                        foreignKeys.push({
                            column: col.name,
                            refTable: refMatch[1],
                            refColumn: refMatch[2],
                            onDelete: 'RESTRICT',
                            onUpdate: 'RESTRICT'
                        });
                    }
                    
                    columns.push(col);
                }
            }
            return { columns, foreignKeys };
        }

        async function executeDropTable(sql) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            
            const match = sql.match(/DROP\s+TABLE\s+(\w+)/i);
            if (!match) throw new Error('DROP TABLE 语法错误');
            
            const tableName = match[1];
            if (!databases[currentDatabase].tables[tableName]) throw new Error(`表 '${tableName}' 不存在`);

            const referencing = [];
            for (const [otherTableName, otherTable] of Object.entries(databases[currentDatabase].tables || {})) {
                if (otherTableName === tableName) continue;
                const fks = otherTable.foreignKeys || [];
                for (const fk of fks) {
                    if (!fk || !fk.refTable) continue;
                    if (fk.refTable.toLowerCase() === tableName.toLowerCase()) {
                        referencing.push(`${otherTableName}.${fk.column}`);
                    }
                }
            }
            if (referencing.length > 0) {
                throw new Error(`无法删除表 '${tableName}'：被外键引用（请先删除相关外键）: ${referencing.join(', ')}`);
            }

            delete databases[currentDatabase].tables[tableName];

            const tableKey = `${currentDatabase}.${tableName}`;
            delete tableData[tableKey];
            delete tableVersions[tableKey];

            if (useTableStorage) {
                const saveResult = await saveMetadata(currentDatabase);
                if (!saveResult || !saveResult.ok) {
                    throw new Error(saveResult && saveResult.errorMessage ? saveResult.errorMessage : '保存元数据失败');
                }
                const resp = await fetch(`/api/delete-table?database=${encodeURIComponent(currentDatabase)}&table=${encodeURIComponent(tableName)}`, { method: 'POST' });
                if (!resp.ok) throw new Error(`删除表数据失败 (HTTP ${resp.status})`);
            }

            localStorage.setItem('minisql_metadata', JSON.stringify({ databases, tableVersions }));
            return { type: 'message', message: `表 '${tableName}' 已删除`, status: 'success' };
        }

        async function executeRenameTable(sql) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            const match = sql.match(/RENAME\s+TABLE\s+(\w+)\s+TO\s+(\w+)/i);
            if (!match) throw new Error('RENAME TABLE 语法错误，格式: RENAME TABLE old TO new');
            const oldName = match[1], newName = match[2];
            if (!databases[currentDatabase].tables[oldName]) throw new Error(`表 '${oldName}' 不存在`);
            if (databases[currentDatabase].tables[newName]) throw new Error(`表 '${newName}' 已存在`);

            if (useTableStorage) {
                const resp = await fetch(`/api/rename-table-file?database=${encodeURIComponent(currentDatabase)}&from=${encodeURIComponent(oldName)}&to=${encodeURIComponent(newName)}`, { method: 'POST' });
                if (!resp.ok) throw new Error(`重命名表数据失败 (HTTP ${resp.status})`);
            }

            databases[currentDatabase].tables[newName] = databases[currentDatabase].tables[oldName];
            delete databases[currentDatabase].tables[oldName];

            for (const tbl of Object.values(databases[currentDatabase].tables || {})) {
                if (!tbl.foreignKeys) continue;
                for (const fk of tbl.foreignKeys) {
                    if (fk.refTable && fk.refTable.toLowerCase() === oldName.toLowerCase()) {
                        fk.refTable = newName;
                    }
                }
            }

            const oldKey = `${currentDatabase}.${oldName}`;
            const newKey = `${currentDatabase}.${newName}`;
            if (tableData[oldKey] && !tableData[newKey]) {
                tableData[newKey] = tableData[oldKey];
            }
            delete tableData[oldKey];
            if (Object.prototype.hasOwnProperty.call(tableVersions, oldKey) && !Object.prototype.hasOwnProperty.call(tableVersions, newKey)) {
                tableVersions[newKey] = tableVersions[oldKey];
            }
            delete tableVersions[oldKey];

            if (useTableStorage) {
                const saveResult = await saveMetadata(currentDatabase);
                if (!saveResult || !saveResult.ok) {
                    throw new Error(saveResult && saveResult.errorMessage ? saveResult.errorMessage : '保存元数据失败');
                }
            }

            localStorage.setItem('minisql_metadata', JSON.stringify({ databases, tableVersions }));
            return { type: 'message', message: `表 '${oldName}' 已重命名为 '${newName}'`, status: 'success' };
        }

        function executeDescribe(sql) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            
            const match = sql.match(/(?:DESC|DESCRIBE)\s+(\w+)/i);
            if (!match) throw new Error('DESC 语法错误');
            
            const tableName = match[1];
            const table = databases[currentDatabase].tables[tableName];
            if (!table) throw new Error(`表 '${tableName}' 不存在`);
            
            return {
                type: 'table',
                columns: ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'],
                data: table.columns.map(col => ({
                    Field: col.name,
                    Type: col.size ? `${col.type}(${col.size})` : col.type,
                    Null: col.notNull ? 'NO' : 'YES',
                    Key: col.primaryKey ? 'PRI' : '',
                    Default: col.default || 'NULL',
                    Extra: col.autoIncrement ? 'auto_increment' : ''
                })),
                message: `${table.columns.length} 个字段`
            };
        }

        async function executeInsert(sql) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            
            const match = sql.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
            if (!match) throw new Error('INSERT 语法错误，格式: INSERT INTO table (col1, col2) VALUES (v1, v2)');
            
            const tableName = match[1];
            const table = databases[currentDatabase].tables[tableName];
            if (!table) throw new Error(`表 '${tableName}' 不存在`);

            const tableKey = `${currentDatabase}.${tableName}`;
            const tableDataArray = useTableStorage ? await getTableData(currentDatabase, tableName) : table.data;
            
            const colNames = match[2].split(',').map(c => c.trim());
            const values = parseValues(match[3]);
            
            if (colNames.length !== values.length) {
                throw new Error('列数与值数不匹配');
            }
            
            const row = {};
            
            // 处理自增主键
            for (const col of table.columns) {
                if (col.autoIncrement) {
                    const maxId = tableDataArray.reduce((max, r) => Math.max(max, r[col.name] || 0), 0);
                    row[col.name] = maxId + 1;
                }
            }
            
            // 填充值
            for (let i = 0; i < colNames.length; i++) {
                const normalized = resolveColumnNameFromTable(table, colNames[i]);
                row[normalized] = values[i];
            }
            
            // 检查主键唯一性
            for (const col of table.columns) {
                if (col.primaryKey && row[col.name] !== undefined) {
                    const exists = tableDataArray.some(r => r[col.name] === row[col.name]);
                    if (exists) throw new Error(`主键 '${col.name}' 值 '${row[col.name]}' 已存在`);
                }
            }

            // 检查唯一索引
            if (table.indexes) {
                for (const [idxName, idx] of Object.entries(table.indexes || {})) {
                    if (!idx || !idx.unique) continue;
                    const cols = Array.isArray(idx.columns) ? idx.columns : [];
                    if (cols.length === 0) continue;
                    const valuesNow = cols.map(c => getRowValueCaseInsensitive(row, c));
                    if (valuesNow.some(v => v === null || v === undefined)) continue;
                    const dup = tableDataArray.some(r => cols.every((c, i) => getRowValueCaseInsensitive(r, c) == valuesNow[i]));
                    if (dup) throw new Error(`唯一索引约束失败: ${idxName}(${cols.join(', ')}) 已存在相同值`);
                }
            }
            
            // 检查外键约束
            if (table.foreignKeys && table.foreignKeys.length > 0) {
                for (const fk of table.foreignKeys) {
                    const val = row[fk.column];
                    if (val !== null && val !== undefined) {
                        const refTable = databases[currentDatabase].tables[fk.refTable];
                        if (refTable) {
                            const refData = useTableStorage ? await getTableData(currentDatabase, fk.refTable) : refTable.data;
                            const exists = refData.some(r => r[fk.refColumn] == val);
                            if (!exists) throw new Error(`外键约束失败: ${fk.column}=${val} 在 ${fk.refTable}.${fk.refColumn} 中不存在`);
                        }
                    }
                }
            }
            
            tableDataArray.push(row);

            if (table.indexes && Object.keys(table.indexes).length > 0) {
                rebuildIndexDataForTable(table, tableDataArray);
            }

            if (useTableStorage) {
                if (inTransaction) {
                    transactionModifiedTables.add(tableKey);
                } else {
                    const saveResult = await saveTableData(currentDatabase, tableName, true);
                    if (saveResult && !saveResult.ok) throw new Error(saveResult.errorMessage || '保存失败');
                }
            }

            if (table.indexes && Object.keys(table.indexes).length > 0) {
                await persistCurrentDbMetadata();
            }
            
            return { type: 'message', message: `成功插入 1 行数据`, status: 'success' };
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
            
            if (current.trim()) {
                values.push(parseValue(current.trim()));
            }
            
            return values;
        }

        function parseValue(val) {
            if (val.toUpperCase() === 'NULL') return null;
            if (val.startsWith("'") || val.startsWith('"')) {
                return val.slice(1, -1);
            }
            const num = Number(val);
            return isNaN(num) ? val : num;
        }

        async function executeSelect(sql) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            
            // 检查是否包含JOIN
            if (sql.toUpperCase().includes(' JOIN ')) {
                return await executeJoinSelect(sql);
            }
            
            // 检查DISTINCT
            const hasDistinct = /SELECT\s+DISTINCT\s+/i.test(sql);
            const sqlNorm = sql.replace(/SELECT\s+DISTINCT\s+/i, 'SELECT ');
            
            // 解析SELECT（支持聚合函数、GROUP BY、LIMIT OFFSET）
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

            const tableKey = `${currentDatabase}.${tableName}`;
            const tableDataArray = useTableStorage ? await getTableData(currentDatabase, tableName) : table.data;
            let data = [...tableDataArray];
            let usedIndexName = null;
            
            // WHERE 过滤
            if (whereClause) {
                const indexHit = tryApplyIndexWhere(table, tableDataArray, whereClause);
                if (indexHit && indexHit.indexName) {
                    usedIndexName = indexHit.indexName;
                    data = (indexHit.rows || []).filter(row => evaluateWhere(row, whereClause));
                } else {
                    data = data.filter(row => evaluateWhere(row, whereClause));
                }
            }
            
            // 检查是否有聚合函数
            const hasAggregate = /\b(COUNT|SUM|AVG|MAX|MIN)\s*\(/i.test(selectCols);
            
            if (hasAggregate || groupBy) {
                const aggRes = executeAggregateSelect(selectCols, data, table, groupBy, havingClause, orderBy, orderDir, limit);
                if (usedIndexName && aggRes && aggRes.message) {
                    aggRes.message += ` | 使用索引: ${usedIndexName}`;
                }
                return aggRes;
            }
            
            // ORDER BY 排序
            if (orderBy) {
                const col = orderBy.includes('.') ? orderBy.split('.')[1] : orderBy;
                data.sort((a, b) => {
                    const va = a[col], vb = b[col];
                    if (va < vb) return orderDir === 'ASC' ? -1 : 1;
                    if (va > vb) return orderDir === 'ASC' ? 1 : -1;
                    return 0;
                });
            }
            
            // LIMIT OFFSET 分页
            if (limit) {
                data = data.slice(offset, offset + limit);
            } else if (offset) {
                data = data.slice(offset);
            }
            
            // 选择列
            let columns = selectCols === '*' ? table.columns.map(c => c.name) : selectCols.split(',').map(c => c.trim().split('.').pop().replace(/^DISTINCT\s+/i, ''));
            
            // 投影
            let projectedData = data.map(row => {
                const newRow = {};
                for (const col of columns) {
                    newRow[col] = row[col] !== undefined ? row[col] : null;
                }
                return newRow;
            });

            // DISTINCT 去重
            if (hasDistinct) {
                const seen = new Set();
                projectedData = projectedData.filter(row => {
                    const key = JSON.stringify(row);
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
            }
            
            const pkCol = table.columns.find(c => c.primaryKey);
            return {
                type: 'table',
                columns,
                data: projectedData,
                message: `查询到 ${projectedData.length} 行数据${hasDistinct ? ' (已去重)' : ''}${usedIndexName ? ` | 使用索引: ${usedIndexName}` : ''}`,
                meta: {
                    kind: 'select',
                    tableName,
                    pkColumn: pkCol ? pkCol.name : null
                }
            };
        }

        // 聚合查询处理
        function executeAggregateSelect(selectCols, data, table, groupBy, havingClause, orderBy, orderDir, limit) {
            const aggregateFuncs = {
                COUNT: (arr, col) => col === '*' ? arr.length : arr.filter(r => r[col] !== null && r[col] !== undefined).length,
                SUM: (arr, col) => arr.reduce((sum, r) => sum + (Number(r[col]) || 0), 0),
                AVG: (arr, col) => { const vals = arr.filter(r => r[col] !== null); return vals.length ? vals.reduce((s, r) => s + Number(r[col]), 0) / vals.length : 0; },
                MAX: (arr, col) => Math.max(...arr.map(r => r[col]).filter(v => v !== null && v !== undefined)),
                MIN: (arr, col) => Math.min(...arr.map(r => r[col]).filter(v => v !== null && v !== undefined))
            };
            
            // 解析选择的列和聚合函数
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
                if (def.type === 'agg') {
                    requiredAggMap.set(`${def.func}(${def.col})`, { func: def.func, col: def.col });
                }
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
                // GROUP BY 分组
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
                
                // HAVING 过滤
                if (havingClause) {
                    result = result.filter(row => evaluateWhere(row, havingClause));
                }
            } else {
                // 无分组，整表聚合
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
            
            // ORDER BY
            if (orderBy) {
                result.sort((a, b) => {
                    const va = a[orderBy], vb = b[orderBy];
                    if (va < vb) return orderDir === 'ASC' ? -1 : 1;
                    if (va > vb) return orderDir === 'ASC' ? 1 : -1;
                    return 0;
                });
            }
            
            // LIMIT
            if (limit) result = result.slice(0, limit);
            
            return { type: 'table', columns, data: result, message: `聚合查询到 ${result.length} 行数据` };
        }

        // 多表JOIN查询
        async function executeJoinSelect(sql) {
            // 解析: SELECT cols FROM t1 [alias] JOIN t2 [alias] ON condition [WHERE ...] [ORDER BY ...] [LIMIT ...]
            const joinMatch = sql.match(/SELECT\s+(.*?)\s+FROM\s+(\w+)(?:\s+(\w+))?\s+JOIN\s+(\w+)(?:\s+(\w+))?\s+ON\s+(.+?)(?:\s+WHERE\s+(.+))?$/i);
            
            if (!joinMatch) throw new Error('JOIN 语法错误，格式: SELECT cols FROM t1 JOIN t2 ON t1.col = t2.col');
            
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

            const tableKey1 = `${currentDatabase}.${table1Name}`;
            const tableKey2 = `${currentDatabase}.${table2Name}`;
            const data1 = useTableStorage ? await getTableData(currentDatabase, table1Name) : table1.data;
            const data2 = useTableStorage ? await getTableData(currentDatabase, table2Name) : table2.data;
            
            // 解析ON条件 (支持 t1.col = t2.col 格式)
            const onMatch = onCondition.match(/([\w.]+)\s*=\s*([\w.]+)/);
            if (!onMatch) throw new Error('ON 条件语法错误');
            
            const leftCol = onMatch[1].includes('.') ? onMatch[1].split('.')[1] : onMatch[1];
            const rightCol = onMatch[2].includes('.') ? onMatch[2].split('.')[1] : onMatch[2];
            
            // 执行内连接
            let joinedData = [];
            for (const row1 of data1) {
                for (const row2 of data2) {
                    if (row1[leftCol] == row2[rightCol]) {
                        const merged = {};
                        // 添加表1数据(带别名前缀避免冲突)
                        for (const col of table1.columns) {
                            merged[`${alias1}.${col.name}`] = row1[col.name];
                            merged[col.name] = row1[col.name]; // 也保留无前缀版本
                        }
                        // 添加表2数据
                        for (const col of table2.columns) {
                            merged[`${alias2}.${col.name}`] = row2[col.name];
                            if (merged[col.name] === undefined) merged[col.name] = row2[col.name];
                        }
                        joinedData.push(merged);
                    }
                }
            }
            
            // WHERE 过滤
            if (whereClause) {
                joinedData = joinedData.filter(row => evaluateWhere(row, whereClause));
            }
            
            // 解析选择的列
            let columns = [];
            if (selectCols === '*') {
                columns = [...table1.columns.map(c => `${alias1}.${c.name}`), ...table2.columns.map(c => `${alias2}.${c.name}`)];
            } else {
                columns = selectCols.split(',').map(c => c.trim());
                // 处理 t.* 格式
                const expandedCols = [];
                for (const col of columns) {
                    if (col.endsWith('.*')) {
                        const tAlias = col.split('.')[0];
                        const tName = tAlias === alias1 ? table1Name : (tAlias === alias2 ? table2Name : tAlias);
                        const t = databases[currentDatabase].tables[tName];
                        if (t) expandedCols.push(...t.columns.map(c => `${tAlias}.${c.name}`));
                    } else {
                        expandedCols.push(col);
                    }
                }
                columns = expandedCols;
            }
            
            // 投影
            const projectedData = joinedData.map(row => {
                const newRow = {};
                for (const col of columns) {
                    const key = col.includes('.') ? col : col;
                    newRow[col] = row[col] ?? row[key] ?? null;
                }
                return newRow;
            });
            
            return { type: 'table', columns, data: projectedData, message: `JOIN查询到 ${projectedData.length} 行数据` };
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
            // 支持 =, !=, <>, <, >, <=, >=, LIKE, BETWEEN, IN
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
            
            // BETWEEN ... AND ...
            match = condition.match(/^\s*([\w.]+|\w+\s*\(\s*(?:\*|\w+)\s*\))\s+BETWEEN\s+(.+?)\s+AND\s+(.+)\s*$/i);
            if (match) {
                const val = resolveVal(match[1]);
                const min = parseValue(match[2].trim());
                const max = parseValue(match[3].trim());
                return val >= min && val <= max;
            }
            
            // NOT IN (val1, val2, ...)
            match = condition.match(/^\s*([\w.]+|\w+\s*\(\s*(?:\*|\w+)\s*\))\s+NOT\s+IN\s*\(([^)]+)\)\s*$/i);
            if (match) {
                const val = resolveVal(match[1]);
                const values = match[2].split(',').map(v => parseValue(v.trim()));
                return !values.some(v => v == val);
            }

            // IN (val1, val2, ...)
            match = condition.match(/^\s*([\w.]+|\w+\s*\(\s*(?:\*|\w+)\s*\))\s+IN\s*\(([^)]+)\)\s*$/i);
            if (match) {
                const val = resolveVal(match[1]);
                const values = match[2].split(',').map(v => parseValue(v.trim()));
                return values.some(v => v == val);
            }
            
            // LIKE
            match = condition.match(/^\s*([\w.]+|\w+\s*\(\s*(?:\*|\w+)\s*\))\s+LIKE\s+'([^']+)'\s*$/i);
            if (match) {
                const val = resolveVal(match[1]);
                const pattern = match[2].replace(/%/g, '.*').replace(/_/g, '.');
                return new RegExp(`^${pattern}$`, 'i').test(val);
            }
            
            // IS NULL / IS NOT NULL
            match = condition.match(/^\s*([\w.]+|\w+\s*\(\s*(?:\*|\w+)\s*\))\s+IS\s+(NOT\s+)?NULL\s*$/i);
            if (match) {
                const val = resolveVal(match[1]);
                return match[2] ? val !== null && val !== undefined : val === null || val === undefined;
            }
            
            // 比较运算符
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
            return false;
        }

        function normalizeAggExpr(expr) {
            const m = expr.trim().match(/^(COUNT|SUM|AVG|MAX|MIN)\s*\(\s*(\*|\w+)\s*\)$/i);
            if (!m) return null;
            return `${m[1].toUpperCase()}(${m[2]})`;
        }

        async function executeUpdate(sql) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            
            const match = sql.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/i);
            if (!match) throw new Error('UPDATE 语法错误');
            
            const tableName = match[1];
            const setClause = match[2];
            const whereClause = match[3];
            
            const table = databases[currentDatabase].tables[tableName];
            if (!table) throw new Error(`表 '${tableName}' 不存在`);

            const tableKey = `${currentDatabase}.${tableName}`;
            const tableDataArray = useTableStorage ? await getTableData(currentDatabase, tableName) : table.data;
            const snapshot = tableDataArray ? JSON.parse(JSON.stringify(tableDataArray)) : null;
            
            // 解析 SET (保存表达式字符串，每行单独计算)
            const updateExprs = [];
            const setParts = setClause.split(',');
            for (const part of setParts) {
                const eqIdx = part.indexOf('=');
                if (eqIdx === -1) throw new Error('SET 子句语法错误');
                const col = resolveColumnNameFromTable(table, part.substring(0, eqIdx).trim());
                const expr = part.substring(eqIdx + 1).trim();
                updateExprs.push({ col, expr });
            }
            
            // 计算表达式值的函数
            function evalExpr(expr, row) {
                // 检查是否是算术表达式 (如 age+1, price*0.9)
                const arithMatch = expr.match(/^(\w+)\s*([+\-*\/])\s*(\d+\.?\d*)$/);
                if (arithMatch) {
                    const colName = resolveColumnNameFromTable(table, arithMatch[1]);
                    const op = arithMatch[2];
                    const num = parseFloat(arithMatch[3]);
                    const colVal = parseFloat(row[colName]) || 0;
                    switch (op) {
                        case '+': return colVal + num;
                        case '-': return colVal - num;
                        case '*': return colVal * num;
                        case '/': return num !== 0 ? colVal / num : 0;
                    }
                }
                return parseValue(expr);
            }
            
            try {
                let count = 0;
                for (const row of tableDataArray) {
                    if (!whereClause || evaluateWhere(row, whereClause)) {
                        for (const { col, expr } of updateExprs) {
                            row[col] = evalExpr(expr, row);
                        }
                        count++;
                    }
                }

                if (count > 0 && table.indexes && Object.keys(table.indexes).length > 0) {
                    ensurePrimaryKeyUnique(table, tableDataArray);
                    ensureUniqueIndexes(table, tableDataArray);
                    rebuildIndexDataForTable(table, tableDataArray);
                }

                if (useTableStorage && count > 0) {
                    if (inTransaction) {
                        transactionModifiedTables.add(tableKey);
                    } else {
                        const saveResult = await saveTableData(currentDatabase, tableName, true);
                        if (saveResult && !saveResult.ok) throw new Error(saveResult.errorMessage || '保存失败');
                    }
                }

                if (count > 0 && table.indexes && Object.keys(table.indexes).length > 0) {
                    await persistCurrentDbMetadata();
                }
                
                return { type: 'message', message: `成功更新 ${count} 行数据`, status: 'success' };
            } catch (e) {
                if (snapshot && Array.isArray(tableDataArray)) {
                    tableDataArray.length = 0;
                    tableDataArray.push(...snapshot);
                    if (table.indexes && Object.keys(table.indexes).length > 0) {
                        rebuildIndexDataForTable(table, tableDataArray);
                    }
                }
                throw e;
            }
        }

        async function executeDelete(sql) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            
            const match = sql.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/i);
            if (!match) throw new Error('DELETE 语法错误');
            
            const tableName = match[1];
            const whereClause = match[2];
            
            const table = databases[currentDatabase].tables[tableName];
            if (!table) throw new Error(`表 '${tableName}' 不存在`);

            const tableKey = `${currentDatabase}.${tableName}`;
            const tableDataArray = useTableStorage ? await getTableData(currentDatabase, tableName) : table.data;
            
            // 找出要删除的行
            const toDelete = whereClause ? tableDataArray.filter(row => evaluateWhere(row, whereClause)) : [...tableDataArray];
            
            const modifiedTables = new Set();
            const pkCol = table.columns.find(c => c.primaryKey);
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

                    for (const [otherTableName, otherTable] of Object.entries(databases[currentDatabase].tables)) {
                        if (otherTableName === refTableName) continue;
                        const fks = otherTable.foreignKeys || [];
                        for (const fk of fks) {
                            if (!fk || !fk.refTable || !fk.refColumn || !fk.column) continue;
                            if (String(fk.refTable).toLowerCase() !== refTableLower || String(fk.refColumn).toLowerCase() !== refColumnLower) continue;

                            const otherData = useTableStorage ? await getTableData(currentDatabase, otherTableName) : otherTable.data;
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

            let indexTouched = false;
            for (const t of modifiedTables) {
                const tbl = databases[currentDatabase].tables[t];
                if (!tbl || !tbl.indexes || Object.keys(tbl.indexes).length === 0) continue;
                const dataArr = useTableStorage ? await getTableData(currentDatabase, t) : tbl.data;
                rebuildIndexDataForTable(tbl, dataArr);
                indexTouched = true;
            }

            if (useTableStorage) {
                if (inTransaction) {
                    for (const t of modifiedTables) {
                        transactionModifiedTables.add(`${currentDatabase}.${t}`);
                    }
                } else {
                    for (const t of modifiedTables) {
                        const saveResult = await saveTableData(currentDatabase, t, true);
                        if (saveResult && !saveResult.ok) throw new Error(saveResult.errorMessage || '保存失败');
                    }
                }
            }
            if (indexTouched) {
                await persistCurrentDbMetadata();
            }
            return { type: 'message', message: `成功删除 ${deletedCount} 行数据`, status: 'success' };
        }

        async function executeAlterTable(sql) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            let match;

            const persistCurrentDbMetadata = async () => {
                if (!useTableStorage) return;
                if (inTransaction) {
                    transactionModifiedDatabases.add(currentDatabase);
                    return;
                }
                const saveResult = await saveMetadata(currentDatabase);
                if (!saveResult || !saveResult.ok) {
                    throw new Error(saveResult && saveResult.errorMessage ? saveResult.errorMessage : '保存元数据失败');
                }
                localStorage.setItem('minisql_metadata', JSON.stringify({ databases, tableVersions }));
            };

            // ALTER TABLE ADD FOREIGN KEY (必须在 ADD COLUMN 之前检查)
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
                if (!table.columns.find(c => c.name.toLowerCase() === column.toLowerCase())) throw new Error(`列 '${column}' 不存在`);

                const refTableObj = databases[currentDatabase].tables[refTable];
                if (!refTableObj) throw new Error(`引用的表 '${refTable}' 不存在`);
                if (!refTableObj.columns.find(c => c.name.toLowerCase() === refColumn.toLowerCase())) throw new Error(`引用的列 '${refTable}.${refColumn}' 不存在`);

                if (!table.foreignKeys) table.foreignKeys = [];
                if (table.foreignKeys.find(fk => fk.column.toLowerCase() === column.toLowerCase())) throw new Error(`列 '${column}' 已有外键约束`);

                // 验证现有数据满足外键约束
                const refData = useTableStorage ? await getTableData(currentDatabase, refTable) : refTableObj.data;
                const tableDataArray = useTableStorage ? await getTableData(currentDatabase, tableName) : table.data;
                const refValues = new Set(refData.map(r => r[refColumn]));
                for (const row of tableDataArray) {
                    const val = row[column];
                    if (val !== null && val !== undefined && !refValues.has(val)) {
                        throw new Error(`无法添加外键：现有数据 ${column}=${val} 在 ${refTable}.${refColumn} 中不存在`);
                    }
                }

                table.foreignKeys.push({ name: constraintName, column, refTable, refColumn, onDelete, onUpdate });

                await persistCurrentDbMetadata();
                return { type: 'message', message: `成功添加外键约束 '${constraintName}': ${tableName}(${column}) → ${refTable}(${refColumn})`, status: 'success' };
            }

            // ALTER TABLE DROP FOREIGN KEY (必须在 DROP COLUMN 之前检查)
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
                return { type: 'message', message: `成功删除外键约束 '${fkName}'`, status: 'success' };
            }

            // ALTER TABLE ADD COLUMN
            match = sql.match(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+)\s+(\w+)(?:\s*\((\d+)\))?/i);
            if (match) {
                const tableName = match[1];
                const table = databases[currentDatabase].tables[tableName];
                if (!table) throw new Error(`表 '${tableName}' 不存在`);
                const newCol = { name: match[2], type: match[3].toUpperCase(), size: match[4] ? parseInt(match[4]) : null, primaryKey: false, notNull: false };
                table.columns.push(newCol);
                await persistCurrentDbMetadata();
                return { type: 'message', message: `成功添加列 '${newCol.name}'`, status: 'success' };
            }

            // ALTER TABLE DROP COLUMN
            match = sql.match(/ALTER\s+TABLE\s+(\w+)\s+DROP\s+(?:COLUMN\s+)?(\w+)/i);
            if (match) {
                const tableName = match[1], colName = match[2];
                const table = databases[currentDatabase].tables[tableName];
                if (!table) throw new Error(`表 '${tableName}' 不存在`);
                const colIndex = table.columns.findIndex(c => c.name.toLowerCase() === colName.toLowerCase());
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
                        if (fk.refTable.toLowerCase() === tableName.toLowerCase() && fk.refColumn.toLowerCase() === colName.toLowerCase()) {
                            referencing.push(`${otherTableName}.${fk.column}`);
                        }
                    }
                }
                if (referencing.length > 0) {
                    throw new Error(`无法删除列 '${tableName}.${colName}'：被外键引用（请先删除相关外键）: ${referencing.join(', ')}`);
                }

                table.columns.splice(colIndex, 1);
                table.data.forEach(row => delete row[colName]);
                await persistCurrentDbMetadata();
                return { type: 'message', message: `成功删除列 '${colName}'`, status: 'success' };
            }

            // ALTER TABLE MODIFY COLUMN (修改字段类型)
            match = sql.match(/ALTER\s+TABLE\s+(\w+)\s+MODIFY\s+(?:COLUMN\s+)?(\w+)\s+(\w+)(?:\s*\((\d+)\))?/i);
            if (match) {
                const tableName = match[1], colName = match[2];
                const table = databases[currentDatabase].tables[tableName];
                if (!table) throw new Error(`表 '${tableName}' 不存在`);
                const col = table.columns.find(c => c.name.toLowerCase() === colName.toLowerCase());
                if (!col) throw new Error(`列 '${colName}' 不存在`);
                col.type = match[3].toUpperCase();
                col.size = match[4] ? parseInt(match[4]) : null;
                await persistCurrentDbMetadata();
                return { type: 'message', message: `成功修改列 '${colName}' 类型为 ${col.type}${col.size ? `(${col.size})` : ''}`, status: 'success' };
            }

            // ALTER TABLE RENAME COLUMN (重命名字段)
            match = sql.match(/ALTER\s+TABLE\s+(\w+)\s+RENAME\s+COLUMN\s+(\w+)\s+TO\s+(\w+)/i);
            if (match) {
                const tableName = match[1], oldColName = match[2], newColName = match[3];
                const table = databases[currentDatabase].tables[tableName];
                if (!table) throw new Error(`表 '${tableName}' 不存在`);
                const col = table.columns.find(c => c.name.toLowerCase() === oldColName.toLowerCase());
                if (!col) throw new Error(`列 '${oldColName}' 不存在`);
                if (table.columns.find(c => c.name.toLowerCase() === newColName.toLowerCase())) throw new Error(`列 '${newColName}' 已存在`);
                col.name = newColName;
                table.data.forEach(row => { row[newColName] = row[oldColName]; delete row[oldColName]; });
                await persistCurrentDbMetadata();
                return { type: 'message', message: `成功将列 '${oldColName}' 重命名为 '${newColName}'`, status: 'success' };
            }

            throw new Error('ALTER TABLE 语法错误，支持: ADD, DROP, MODIFY, RENAME COLUMN, ADD/DROP FOREIGN KEY');
        }

        async function executeTruncate(sql) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            
            const match = sql.match(/TRUNCATE\s+(?:TABLE\s+)?(\w+)/i);
            if (!match) throw new Error('TRUNCATE 语法错误');
            
            const tableName = match[1];
            const table = databases[currentDatabase].tables[tableName];
            if (!table) throw new Error(`表 '${tableName}' 不存在`);
            const tableKey = `${currentDatabase}.${tableName}`;
            const tableDataArray = useTableStorage ? await getTableData(currentDatabase, tableName) : table.data;

            const count = tableDataArray.length;
            tableDataArray.length = 0;

            if (table.indexes && Object.keys(table.indexes).length > 0) {
                rebuildIndexDataForTable(table, tableDataArray);
            }

            if (useTableStorage) {
                if (inTransaction) {
                    transactionModifiedTables.add(tableKey);
                } else {
                    const saveResult = await saveTableData(currentDatabase, tableName, true);
                    if (saveResult && !saveResult.ok) throw new Error(saveResult.errorMessage || '保存失败');
                }
            }

            if (table.indexes && Object.keys(table.indexes).length > 0) {
                await persistCurrentDbMetadata();
            }

            return { type: 'message', message: `成功清空表 '${tableName}'，删除 ${count} 行`, status: 'success' };
        }

        // ==================== 索引功能 ====================
        async function executeCreateIndex(sql) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            
            // CREATE [UNIQUE] INDEX idx_name ON table_name (col1, col2, ...)
            const match = sql.match(/CREATE\s+(UNIQUE\s+)?INDEX\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]+)\)/i);
            if (!match) throw new Error('CREATE INDEX 语法错误。格式: CREATE [UNIQUE] INDEX idx_name ON table (col1, col2)');
            
            const isUnique = !!match[1];
            const indexName = match[2];
            const tableName = match[3];
            const columns = match[4].split(',').map(c => c.trim());
            
            const table = databases[currentDatabase].tables[tableName];
            if (!table) throw new Error(`表 '${tableName}' 不存在`);

            const tableDataArray = useTableStorage ? await getTableData(currentDatabase, tableName) : table.data;
            const normalizedColumns = columns.map(c => resolveColumnNameFromTable(table, c));
            
            // 验证列存在
            for (const col of normalizedColumns) {
                if (!table.columns.find(c => c.name.toLowerCase() === col.toLowerCase())) {
                    throw new Error(`列 '${col}' 不存在于表 '${tableName}'`);
                }
            }
            
            // 初始化索引存储
            if (!table.indexes) table.indexes = {};
            if (table.indexes[indexName]) throw new Error(`索引 '${indexName}' 已存在`);
            
            // 如果是唯一索引，检查数据唯一性
            if (isUnique && tableDataArray.length > 0) {
                const seen = new Set();
                for (const row of tableDataArray) {
                    const values = normalizedColumns.map(c => getRowValueCaseInsensitive(row, c));
                    if (values.some(v => v === null || v === undefined)) continue;
                    const key = values.map(v => String(v)).join('|');
                    if (seen.has(key)) throw new Error(`无法创建唯一索引：列 (${normalizedColumns.join(', ')}) 存在重复值`);
                    seen.add(key);
                }
            }
            
            // 创建索引（构建B树模拟结构）
            const indexData = {};
            tableDataArray.forEach((row, idx) => {
                const key = normalizedColumns.map(c => {
                    const v = getRowValueCaseInsensitive(row, c);
                    return v === undefined || v === null ? '' : String(v);
                }).join('|');
                if (!indexData[key]) indexData[key] = [];
                indexData[key].push(idx);
            });
            
            table.indexes[indexName] = {
                name: indexName,
                columns: normalizedColumns,
                unique: isUnique,
                data: indexData,
                createdAt: new Date().toISOString()
            };

            await persistCurrentDbMetadata();
            
            return { type: 'message', message: `成功创建${isUnique ? '唯一' : ''}索引 '${indexName}' ON ${tableName}(${normalizedColumns.join(', ')})`, status: 'success' };
        }
        
        async function executeDropIndex(sql) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            
            // DROP INDEX idx_name ON table_name
            const match = sql.match(/DROP\s+INDEX\s+(\w+)\s+ON\s+(\w+)/i);
            if (!match) throw new Error('DROP INDEX 语法错误。格式: DROP INDEX idx_name ON table');
            
            const indexName = match[1];
            const tableName = match[2];
            
            const table = databases[currentDatabase].tables[tableName];
            if (!table) throw new Error(`表 '${tableName}' 不存在`);
            if (!table.indexes || !table.indexes[indexName]) throw new Error(`索引 '${indexName}' 不存在`);
            
            delete table.indexes[indexName];

            await persistCurrentDbMetadata();
            
            return { type: 'message', message: `成功删除索引 '${indexName}'`, status: 'success' };
        }
        
        function executeShowIndexes(sql) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            
            // SHOW INDEXES FROM table_name 或 SHOW INDEX FROM table_name
            const match = sql.match(/SHOW\s+INDEX(?:ES)?\s+(?:FROM|ON)\s+(\w+)/i);
            if (!match) throw new Error('SHOW INDEXES 语法错误。格式: SHOW INDEXES FROM table');
            
            const tableName = match[1];
            const table = databases[currentDatabase].tables[tableName];
            if (!table) throw new Error(`表 '${tableName}' 不存在`);
            
            const indexes = table.indexes || {};
            const data = [];
            
            // 主键索引
            const pkCol = table.columns.find(c => c.primaryKey);
            if (pkCol) {
                data.push({ Table: tableName, Index_name: 'PRIMARY', Unique: 'YES', Columns: pkCol.name, Type: 'BTREE' });
            }
            
            // 用户创建的索引
            for (const [name, idx] of Object.entries(indexes)) {
                data.push({
                    Table: tableName,
                    Index_name: name,
                    Unique: idx.unique ? 'YES' : 'NO',
                    Columns: idx.columns.join(', '),
                    Type: 'BTREE'
                });
            }
            
            if (data.length === 0) {
                return { type: 'message', message: `表 '${tableName}' 没有索引`, status: 'info' };
            }
            
            return { type: 'table', columns: ['Table', 'Index_name', 'Unique', 'Columns', 'Type'], data, message: `共 ${data.length} 个索引` };
        }
        
        function executeShowForeignKeys(sql) {
            if (!currentDatabase) throw new Error('请先选择数据库');
            
            // SHOW FOREIGN KEYS FROM table_name
            const match = sql.match(/SHOW\s+(?:FOREIGN\s+KEYS|REFERENCES)\s+(?:FROM|ON)\s+(\w+)/i);
            if (!match) throw new Error('SHOW FOREIGN KEYS 语法错误。格式: SHOW FOREIGN KEYS FROM table');
            
            const tableName = match[1];
            const table = databases[currentDatabase].tables[tableName];
            if (!table) throw new Error(`表 '${tableName}' 不存在`);
            
            const foreignKeys = table.foreignKeys || [];
            
            if (foreignKeys.length === 0) {
                return { type: 'message', message: `表 '${tableName}' 没有外键约束`, status: 'info' };
            }
            
            const data = foreignKeys.map(fk => ({
                Constraint: fk.name || `fk_${fk.column}`,
                Column: fk.column,
                References: `${fk.refTable}(${fk.refColumn})`,
                On_Delete: fk.onDelete || 'RESTRICT',
                On_Update: fk.onUpdate || 'RESTRICT'
            }));
            
            return { type: 'table', columns: ['Constraint', 'Column', 'References', 'On_Delete', 'On_Update'], data, message: `共 ${data.length} 个外键约束` };
        }

        // ==================== 结果展示 ====================
        let lastQueryResult = null; // 存储最后查询结果用于导出
        
        function displayResult(result) {
            const area = document.getElementById('result-area');
            const info = document.getElementById('result-info');
            const exportBtn = document.getElementById('export-csv-btn');
            
            if (result.type === 'message') {
                showResult(result.message, result.status);
                exportBtn.style.display = 'none';
                return;
            }
            
            if (result.type === 'table') {
                info.textContent = result.message || '';
                lastQueryResult = result; // 存储结果
                
                if (result.data.length === 0) {
                    area.innerHTML = '<div class="empty-state">查询结果为空</div>';
                    exportBtn.style.display = 'none';
                    return;
                }
                
                exportBtn.style.display = 'inline-block'; // 显示导出按钮

                const canRowDelete = (() => {
                    if (!enableRowDelete) return false;
                    const meta = result.meta;
                    if (!meta || meta.kind !== 'select') return false;
                    if (!meta.tableName || !meta.pkColumn) return false;
                    if (!currentDatabase || !databases[currentDatabase] || !databases[currentDatabase].tables) return false;
                    if (!databases[currentDatabase].tables[meta.tableName]) return false;
                    return Array.isArray(result.columns) && result.columns.includes(meta.pkColumn);
                })();
                
                let html = '<div class="result-table-wrapper"><table><thead><tr>';
                for (const col of result.columns) {
                    html += `<th>${col}</th>`;
                }
                if (canRowDelete) {
                    html += '<th>操作</th>';
                }
                html += '</tr></thead><tbody>';
                
                for (let i = 0; i < result.data.length; i++) {
                    const row = result.data[i];
                    html += '<tr>';
                    for (const col of result.columns) {
                        const val = row[col];
                        html += `<td>${val === null ? '<span style="color:#666">NULL</span>' : val}</td>`;
                    }
                    if (canRowDelete) {
                        html += `<td><button class="btn btn-xs btn-danger" onclick="deleteResultRow(${i})" title="删除该行">🗑</button></td>`;
                    }
                    html += '</tr>';
                }
                
                html += '</tbody></table></div>';
                area.innerHTML = html;
            }
        }

        async function deleteResultRow(rowIndex) {
            try {
                if (!enableRowDelete) {
                    showResult('行删除已关闭：请先在右上角勾选“启用行删除”', 'info');
                    return;
                }
                if (!lastQueryResult || lastQueryResult.type !== 'table') return;
                const meta = lastQueryResult.meta;
                if (!meta || meta.kind !== 'select') {
                    showResult('当前结果不支持行删除（仅支持单表SELECT且包含主键列）', 'error');
                    return;
                }
                
                const tableName = meta.tableName;
                const pkColumn = meta.pkColumn;
                if (!tableName || !pkColumn) {
                    showResult('当前结果不支持行删除（缺少表名或主键列）', 'error');
                    return;
                }
                if (!Array.isArray(lastQueryResult.data) || rowIndex < 0 || rowIndex >= lastQueryResult.data.length) return;
                const row = lastQueryResult.data[rowIndex];
                const pkVal = row ? row[pkColumn] : undefined;
                if (pkVal === null || pkVal === undefined) {
                    showResult('当前行无法删除：主键值为空', 'error');
                    return;
                }

                if (!confirm(`确定删除 ${tableName} 表中该行数据吗？\n${pkColumn} = ${pkVal}`)) return;

                const sqlLiteral = (v) => {
                    if (v === null || v === undefined) return 'NULL';
                    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
                    if (typeof v === 'boolean') return v ? '1' : '0';
                    return `'${String(v).replace(/'/g, "''")}'`;
                };

                const sql = `DELETE FROM ${tableName} WHERE ${pkColumn} = ${sqlLiteral(pkVal)}`;
                const result = await executeDelete(sql);
                displayResult(result);

                lastQueryResult.data.splice(rowIndex, 1);

                lastQueryResult.message = `查询到 ${lastQueryResult.data.length} 行数据`;
                displayResult(lastQueryResult);
                renderTableList();
            } catch (e) {
                showResult('删除失败: ' + e.message, 'error');
            }
        }
        
        // 导出查询结果为CSV
        function exportResultToCSV() {
            if (!lastQueryResult || !lastQueryResult.data.length) {
                alert('没有可导出的数据');
                return;
            }
            const { columns, data } = lastQueryResult;
            let csv = columns.join(',') + '\n';
            for (const row of data) {
                csv += columns.map(col => {
                    const val = row[col];
                    if (val === null || val === undefined) return '';
                    const str = String(val);
                    return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
                }).join(',') + '\n';
            }
            const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `query_result_${new Date().toISOString().slice(0,10)}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        }

        function showResult(message, type) {
            const area = document.getElementById('result-area');
            area.innerHTML = `<div class="message-box ${type}">${message}</div>`;
        }

        // 初始化
        init();