(function () {
  'use strict';

  // 页面状态：用例、环境与变量、请求头草稿、预览结果与最近一次响应
  const state = {
    cases: [],
    selectedId: '',
    headers: [{ key: '', value: '' }],
    demos: [],
    busy: false,
    result: null,
    resultView: 'structured',
    environments: [],
    activeEnvId: '',
    // 当前编辑中的环境变量行（含末尾空白草稿行），切换环境时整体替换
    envDraft: [],
    envLoaded: false,
    preview: null,
  };

  const dom = {
    health: document.getElementById('health-badge'),
    notice: document.getElementById('notice'),
    name: document.getElementById('field-name'),
    method: document.getElementById('field-method'),
    url: document.getElementById('field-url'),
    body: document.getElementById('field-body'),
    headerRows: document.getElementById('header-rows'),
    addHeader: document.getElementById('add-header'),
    demos: document.getElementById('demo-list'),
    demoSummary: document.getElementById('demo-summary'),
    sendRequest: document.getElementById('send-request'),
    saveCase: document.getElementById('save-case'),
    resetDraft: document.getElementById('reset-draft'),
    resultBody: document.getElementById('result-body'),
    resultSummary: document.getElementById('result-summary'),
    clearResult: document.getElementById('clear-result'),
    caseList: document.getElementById('case-list'),
    caseSummary: document.getElementById('case-summary'),
    refreshCases: document.getElementById('refresh-cases'),
    caseDetail: document.getElementById('case-detail'),
    closeDetail: document.getElementById('close-detail'),
    envSelect: document.getElementById('env-select'),
    envEditor: document.getElementById('env-editor'),
    addEnv: document.getElementById('add-env'),
    envSummary: document.getElementById('env-summary'),
    activeEnvHint: document.getElementById('active-env-hint'),
    previewBody: document.getElementById('preview-body'),
    previewEnvTag: document.getElementById('preview-env-tag'),
  };

  const emptyDetailHint = '在用例列表点「详情」，这里显示该用例保存下来的目标地址、请求头与请求内容。';
  // 结构化视图最多铺开的层级条目数量，避免内容过大时页面卡顿
  const TREE_LIMIT = 800;
  let noticeTimer = 0;

  // ---------------- 模板变量引擎（与 server/template.js 规则保持一致） ----------------

  const VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
  const TOKEN_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

  function isValidVariableName(name) {
    return typeof name === 'string' && VAR_NAME_PATTERN.test(name);
  }

  // 扫描一段文本里的全部 {{变量名}}，给出位置、原文与去空白后的名字
  function scanTokens(text) {
    const source = String(text == null ? '' : text);
    const tokens = [];
    TOKEN_PATTERN.lastIndex = 0;
    let match = null;
    while ((match = TOKEN_PATTERN.exec(source)) !== null) {
      tokens.push({ raw: match[0], name: match[1].trim(), index: match.index, end: match.index + match[0].length });
    }
    return tokens;
  }

  // 按变量表替换；查不到的占位符保留原文并标记 defined:false，由调用方决定是否拦截
  function renderText(text, varMap) {
    const source = String(text == null ? '' : text);
    const tokens = [];
    let output = '';
    let cursor = 0;
    scanTokens(source).forEach((token) => {
      output += source.slice(cursor, token.index);
      const defined = varMap.has(token.name);
      const value = defined ? varMap.get(token.name) : '';
      tokens.push({ ...token, defined, value });
      output += defined ? value : token.raw;
      cursor = token.end;
    });
    output += source.slice(cursor);
    return { text: output, tokens };
  }

  // 把当前环境草稿整理成变量表；重名行以第一条为准，重名本身在变量区另行报错
  function buildVarMap() {
    const map = new Map();
    state.envDraft.forEach((row) => {
      const key = row.key.trim();
      if (key && !map.has(key)) map.set(key, row.value);
    });
    return map;
  }

  function activeEnvironment() {
    return state.environments.find((item) => item.id === state.activeEnvId) || null;
  }

  // ---------------- 后端交互 ----------------

  // 统一请求入口：把服务端返回的错误码与出错位置打包进异常对象
  async function request(path, options) {
    const config = options || {};
    const init = { method: config.method || 'GET' };
    if (config.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(config.body);
    }

    let response = null;
    try {
      response = await fetch(path, init);
    } catch (err) {
      const error = new Error('无法连接服务，请确认服务已启动');
      error.code = 'NETWORK_ERROR';
      error.field = '';
      throw error;
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      payload = null;
    }

    if (!response.ok) {
      const info = (payload && payload.error) || {};
      const error = new Error(info.message || `操作失败（状态码 ${response.status}）`);
      error.code = info.code || 'request_failed';
      error.field = typeof info.field === 'string' ? info.field : '';
      throw error;
    }
    return payload;
  }

  function setBusy(busy, activeAction) {
    state.busy = busy;
    dom.sendRequest.disabled = busy;
    dom.saveCase.disabled = busy;
    dom.resetDraft.disabled = busy;
    dom.refreshCases.disabled = busy;
    dom.addEnv.disabled = busy;
    dom.envSelect.disabled = busy;
    dom.sendRequest.textContent = busy && activeAction === 'send' ? '发送中…' : '发送请求';
    dom.saveCase.textContent = busy && activeAction === 'save' ? '正在保存…' : '保存为用例';
  }

  // ---------------- 页面消息与出错标记 ----------------

  function showNotice(message, type) {
    dom.notice.textContent = message;
    dom.notice.className = `notice notice-${type || 'info'}`;
    dom.notice.hidden = false;
    window.clearTimeout(noticeTimer);
    const stay = type === 'error' ? 6000 : 3500;
    noticeTimer = window.setTimeout(() => {
      dom.notice.hidden = true;
    }, stay);
  }

  function clearFieldErrors() {
    document.querySelectorAll('.field-error').forEach((node) => {
      node.hidden = true;
      node.textContent = '';
    });
    [dom.name, dom.url, dom.body, dom.headerRows].forEach((node) => node.classList.remove('invalid'));
    dom.headerRows.querySelectorAll('input').forEach((node) => node.classList.remove('invalid'));
  }

  // 服务端给出的位置可能是 headers.2.key 这种形式，标记时按区块归位
  function normalizeField(field) {
    if (typeof field !== 'string' || !field) return '';
    const key = field.split('.')[0];
    return ['name', 'method', 'url', 'headers', 'body'].includes(key) ? key : '';
  }

  function showFieldError(field, message) {
    const key = normalizeField(field);
    if (!key) return;
    const slot = document.querySelector(`[data-error="${key}"]`);
    if (slot) {
      slot.textContent = message;
      slot.hidden = false;
    }
    const target = {
      name: dom.name,
      method: dom.method,
      url: dom.url,
      headers: dom.headerRows,
      body: dom.body,
    }[key];
    if (target) target.classList.add('invalid');
    // headers.0.key 这类位置再精确标到具体那一行的输入框
    const match = /^headers\.(\d+)\.(key|value)$/.exec(field);
    if (match) {
      const input = dom.headerRows.querySelector(`input[data-index="${match[1]}"][data-part="${match[2]}"]`);
      if (input) input.classList.add('invalid');
    }
  }

  // ---------------- 请求区 ----------------

  function renderHeaderRows() {
    dom.headerRows.textContent = '';
    if (!state.headers.length) {
      const empty = document.createElement('p');
      empty.className = 'rows-empty';
      empty.textContent = '暂无请求头';
      dom.headerRows.appendChild(empty);
      return;
    }

    state.headers.forEach((row, index) => {
      const line = document.createElement('div');
      line.className = 'header-row';

      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'header-key';
      keyInput.value = row.key;
      keyInput.autocomplete = 'off';
      keyInput.dataset.index = String(index);
      keyInput.dataset.part = 'key';
      keyInput.setAttribute('aria-label', `第 ${index + 1} 行请求头名称`);

      const valueInput = document.createElement('input');
      valueInput.type = 'text';
      valueInput.className = 'header-value';
      valueInput.value = row.value;
      valueInput.autocomplete = 'off';
      valueInput.dataset.index = String(index);
      valueInput.dataset.part = 'value';
      valueInput.setAttribute('aria-label', `第 ${index + 1} 行请求头取值`);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-ghost btn-small';
      remove.textContent = '删除';
      remove.dataset.action = 'remove-header';
      remove.dataset.index = String(index);

      line.append(keyInput, valueInput, remove);
      dom.headerRows.appendChild(line);
    });
  }

  function collectDraft() {
    return {
      name: dom.name.value.trim(),
      method: dom.method.value,
      url: dom.url.value.trim(),
      headers: state.headers.map((row) => ({ key: row.key.trim(), value: row.value })),
      body: dom.body.value,
      environmentId: state.activeEnvId,
    };
  }

  // 把一份请求内容写回表单，既用于示例接口填入，也用于用例回填
  function fillDraft(draft) {
    dom.name.value = typeof draft.name === 'string' ? draft.name : '';
    dom.method.value = draft.method || 'GET';
    dom.url.value = draft.url || '';
    dom.body.value = typeof draft.body === 'string' ? draft.body : '';
    state.headers = Array.isArray(draft.headers) && draft.headers.length
      ? draft.headers.map((row) => ({
          key: typeof row.key === 'string' ? row.key : '',
          value: typeof row.value === 'string' ? row.value : '',
        }))
      : [{ key: '', value: '' }];
    renderHeaderRows();
    clearFieldErrors();
    updatePreview();
  }

  function resetDraft(silent) {
    fillDraft({ name: '', method: 'GET', url: '', headers: [], body: '' });
    if (!silent) showNotice('草稿已清空', 'info');
  }

  // ---------------- 环境管理 ----------------

  async function loadEnvironments() {
    const data = await request('/api/environments');
    state.environments = Array.isArray(data.environments) ? data.environments : [];
    state.activeEnvId = data.activeEnvironmentId || (state.environments[0] && state.environments[0].id) || '';
    state.envLoaded = true;
    syncEnvDraft();
    renderEnvSelect();
    renderEnvEditor();
    updatePreview();
  }

  // 用当前生效环境的变量覆盖编辑草稿，末尾留一条空行方便继续录入
  function syncEnvDraft() {
    const env = activeEnvironment();
    state.envDraft = env ? env.variables.map((row) => ({ key: row.key, value: row.value })) : [];
    state.envDraft.push({ key: '', value: '' });
  }

  function renderEnvSelect() {
    dom.envSelect.textContent = '';
    state.environments.forEach((env) => {
      const option = document.createElement('option');
      option.value = env.id;
      option.textContent = env.name;
      option.selected = env.id === state.activeEnvId;
      dom.envSelect.appendChild(option);
    });
    dom.envSummary.textContent = `共 ${state.environments.length} 个环境`;
    const current = activeEnvironment();
    dom.activeEnvHint.textContent = current ? `生效中：${current.name} · ${current.variables.length} 个变量` : '';
  }

  function renderEnvEditor() {
    const env = activeEnvironment();
    dom.envEditor.textContent = '';
    if (!env) {
      dom.envEditor.appendChild(buildTextNote('还没有任何环境，请先新增一个环境。'));
      return;
    }

    // 环境名与环境级操作
    const head = document.createElement('div');
    head.className = 'env-head';

    const nameBox = document.createElement('div');
    nameBox.className = 'env-name-box';
    const nameNode = document.createElement('span');
    nameNode.className = 'env-name';
    nameNode.textContent = env.name;
    const countNode = document.createElement('span');
    countNode.className = 'counter';
    countNode.textContent = `${env.variables.length} 个变量`;
    nameBox.append(nameNode, countNode);

    const actions = document.createElement('div');
    actions.className = 'case-actions';

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'btn btn-small';
    renameBtn.textContent = '重命名';
    renameBtn.addEventListener('click', () => startRenameEnv(env, head, nameBox));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-small btn-danger';
    deleteBtn.textContent = '删除环境';
    deleteBtn.disabled = state.environments.length <= 1;
    deleteBtn.title = state.environments.length <= 1 ? '至少要保留一个环境' : '';
    deleteBtn.addEventListener('click', () => removeEnvironment(env));

    actions.append(renameBtn, deleteBtn);
    head.append(nameBox, actions);
    dom.envEditor.appendChild(head);

    // 变量逐行录入区
    const rowsBox = document.createElement('div');
    rowsBox.className = 'var-rows';
    state.envDraft.forEach((row, index) => rowsBox.appendChild(buildVarRow(row, index)));
    dom.envEditor.appendChild(rowsBox);

    const varErrorSlot = document.createElement('p');
    varErrorSlot.className = 'field-error var-error-slot';
    varErrorSlot.hidden = true;
    dom.envEditor.appendChild(varErrorSlot);

    const addVarBtn = document.createElement('button');
    addVarBtn.type = 'button';
    addVarBtn.className = 'btn btn-small';
    addVarBtn.textContent = '添加变量';
    addVarBtn.addEventListener('click', () => {
      state.envDraft.push({ key: '', value: '' });
      renderEnvEditor();
      const inputs = dom.envEditor.querySelectorAll('.var-key');
      if (inputs.length) inputs[inputs.length - 1].focus();
      scheduleFlushVariables();
    });
    dom.envEditor.appendChild(addVarBtn);

    paintVariableErrors();
  }

  function buildVarRow(row, index) {
    const line = document.createElement('div');
    line.className = 'var-row';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'var-key';
    keyInput.value = row.key;
    keyInput.autocomplete = 'off';
    keyInput.placeholder = '变量名，如 host';
    keyInput.dataset.varIndex = String(index);

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.className = 'var-value';
    valueInput.value = row.value;
    valueInput.autocomplete = 'off';
    valueInput.placeholder = '变量取值，如 127.0.0.1:5051';
    valueInput.dataset.varIndex = String(index);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-ghost btn-small';
    remove.textContent = '删除';
    remove.dataset.varIndex = String(index);
    remove.addEventListener('click', () => removeVariable(index));

    const rowError = document.createElement('p');
    rowError.className = 'field-error var-row-error';
    rowError.hidden = true;

    const grid = document.createElement('div');
    grid.className = 'var-row-grid';
    grid.append(keyInput, valueInput, remove);
    line.append(grid, rowError);
    return line;
  }

  // 行内即时校验：空名、非法名、同环境重名，全部指出是第几条
  function collectVariableIssues() {
    const issues = [];
    const seen = new Map();
    state.envDraft.forEach((row, index) => {
      const key = row.key.trim();
      if (!key && !row.value) return; // 整行空的是待录入草稿
      if (!key) {
        issues.push({ index, kind: 'empty', message: `第 ${index + 1} 条变量的名称为空，请补全变量名或删掉这一条` });
        return;
      }
      if (!isValidVariableName(key)) {
        issues.push({
          index,
          kind: 'invalid',
          message: `第 ${index + 1} 条变量名「${key}」不成立：需以字母或下划线开头，只能包含字母、数字、下划线与中划线`,
        });
        return;
      }
      if (seen.has(key)) {
        issues.push({ index, kind: 'duplicate', message: `第 ${index + 1} 条变量名「${key}」与第 ${seen.get(key) + 1} 条重名，同一环境下不允许重名` });
        return;
      }
      seen.set(key, index);
    });
    return issues;
  }

  function paintVariableErrors() {
    const issues = collectVariableIssues();
    const slot = dom.envEditor.querySelector('.var-error-slot');
    dom.envEditor.querySelectorAll('.var-row').forEach((line) => line.classList.remove('invalid'));
    dom.envEditor.querySelectorAll('.var-row-error').forEach((node) => {
      node.hidden = true;
      node.textContent = '';
    });
    dom.envEditor.querySelectorAll('.var-key').forEach((node) => node.classList.remove('invalid'));

    issues.forEach((issue) => {
      const row = dom.envEditor.querySelectorAll('.var-row')[issue.index];
      if (!row) return;
      row.classList.add('invalid');
      const keyInput = row.querySelector('.var-key');
      if (keyInput) keyInput.classList.add('invalid');
      const rowError = row.querySelector('.var-row-error');
      if (rowError) {
        rowError.textContent = issue.message;
        rowError.hidden = false;
      }
    });
    if (slot && issues.length) {
      slot.textContent = `当前环境有 ${issues.length} 条变量不成立，修正前不会保存，也无法用于请求替换`;
      slot.hidden = false;
    }
    return issues;
  }

  // 防抖保存：输入停顿后把整份变量清单 PUT 给服务端
  let flushTimer = 0;
  function scheduleFlushVariables() {
    window.clearTimeout(flushTimer);
    flushTimer = window.setTimeout(() => {
      flushVariables(false);
    }, 300);
  }

  async function flushVariables(force) {
    const env = activeEnvironment();
    if (!env) return true;
    const issues = paintVariableErrors();
    if (issues.length) {
      if (force) {
        showNotice(`变量清单还没有修正：${issues[0].message}`, 'error');
        const row = dom.envEditor.querySelectorAll('.var-key')[issues[0].index];
        if (row) row.focus();
      }
      return false;
    }
    const rows = state.envDraft
      .map((row) => ({ key: row.key.trim(), value: row.value }))
      .filter((row) => row.key || row.value);
    try {
      const saved = await request(`/api/environments/${encodeURIComponent(env.id)}/variables`, {
        method: 'PUT',
        body: { variables: rows },
      });
      env.variables = saved.variables;
      renderEnvSelect();
      updatePreview();
      return true;
    } catch (err) {
      showNotice(err.message, 'error');
      return false;
    }
  }

  async function removeVariable(index) {
    const env = activeEnvironment();
    if (!env) return;
    const row = state.envDraft[index];
    const key = row ? row.key.trim() : '';
    if (!key) {
      // 还没取名的空白草稿行直接移除，不需要结论
      state.envDraft.splice(index, 1);
      if (!state.envDraft.length) state.envDraft.push({ key: '', value: '' });
      renderEnvEditor();
      return;
    }

    // 删除前给出明确结论：其他环境是否仍有同名变量、请求区是否还在引用它
    const otherEnvs = state.environments
      .filter((item) => item.id !== env.id && item.variables.some((v) => v.key === key))
      .map((item) => item.name);
    const refs = describeTemplateReferences(key);
    const lines = [`确认在环境「${env.name}」中删除变量「${key}」？`];
    if (otherEnvs.length) {
      lines.push(`其他环境（${otherEnvs.join('、')}）里仍定义有同名变量，这些环境下的 {{${key}}} 不受影响；本次只会删掉「${env.name}」里的取值。`);
    }
    if (refs.length) {
      if (otherEnvs.length) {
        lines.push(`但当前请求区仍在引用它：${refs.join('、')}。在「${env.name}」下这些位置将变成未定义变量，本环境发送会被拦下。`);
      } else {
        lines.push(`删除后所有环境都不再有「${key}」，而当前请求区仍在引用它：${refs.join('、')}。这些位置会变成未定义变量，请求将无法发送。`);
      }
    }
    if (!otherEnvs.length && !refs.length) {
      lines.push('其他环境与当前请求区都没有再引用这个变量。');
    }
    const confirmed = window.confirm(lines.join('\n'));
    if (!confirmed) return;

    state.envDraft.splice(index, 1);
    if (!state.envDraft.length) state.envDraft.push({ key: '', value: '' });
    const ok = await flushVariables(true);
    if (ok) {
      renderEnvEditor();
      showNotice(`变量「${key}」已从环境「${env.name}」删除`, 'success');
    } else {
      // 保存失败时回滚本次删除
      await loadEnvironments();
    }
  }

  // 找出请求区模板里引用某变量名的位置描述
  function describeTemplateReferences(key) {
    const refs = [];
    if (scanTokens(dom.url.value).some((t) => t.name === key)) refs.push('目标地址');
    state.headers.forEach((row, index) => {
      if (scanTokens(row.key).some((t) => t.name === key) || scanTokens(row.value).some((t) => t.name === key)) {
        refs.push(`第 ${index + 1} 行请求头`);
      }
    });
    if (scanTokens(dom.body.value).some((t) => t.name === key)) refs.push('请求内容');
    return refs;
  }

  async function createEnvironment() {
    if (state.busy) return;
    if (!(await flushVariables(true))) return;
    try {
      const data = await request('/api/environments', { method: 'POST', body: {} });
      await loadEnvironments();
      showNotice(`已新增并切换到环境「${data.environment.name}」，可在下方逐条添加变量`, 'success');
      // 直接聚焦到第一条变量名输入框
      const firstKey = dom.envEditor.querySelector('.var-key');
      if (firstKey) firstKey.focus();
    } catch (err) {
      showNotice(err.message, 'error');
    }
  }

  async function switchEnvironment(envId) {
    if (envId === state.activeEnvId || state.busy) {
      renderEnvSelect();
      return;
    }
    if (!(await flushVariables(true))) {
      renderEnvSelect(); // 留在原环境
      return;
    }
    try {
      await request(`/api/environments/${encodeURIComponent(envId)}/active`, { method: 'PUT' });
      state.activeEnvId = envId;
      syncEnvDraft();
      renderEnvSelect();
      renderEnvEditor();
      updatePreview();
      const env = activeEnvironment();
      showNotice(`当前生效环境已切换为「${env ? env.name : ''}」，预览已按新环境刷新`, 'success');
    } catch (err) {
      showNotice(err.message, 'error');
      renderEnvSelect();
    }
  }

  function startRenameEnv(env, head, nameBox) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'env-rename-input';
    input.value = env.name;
    input.maxLength = 40;

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn btn-small btn-primary';
    confirmBtn.textContent = '确定';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-small';
    cancelBtn.textContent = '取消';

    const errorNode = document.createElement('p');
    errorNode.className = 'field-error';
    errorNode.hidden = true;

    const editBox = document.createElement('div');
    editBox.className = 'env-rename-box';
    const btnLine = document.createElement('div');
    btnLine.className = 'case-actions';
    btnLine.append(confirmBtn, cancelBtn);
    editBox.append(input, btnLine, errorNode);

    head.replaceChild(editBox, nameBox);
    input.focus();
    input.select();

    async function submit() {
      const name = input.value.trim();
      if (!name) {
        errorNode.textContent = '环境名称不能为空';
        errorNode.hidden = false;
        return;
      }
      try {
        await request(`/api/environments/${encodeURIComponent(env.id)}/name`, {
          method: 'PATCH',
          body: { name },
        });
        env.name = name;
        renderEnvSelect();
        renderEnvEditor();
        updatePreview();
        showNotice(`环境已重命名为「${name}」`, 'success');
      } catch (err) {
        errorNode.textContent = err.message;
        errorNode.hidden = false;
      }
    }

    confirmBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', () => renderEnvEditor());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
      if (event.key === 'Escape') renderEnvEditor();
    });
  }

  async function removeEnvironment(env) {
    if (state.busy) return;
    if (state.environments.length <= 1) {
      showNotice('至少要保留一个环境，不能删除当前唯一的环境', 'error');
      return;
    }
    const confirmed = window.confirm(
      `确认删除环境「${env.name}」？该环境下的 ${env.variables.length} 个变量会一并删除，删除后无法恢复。` +
        (env.id === state.activeEnvId ? '\n该环境当前正在生效，删除后会自动切换到剩余环境中的第一个。' : '')
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      const data = await request(`/api/environments/${encodeURIComponent(env.id)}`, { method: 'DELETE' });
      state.activeEnvId = data.activeEnvironmentId;
      const list = await request('/api/environments');
      state.environments = list.environments;
      syncEnvDraft();
      renderEnvSelect();
      renderEnvEditor();
      updatePreview();
      showNotice(`环境「${data.name}」已删除`, 'success');
    } catch (err) {
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  // ---------------- 替换后校验与实际内容预览 ----------------

  function locationOf(part, index) {
    if (part === 'url') return { where: '目标地址', field: 'url' };
    if (part === 'body') return { where: '请求内容', field: 'body' };
    if (part === 'header-key') return { where: `第 ${index + 1} 行请求头的名称`, field: `headers.${index}.key` };
    return { where: `第 ${index + 1} 行请求头的取值`, field: `headers.${index}.value` };
  }

  function checkTokenIssues(part, rendered, index, issues) {
    const env = activeEnvironment();
    const envName = env ? env.name : '';
    rendered.tokens.forEach((token) => {
      const loc = locationOf(part, index);
      if (!token.name) {
        issues.push({ ...loc, message: `${loc.where}里有一个没写名字的变量（形如 {{}}），请补上变量名` });
      } else if (!isValidVariableName(token.name)) {
        issues.push({ ...loc, message: `${loc.where}里的变量名「${token.name}」不成立：需以字母或下划线开头，只能包含字母、数字、下划线与中划线` });
      } else if (!token.defined) {
        issues.push({
          ...loc,
          message: `${loc.where}引用的变量「${token.name}」在当前环境「${envName}」中没有定义，请先添加该变量或切换到定义了它的环境`,
        });
      }
    });
  }

  // 校验替换后的地址是否成立：/ 开头的内置路径不能有空格，其余必须是 http(s) 完整地址
  function checkResolvedUrl(value, issues) {
    const text = String(value || '').trim();
    if (!text) {
      issues.push({ where: '目标地址', field: 'url', message: '目标地址不能为空' });
      return;
    }
    if (text.startsWith('/')) {
      if (/\s/.test(text)) {
        issues.push({ where: '目标地址', field: 'url', message: '替换变量后的目标地址里出现了空格，请检查变量取值' });
      }
      return;
    }
    let parsed = null;
    try {
      parsed = new URL(text);
    } catch (err) {
      issues.push({ where: '目标地址', field: 'url', message: `替换变量后的目标地址「${text}」不成立：需要以 http:// 或 https:// 开头，或是 / 开头的内置接口路径` });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      issues.push({ where: '目标地址', field: 'url', message: '替换变量后的目标地址只支持 http 与 https 两种协议' });
    }
  }

  // 依据请求区当前内容与当前环境，算出替换结果与全部问题
  function evaluatePreview() {
    const draft = collectDraft();
    const varMap = buildVarMap();
    const issues = [];

    const urlRender = renderText(draft.url, varMap);
    checkTokenIssues('url', urlRender, -1, issues);
    if (draft.url) checkResolvedUrl(urlRender.text, issues);

    const headerRenders = draft.headers.map((row) => ({
      key: renderText(row.key, varMap),
      value: renderText(row.value, varMap),
    }));
    const seenHeader = new Set();
    const resolvedHeaders = [];
    headerRenders.forEach((rendered, index) => {
      checkTokenIssues('header-key', rendered.key, index, issues);
      checkTokenIssues('header-value', rendered.value, index, issues);
      const key = rendered.key.text.trim();
      const value = rendered.value.text;
      if (!key && !value.trim()) return;
      if (!key) {
        issues.push({ where: `第 ${index + 1} 行请求头`, field: `headers.${index}.key`, message: `第 ${index + 1} 行请求头替换变量后名称为空，请补充变量取值或改写模板` });
        return;
      }
      if (/[^!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(key)) {
        issues.push({ where: `第 ${index + 1} 行请求头`, field: `headers.${index}.key`, message: `第 ${index + 1} 行请求头名称「${key}」替换变量后含有非法字符` });
        return;
      }
      const lower = key.toLowerCase();
      if (seenHeader.has(lower)) {
        issues.push({ where: `第 ${index + 1} 行请求头`, field: `headers.${index}.key`, message: `第 ${index + 1} 行请求头「${key}」替换变量后与其他行重名` });
        return;
      }
      seenHeader.add(lower);
      resolvedHeaders.push({ key, value });
    });

    const bodyRender = renderText(draft.body, varMap);
    checkTokenIssues('body', bodyRender, -1, issues);
    if (bodyRender.text.trim()) {
      if (draft.method === 'GET' || draft.method === 'HEAD') {
        issues.push({ where: '请求内容', field: 'body', message: `请求方式为 ${draft.method} 时不带请求内容，请清空或更换请求方式` });
      } else {
        const contentType = resolvedHeaders.find((row) => row.key.toLowerCase() === 'content-type');
        if (contentType && contentType.value.toLowerCase().includes('json')) {
          try {
            JSON.parse(bodyRender.text);
          } catch (err) {
            issues.push({ where: '请求内容', field: 'body', message: `替换变量后的请求内容声明为 JSON 但解析不通过：${err.message}` });
          }
        }
      }
    }

    return {
      draft,
      urlRender,
      headerRenders,
      bodyRender,
      resolved: {
        method: draft.method,
        url: urlRender.text,
        headers: resolvedHeaders,
        body: bodyRender.text,
      },
      issues,
      ok: issues.length === 0,
    };
  }

  // 把含替换片段的文本铺成 DOM：普通文本原样、替换成功高亮为值、失败的占位符标红
  function appendRenderedText(container, source, tokens) {
    let cursor = 0;
    tokens.forEach((token) => {
      if (token.index > cursor) container.appendChild(document.createTextNode(source.slice(cursor, token.index)));
      if (token.defined && token.name && isValidVariableName(token.name)) {
        const chip = document.createElement('mark');
        chip.className = 'tpl-chip tpl-ok';
        const from = document.createElement('span');
        from.className = 'tpl-from';
        from.textContent = `{{${token.name}}} →`;
        chip.appendChild(from);
        const val = document.createElement('span');
        val.className = 'tpl-val';
        if (token.value === '') {
          val.textContent = '（空值）';
          val.classList.add('tpl-empty');
        } else {
          val.textContent = token.value;
        }
        chip.appendChild(val);
        chip.title = `变量「${token.name}」替换为：${token.value === '' ? '空字符串' : token.value}`;
        container.appendChild(chip);
      } else {
        const bad = document.createElement('mark');
        bad.className = 'tpl-chip tpl-bad';
        bad.textContent = token.raw;
        bad.title = token.name ? `变量「${token.name}」未在当前环境定义` : '变量名为空';
        container.appendChild(bad);
      }
      cursor = token.end;
    });
    if (cursor < source.length) container.appendChild(document.createTextNode(source.slice(cursor)));
  }

  function buildPreviewBlock(label, source, rendered, multiline) {
    const row = document.createElement('div');
    row.className = 'preview-row';
    const labelNode = document.createElement('span');
    labelNode.className = 'preview-label';
    labelNode.textContent = label;
    const valueNode = document.createElement(multiline ? 'pre' : 'p');
    valueNode.className = 'preview-value';
    if (!source) {
      valueNode.classList.add('preview-empty');
      valueNode.textContent = multiline ? '（无请求内容）' : '（未填写）';
    } else {
      appendRenderedText(valueNode, source, rendered.tokens);
    }
    row.append(labelNode, valueNode);
    return row;
  }

  function updatePreview() {
    if (!state.envLoaded) return;
    const result = evaluatePreview();
    state.preview = result;
    const env = activeEnvironment();

    dom.previewEnvTag.textContent = env ? `当前环境：${env.name}` : '未选择环境';
    dom.previewEnvTag.className = result.ok ? 'panel-tag' : 'panel-tag panel-tag-bad';
    dom.previewBody.textContent = '';

    // 顶部状态条：能不能发出去在这里一目了然
    const status = document.createElement('p');
    status.className = result.ok ? 'preview-status preview-ok' : 'preview-status preview-bad';
    status.textContent = result.ok
      ? '替换结果成立，请求可以按下面的实际内容发出'
      : `替换后有 ${result.issues.length} 处不成立，已拦截发送，请先修正`;
    dom.previewBody.appendChild(status);

    if (!result.ok) {
      const list = document.createElement('ul');
      list.className = 'preview-issues';
      result.issues.forEach((issue) => {
        const item = document.createElement('li');
        const where = document.createElement('span');
        where.className = 'preview-issue-where';
        where.textContent = issue.where;
        item.append(where, document.createTextNode(`：${issue.message}`));
        list.appendChild(item);
      });
      dom.previewBody.appendChild(list);
    }

    dom.previewBody.appendChild(buildPreviewBlock('目标地址', result.draft.url, result.urlRender, false));

    const headerRow = document.createElement('div');
    headerRow.className = 'preview-row';
    const headerLabel = document.createElement('span');
    headerLabel.className = 'preview-label';
    headerLabel.textContent = '请求头';
    const headerBox = document.createElement('div');
    headerBox.className = 'preview-value preview-headers';
    if (!result.draft.headers.some((row) => row.key || row.value)) {
      const empty = document.createElement('p');
      empty.className = 'preview-empty';
      empty.textContent = '（暂无请求头）';
      headerBox.appendChild(empty);
    } else {
      result.draft.headers.forEach((row, index) => {
        const rendered = result.headerRenders[index];
        const line = document.createElement('div');
        line.className = 'preview-header-line';
        appendRenderedText(line, row.key, rendered.key.tokens);
        line.appendChild(document.createTextNode(': '));
        appendRenderedText(line, row.value, rendered.value.tokens);
        headerBox.appendChild(line);
      });
    }
    headerRow.append(headerLabel, headerBox);
    dom.previewBody.appendChild(headerRow);

    dom.previewBody.appendChild(buildPreviewBlock('请求内容', result.draft.body, result.bodyRender, true));
  }

  // ---------------- 内置示例接口 ----------------

  async function loadDemos() {
    try {
      const data = await request('/api/demos');
      state.demos = data && Array.isArray(data.endpoints) ? data.endpoints : [];
    } catch (err) {
      state.demos = [];
    }
    renderDemos();
  }

  function renderDemos() {
    dom.demos.textContent = '';
    if (!state.demos.length) {
      dom.demoSummary.textContent = '读取失败';
      const hint = document.createElement('p');
      hint.className = 'rows-empty';
      hint.textContent = '内置示例接口暂时读取不到，可以直接在目标地址里填写完整地址';
      dom.demos.appendChild(hint);
      return;
    }

    dom.demoSummary.textContent = `共 ${state.demos.length} 个`;
    state.demos.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'demo-item';

      const main = document.createElement('div');
      main.className = 'demo-main';

      const title = document.createElement('div');
      title.className = 'demo-title';
      const nameNode = document.createElement('span');
      nameNode.className = 'demo-name';
      nameNode.textContent = item.name;
      title.append(nameNode, buildTag(item.method, item.method === 'GET' ? 'get' : 'any'));

      const pathNode = document.createElement('p');
      pathNode.className = 'demo-path';
      pathNode.textContent = item.path;

      const summaryNode = document.createElement('p');
      summaryNode.className = 'demo-summary';
      summaryNode.textContent = item.summary;

      main.append(title, pathNode, summaryNode);

      const fill = document.createElement('button');
      fill.type = 'button';
      fill.className = 'btn btn-small';
      fill.textContent = '填入请求区';
      fill.addEventListener('click', () => {
        fillDraft(item.example);
        state.selectedId = '';
        renderCases();
        showNotice(`已把「${item.name}」填入请求区，点发送请求即可看到结果`, 'info');
      });

      row.append(main, fill);
      dom.demos.appendChild(row);
    });
  }

  // ---------------- 发送请求与结果展示 ----------------

  async function sendRequest() {
    if (state.busy) return;
    clearFieldErrors();

    // 先把环境变量区尚未落库的编辑保存掉，避免刚敲完取值就发送时服务端还是旧值
    await flushVariables(false);

    const draft = collectDraft();
    if (!draft.url) {
      showFieldError('url', '请填写目标地址');
      showNotice('请填写目标地址', 'error');
      dom.url.focus();
      return;
    }

    // 发送前最后一道关口：变量问题或替换后内容不成立，这一次绝不发出去
    const evaluation = evaluatePreview();
    state.preview = evaluation;
    if (!evaluation.ok) {
      const first = evaluation.issues[0];
      showFieldError(first.field, first.message);
      evaluation.issues.forEach((issue) => showFieldError(issue.field, issue.message));
      showNotice(`请求没有发出去：${first.where}存在问题——${first.message}`, 'error');
      const focusTarget = {
        url: dom.url,
        body: dom.body,
        headers: dom.headerRows.querySelector('input.invalid') || dom.headerRows.querySelector('input'),
      }[normalizeField(first.field)];
      if (focusTarget) focusTarget.focus();
      return;
    }

    setBusy(true, 'send');
    renderResultPending(draft);
    try {
      // 传模板原文与环境标识，由服务端按同一套规则替换并兜底校验
      const result = await request('/api/send', { method: 'POST', body: draft });
      state.result = result;
      renderResult(result);
      if (result.ok) {
        showNotice(`请求已完成：状态码 ${result.status}，耗时 ${formatDuration(result.timeMs)}`, 'success');
      } else {
        showNotice(`请求失败：${result.failure.reason}`, 'error');
      }
    } catch (err) {
      state.result = null;
      if (err.field) showFieldError(err.field, err.message);
      dom.resultSummary.textContent = '';
      dom.resultBody.textContent = '';
      dom.clearResult.hidden = false;
      dom.resultBody.appendChild(buildFailurePanel('这次请求没有发出去', err.message, ''));
      updatePreview();
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function renderResultPending(draft) {
    dom.resultSummary.textContent = '正在等待响应';
    dom.clearResult.hidden = true;
    dom.resultBody.textContent = '';

    const block = document.createElement('div');
    block.className = 'result-pending';
    const title = document.createElement('p');
    title.className = 'pending-title';
    title.textContent = '请求已发出，正在等待响应…';
    const sub = document.createElement('p');
    sub.className = 'empty-sub';
    sub.textContent = `${draft.method} ${state.preview ? state.preview.resolved.url : draft.url} 已按当前环境替换后的内容发出去，收到回应后这里会显示状态、耗时、响应头与响应内容。`;
    block.append(title, sub);
    dom.resultBody.appendChild(block);
  }

  function renderEmptyResult() {
    dom.resultSummary.textContent = '';
    dom.clearResult.hidden = true;
    dom.resultBody.textContent = '';
    dom.resultBody.appendChild(
      buildEmptyBlock(
        '还没有发送过请求',
        '填好请求方式与目标地址后点「发送请求」，这里会显示响应状态、耗时、响应头与响应内容。'
      )
    );
  }

  function renderResult(result) {
    dom.resultBody.textContent = '';
    dom.clearResult.hidden = false;

    const head = document.createElement('div');
    head.className = 'result-head';

    if (result.ok) {
      head.appendChild(buildStatusBadge(result.status, result.statusText));
      head.appendChild(buildChip(`耗时 ${formatDuration(result.timeMs)}`));
      head.appendChild(buildChip(`内容 ${formatBytes(result.size)}`));
      // 状态码落在 400 及以上时，页面同样按失败口径提醒
      if (result.status >= 400) head.appendChild(buildChip('本次响应为失败状态', 'chip-bad'));
      dom.resultSummary.textContent = `最近一次：${result.status} ${result.statusText}`.trim();
    } else {
      head.appendChild(buildStatusBadge(0, '未完成'));
      head.appendChild(buildChip(`已等待 ${formatDuration(result.timeMs)}`));
      dom.resultSummary.textContent = '最近一次：请求未完成';
    }
    dom.resultBody.appendChild(head);

    const targetLine = document.createElement('p');
    targetLine.className = 'result-target';
    targetLine.textContent = result.internal
      ? `目标地址（本机内置示例接口）：${result.targetUrl}`
      : `目标地址：${result.targetUrl}`;
    dom.resultBody.appendChild(targetLine);

    if (!result.ok) {
      dom.resultBody.appendChild(
        buildFailurePanel('请求没有完成', result.failure.reason, result.failure.detail)
      );
      return;
    }

    const headerSection = buildSection('响应头');
    if (result.headers.length) {
      headerSection.appendChild(buildHeaderTable(result.headers));
    } else {
      headerSection.appendChild(buildTextNote('本次响应没有返回响应头'));
    }
    dom.resultBody.appendChild(headerSection);

    const bodySection = buildSection('响应内容');
    bodySection.appendChild(buildBodyView(result));
    dom.resultBody.appendChild(bodySection);
  }

  function buildFailurePanel(title, reason, detail) {
    const panel = document.createElement('div');
    panel.className = 'failure-panel';

    const titleNode = document.createElement('p');
    titleNode.className = 'failure-title';
    titleNode.textContent = title;

    const reasonNode = document.createElement('p');
    reasonNode.className = 'failure-reason';
    reasonNode.textContent = `失败原因：${reason}`;

    panel.append(titleNode, reasonNode);

    if (detail) {
      const detailNode = document.createElement('p');
      detailNode.className = 'failure-detail';
      detailNode.textContent = `详细信息：${detail}`;
      panel.appendChild(detailNode);
    }
    return panel;
  }

  function buildBodyView(result) {
    const wrap = document.createElement('div');
    wrap.className = 'body-view';

    const text = typeof result.body === 'string' ? result.body : '';
    if (!text.trim()) {
      wrap.appendChild(buildTextNote(result.status === 204 ? '本次响应为成功且没有返回内容' : '本次响应没有返回内容'));
      return wrap;
    }

    const tabs = document.createElement('div');
    tabs.className = 'view-tabs';
    tabs.append(
      buildTab('结构化', state.resultView === 'structured', () => switchResultView('structured')),
      buildTab('原始文本', state.resultView === 'raw', () => switchResultView('raw'))
    );
    wrap.appendChild(tabs);

    const parsed = tryParseJson(text);
    if (state.resultView === 'raw') {
      wrap.appendChild(buildPre(text));
    } else if (parsed.ok) {
      wrap.appendChild(buildJsonTree(parsed.value, '', { left: TREE_LIMIT }));
    } else {
      wrap.appendChild(buildTextNote('响应内容不是结构化数据，已按文本显示'));
      wrap.appendChild(buildPre(text));
    }

    if (result.truncated) {
      wrap.appendChild(buildTextNote('响应内容较大，这里只保留了开头的一部分用于展示'));
    }
    return wrap;
  }

  function switchResultView(view) {
    state.resultView = view;
    if (state.result) renderResult(state.result);
  }

  function tryParseJson(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (err) {
      return { ok: false, value: null };
    }
  }

  function buildPre(text) {
    const pre = document.createElement('pre');
    pre.className = 'result-pre';
    pre.textContent = text;
    return pre;
  }

  // 结构化视图：对象与数组逐层铺开，取值按类型区分显示
  function buildJsonTree(value, label, counter) {
    counter.left -= 1;
    const node = document.createElement('div');
    node.className = 'json-node';

    if (value !== null && typeof value === 'object') {
      const isArray = Array.isArray(value);
      const keys = isArray ? value.map((_, index) => index) : Object.keys(value);

      const head = document.createElement('div');
      head.className = 'json-line';
      head.appendChild(buildJsonKey(label));
      head.appendChild(buildJsonTag(`${isArray ? '数组' : '对象'} ${keys.length} 项`));
      node.appendChild(head);

      const children = document.createElement('div');
      children.className = 'json-children';

      if (!keys.length) {
        children.appendChild(buildJsonLine('', isArray ? '空数组' : '空对象', 'empty'));
      } else {
        let shown = 0;
        for (let index = 0; index < keys.length; index += 1) {
          if (counter.left <= 0) break;
          const key = keys[index];
          children.appendChild(
            buildJsonTree(value[key], isArray ? `[${key}]` : String(key), counter)
          );
          shown += 1;
        }
        if (shown < keys.length) {
          children.appendChild(buildTextNote(`还有 ${keys.length - shown} 项未展开，可切换到原始文本查看完整内容`));
        }
      }

      node.appendChild(children);
      return node;
    }

    node.appendChild(buildJsonLine(label, describePrimitive(value), primitiveKind(value)));
    return node;
  }

  function buildJsonLine(label, text, kind) {
    const line = document.createElement('div');
    line.className = 'json-line';
    if (label) line.appendChild(buildJsonKey(label));
    const valueNode = document.createElement('span');
    valueNode.className = `json-value json-${kind}`;
    valueNode.textContent = text;
    line.appendChild(valueNode);
    return line;
  }

  function buildJsonKey(label) {
    const key = document.createElement('span');
    key.className = 'json-key';
    key.textContent = label || '整体内容';
    return key;
  }

  function buildJsonTag(text) {
    const tag = document.createElement('span');
    tag.className = 'json-tag';
    tag.textContent = text;
    return tag;
  }

  function describePrimitive(value) {
    if (value === null) return 'null';
    if (typeof value === 'string') return `"${value}"`;
    return String(value);
  }

  function primitiveKind(value) {
    if (value === null) return 'null';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    return 'string';
  }

  // ---------------- 用例区 ----------------

  async function loadCases() {
    const list = await request('/api/cases');
    state.cases = Array.isArray(list) ? list : [];
    if (state.selectedId && !state.cases.some((item) => item.id === state.selectedId)) {
      state.selectedId = '';
    }
    renderCases();
  }

  function renderCases() {
    dom.caseSummary.textContent = `共 ${state.cases.length} 条`;
    dom.caseList.textContent = '';

    if (!state.cases.length) {
      dom.caseList.appendChild(
        buildEmptyBlock('还没有保存过用例', '在请求区填好内容（可带 {{变量名}}）后点「保存为用例」，用例会出现在这里。')
      );
      return;
    }
    state.cases.forEach((item) => {
      dom.caseList.appendChild(buildCaseRow(item));
    });
  }

  function buildEmptyBlock(title, subtitle) {
    const block = document.createElement('div');
    block.className = 'empty';
    const titleNode = document.createElement('p');
    titleNode.className = 'empty-title';
    titleNode.textContent = title;
    const subNode = document.createElement('p');
    subNode.className = 'empty-sub';
    subNode.textContent = subtitle;
    block.append(titleNode, subNode);
    return block;
  }

  function buildTextNote(text) {
    const note = document.createElement('p');
    note.className = 'text-note';
    note.textContent = text;
    return note;
  }

  function buildTag(text, kind) {
    const tag = document.createElement('span');
    tag.className = `method method-${kind || 'any'}`;
    tag.textContent = text;
    return tag;
  }

  function buildCaseRow(item) {
    const row = document.createElement('article');
    row.className = 'case-item';
    if (item.id === state.selectedId) row.classList.add('active');

    const main = document.createElement('div');
    main.className = 'case-main';

    const title = document.createElement('div');
    title.className = 'case-title';
    const nameNode = document.createElement('span');
    nameNode.className = 'case-name';
    nameNode.textContent = item.name;
    title.append(buildTag(item.method, String(item.method).toLowerCase()), nameNode);
    if (item.url.startsWith('/')) title.appendChild(buildTag('内置', 'inner'));

    const urlNode = document.createElement('p');
    urlNode.className = 'case-url';
    urlNode.textContent = item.url;

    const metaNode = document.createElement('p');
    metaNode.className = 'case-meta';
    const hasToken = scanTokens(`${item.url}\n${item.body}\n${item.headers.map((r) => `${r.key} ${r.value}`).join('\n')}`).length > 0;
    metaNode.textContent = `请求头 ${item.headers.length} 行${hasToken ? ' · 含变量引用' : ''} · 保存于 ${formatTime(item.createdAt)}`;

    main.append(title, urlNode, metaNode);

    const actions = document.createElement('div');
    actions.className = 'case-actions';

    const fillButton = document.createElement('button');
    fillButton.type = 'button';
    fillButton.className = 'btn btn-small';
    fillButton.textContent = '回填';
    fillButton.addEventListener('click', () => {
      applyCase(item);
    });

    const viewButton = document.createElement('button');
    viewButton.type = 'button';
    viewButton.className = 'btn btn-small';
    viewButton.textContent = '详情';
    viewButton.addEventListener('click', () => {
      openDetail(item.id);
    });

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn-small btn-danger';
    deleteButton.textContent = '删除';
    deleteButton.addEventListener('click', () => {
      removeCase(item);
    });

    actions.append(fillButton, viewButton, deleteButton);
    row.append(main, actions);
    return row;
  }

  // 回填：把用例保存下来的模板写回请求区，发送时再按当前环境替换
  function applyCase(item) {
    if (state.busy) return;
    fillDraft(item);
    state.selectedId = item.id;
    renderCases();
    renderDetail(item);
    showNotice(`用例「${item.name}」已回填到请求区，其中的变量按当前环境替换后发送`, 'success');
  }

  async function openDetail(id) {
    if (state.busy) return;
    try {
      const item = await request(`/api/cases/${encodeURIComponent(id)}`);
      state.selectedId = item.id;
      renderCases();
      renderDetail(item);
    } catch (err) {
      showNotice(err.message, 'error');
      if (err.code === 'CASE_NOT_FOUND') {
        state.selectedId = '';
        renderEmptyDetail();
        try {
          await loadCases();
        } catch (reloadError) {
          showNotice(reloadError.message, 'error');
        }
      }
    }
  }

  function renderDetail(item) {
    dom.caseDetail.textContent = '';

    const head = document.createElement('div');
    head.className = 'detail-head';
    const nameNode = document.createElement('h3');
    nameNode.textContent = item.name;
    head.append(buildTag(item.method, String(item.method).toLowerCase()), nameNode);

    const fillButton = document.createElement('button');
    fillButton.type = 'button';
    fillButton.className = 'btn btn-small';
    fillButton.textContent = '回填到请求区';
    fillButton.addEventListener('click', () => {
      applyCase(item);
    });
    head.appendChild(fillButton);

    dom.caseDetail.append(head);
    dom.caseDetail.append(buildDetailRow('目标地址', item.url, false));
    dom.caseDetail.append(
      buildDetailRow(
        '请求头',
        item.headers.length ? item.headers.map((row) => `${row.key}: ${row.value}`).join('\n') : '暂无内容',
        true
      )
    );
    dom.caseDetail.append(buildDetailRow('请求内容', item.body || '暂无内容', true));
    dom.caseDetail.append(
      buildDetailRow('保存时间', `${formatTime(item.createdAt)}（最近更新 ${formatTime(item.updatedAt)}）`, false)
    );
    dom.closeDetail.hidden = false;
  }

  function buildDetailRow(label, text, block) {
    const wrap = document.createElement('div');
    wrap.className = 'detail-row';

    const labelNode = document.createElement('span');
    labelNode.className = 'detail-label';
    labelNode.textContent = label;

    const valueNode = document.createElement(block ? 'pre' : 'p');
    valueNode.className = 'detail-value';
    valueNode.textContent = text;

    wrap.append(labelNode, valueNode);
    return wrap;
  }

  function renderEmptyDetail() {
    dom.closeDetail.hidden = true;
    dom.caseDetail.textContent = '';
    const subNode = document.createElement('p');
    subNode.className = 'empty-sub';
    subNode.textContent = emptyDetailHint;
    dom.caseDetail.appendChild(subNode);
  }

  // ---------------- 保存与删除 ----------------

  async function saveCase() {
    if (state.busy) return;
    clearFieldErrors();

    const draft = collectDraft();
    if (!draft.name) {
      showFieldError('name', '请填写用例名称');
      showNotice('请填写用例名称', 'error');
      dom.name.focus();
      return;
    }
    if (!draft.url) {
      showFieldError('url', '请填写目标地址');
      showNotice('请填写目标地址', 'error');
      dom.url.focus();
      return;
    }

    setBusy(true, 'save');
    try {
      // 用例保存的是模板原文，变量在每次发送时按当时的生效环境替换
      const template = {
        name: draft.name,
        method: draft.method,
        url: draft.url,
        headers: draft.headers,
        body: draft.body,
      };
      const created = await request('/api/cases', { method: 'POST', body: template });
      state.selectedId = created.id;
      await loadCases();
      renderDetail(created);
      showNotice(`用例「${created.name}」已保存（模板原样保留，变量按发送时环境替换）`, 'success');
    } catch (err) {
      if (err.field) showFieldError(err.field, err.message);
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeCase(item) {
    if (state.busy) return;
    const confirmed = window.confirm(`确认删除用例「${item.name}」？删除后无法恢复。`);
    if (!confirmed) return;

    setBusy(true);
    try {
      await request(`/api/cases/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      if (state.selectedId === item.id) state.selectedId = '';
      await loadCases();
      if (!state.selectedId) renderEmptyDetail();
      showNotice(`用例「${item.name}」已删除`, 'success');
    } catch (err) {
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  // ---------------- 结果区小零件 ----------------

  function buildSection(title) {
    const section = document.createElement('div');
    section.className = 'result-section';
    const head = document.createElement('p');
    head.className = 'result-section-title';
    head.textContent = title;
    section.appendChild(head);
    return section;
  }

  function buildStatusBadge(code, statusText) {
    const badge = document.createElement('span');
    badge.className = 'status-badge';
    if (!code) {
      badge.classList.add('status-bad');
    } else if (code >= 500) {
      badge.classList.add('status-bad');
    } else if (code >= 400) {
      badge.classList.add('status-warn');
    } else if (code >= 300) {
      badge.classList.add('status-info');
    } else {
      badge.classList.add('status-ok');
    }
    badge.textContent = code ? `${code} ${statusText}`.trim() : statusText;
    return badge;
  }

  function buildChip(text, extraClass) {
    const chip = document.createElement('span');
    chip.className = extraClass ? `chip ${extraClass}` : 'chip';
    chip.textContent = text;
    return chip;
  }

  function buildTab(text, active, onClick) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = active ? 'view-tab active' : 'view-tab';
    tab.textContent = text;
    tab.addEventListener('click', onClick);
    return tab;
  }

  function buildHeaderTable(headers) {
    const list = document.createElement('div');
    list.className = 'header-table';
    headers.forEach((row) => {
      const line = document.createElement('div');
      line.className = 'header-line';
      const keyNode = document.createElement('span');
      keyNode.className = 'header-line-key';
      keyNode.textContent = row.key;
      const valueNode = document.createElement('span');
      valueNode.className = 'header-line-value';
      valueNode.textContent = row.value;
      line.append(keyNode, valueNode);
      list.appendChild(line);
    });
    return list;
  }

  // ---------------- 工具函数 ----------------

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '时间未知';
    const pad = (num) => String(num).padStart(2, '0');
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
  }

  function formatDuration(ms) {
    const value = Number(ms) || 0;
    if (value >= 1000) return `${(value / 1000).toFixed(2)} 秒`;
    return `${value} 毫秒`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} 字节`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
  }

  async function checkHealth() {
    try {
      await request('/api/health');
      dom.health.textContent = '服务已连接';
      dom.health.classList.add('ok');
    } catch (err) {
      dom.health.textContent = '服务未连接';
      dom.health.classList.add('bad');
    }
  }

  // ---------------- 事件绑定与入口 ----------------

  function bindEvents() {
    dom.headerRows.addEventListener('input', (event) => {
      const target = event.target;
      const index = Number(target.dataset ? target.dataset.index : NaN);
      const part = target.dataset ? target.dataset.part : '';
      if (!Number.isInteger(index) || !state.headers[index] || !part) return;
      state.headers[index][part] = target.value;
      const slot = document.querySelector('[data-error="headers"]');
      if (slot) slot.hidden = true;
      dom.headerRows.classList.remove('invalid');
      target.classList.remove('invalid');
      updatePreview();
    });

    dom.headerRows.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action="remove-header"]');
      if (!button) return;
      const index = Number(button.dataset.index);
      if (!Number.isInteger(index) || !state.headers[index]) return;
      state.headers.splice(index, 1);
      renderHeaderRows();
      updatePreview();
    });

    dom.addHeader.addEventListener('click', () => {
      state.headers.push({ key: '', value: '' });
      renderHeaderRows();
      const inputs = dom.headerRows.querySelectorAll('input');
      const last = inputs[inputs.length - 2];
      if (last) last.focus();
      updatePreview();
    });

    // 环境变量行：输入时实时刷新行内校验与预览，停顿后自动保存
    dom.envEditor.addEventListener('input', (event) => {
      const target = event.target;
      const index = Number(target.dataset ? target.dataset.varIndex : NaN);
      if (!Number.isInteger(index) || !state.envDraft[index]) return;
      if (target.classList.contains('var-key')) state.envDraft[index].key = target.value;
      if (target.classList.contains('var-value')) state.envDraft[index].value = target.value;
      paintVariableErrors();
      updatePreview();
      scheduleFlushVariables();
    });

    dom.envEditor.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.classList && event.target.classList.contains('var-value')) {
        event.preventDefault();
        flushVariables(false);
      }
    });

    dom.addEnv.addEventListener('click', createEnvironment);
    dom.envSelect.addEventListener('change', (event) => switchEnvironment(event.target.value));

    [dom.url, dom.body].forEach((node) => node.addEventListener('input', updatePreview));
    dom.method.addEventListener('change', updatePreview);

    dom.sendRequest.addEventListener('click', sendRequest);
    dom.saveCase.addEventListener('click', saveCase);

    dom.resetDraft.addEventListener('click', () => {
      if (state.busy) return;
      resetDraft(false);
    });

    dom.clearResult.addEventListener('click', () => {
      state.result = null;
      renderEmptyResult();
      showNotice('结果区已清空', 'info');
    });

    dom.refreshCases.addEventListener('click', async () => {
      if (state.busy) return;
      try {
        await loadCases();
        showNotice('用例列表已刷新', 'info');
      } catch (err) {
        showNotice(err.message, 'error');
      }
    });

    dom.closeDetail.addEventListener('click', () => {
      state.selectedId = '';
      renderCases();
      renderEmptyDetail();
    });
  }

  async function init() {
    bindEvents();
    renderHeaderRows();
    renderEmptyDetail();
    renderEmptyResult();
    renderCases();
    await checkHealth();
    await loadDemos();
    try {
      await loadEnvironments();
    } catch (err) {
      showNotice(err.message, 'error');
    }
    try {
      await loadCases();
    } catch (err) {
      showNotice(err.message, 'error');
    }
  }

  init();
})();
