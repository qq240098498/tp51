(function () {
  'use strict';

  // 页面状态：环境与变量、用例列表、内置示例接口、请求头草稿行、最近一次响应结果与结果视图
  const state = {
    cases: [],
    selectedId: '',
    headers: [{ key: '', value: '' }],
    demos: [],
    busy: false,
    result: null,
    resultView: 'structured',
    environments: [],
    activeEnvironmentId: '',
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
    previewBox: document.getElementById('preview-box'),
    previewSummary: document.getElementById('preview-summary'),
    previewEnvName: document.getElementById('preview-env-name'),
    envSelect: document.getElementById('env-select'),
    envSummary: document.getElementById('env-summary'),
    renameEnv: document.getElementById('rename-env'),
    deleteEnv: document.getElementById('delete-env'),
    newEnvName: document.getElementById('new-env-name'),
    addEnv: document.getElementById('add-env'),
    currentEnvTitle: document.getElementById('current-env-title'),
    varList: document.getElementById('var-list'),
    varSummary: document.getElementById('var-summary'),
    newVarKey: document.getElementById('new-var-key'),
    newVarValue: document.getElementById('new-var-value'),
    addVar: document.getElementById('add-var'),
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
  };

  const emptyDetailHint = '在用例列表点「详情」，这里显示该用例保存下来的目标地址、请求头与请求内容。';
  // 结构化视图最多铺开的层级条目数量，避免内容过大时页面卡顿
  const TREE_LIMIT = 800;
  let noticeTimer = 0;

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
      error.status = response.status;
      error.details = info.details && typeof info.details === 'object' ? info.details : null;
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
    dom.sendRequest.textContent = busy && activeAction === 'send' ? '发送中…' : '发送请求';
    dom.saveCase.textContent = busy && activeAction === 'save' ? '正在保存…' : '保存为用例';
    if (dom.envSelect) dom.envSelect.disabled = busy;
    const hasEnv = !!state.activeEnvironmentId;
    if (dom.renameEnv) dom.renameEnv.disabled = busy || !hasEnv;
    if (dom.deleteEnv) dom.deleteEnv.disabled = busy || !hasEnv;
    if (dom.addVar) dom.addVar.disabled = busy || !hasEnv;
    if (dom.newVarKey) dom.newVarKey.disabled = busy || !hasEnv;
    if (dom.newVarValue) dom.newVarValue.disabled = busy || !hasEnv;
    if (dom.addEnv) dom.addEnv.disabled = busy;
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
    [dom.name, dom.url, dom.body, dom.headerRows, dom.previewBox].forEach((node) => {
      if (node) node.classList.remove('invalid');
    });
  }

  // 服务端给出的位置可能是 headers.2.key 这种形式，标记时按区块归位
  function normalizeField(field) {
    if (typeof field !== 'string' || !field) return '';
    const key = field.split('.')[0];
    return ['name', 'method', 'url', 'headers', 'body', 'preview'].includes(key) ? key : '';
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
      preview: dom.previewBox,
    }[key];
    if (target) target.classList.add('invalid');
  }

  // 环境管理区有自己的错误槽位，单独处理
  function showEnvError(slotName, message) {
    const slot = document.querySelector(`[data-error="${slotName}"]`);
    if (slot) {
      slot.textContent = message;
      slot.hidden = false;
    }
  }

  function clearEnvErrors() {
    ['environmentName', 'variableKey', 'variableValue'].forEach((slotName) => {
      const slot = document.querySelector(`[data-error="${slotName}"]`);
      if (slot) {
        slot.hidden = true;
        slot.textContent = '';
      }
    });
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
    renderPreview();
  }

  function resetDraft(silent) {
    fillDraft({ name: '', method: 'GET', url: '', headers: [], body: '' });
    if (!silent) showNotice('草稿已清空', 'info');
  }

  // ---------------- 变量模板与替换引擎 ----------------

  const VAR_NAME_RULE = /^[A-Za-z0-9_.-]+$/;
  // 请求头名称允许的字符，与服务端保持一致
  const HEADER_NAME_RULE = /[^!#$%&'*+\-.^_`|~0-9A-Za-z]/;

  // 与服务端 scanTemplate 同一套规则：拆出普通文本、合法占位与不成立的占位
  function scanTemplate(text) {
    const source = typeof text === 'string' ? text : '';
    const tokens = [];
    const issues = [];
    let cursor = 0;
    let textStart = 0;

    const pushLiteral = (end) => {
      if (end > textStart) tokens.push({ type: 'text', text: source.slice(textStart, end) });
    };

    while (cursor < source.length) {
      const open = source.indexOf('{{', cursor);
      if (open === -1) break;
      const close = source.indexOf('}}', open + 2);
      if (close === -1) {
        pushLiteral(open);
        const raw = source.slice(open);
        tokens.push({ type: 'broken', raw, name: '', code: 'TEMPLATE_UNCLOSED' });
        issues.push({ code: 'TEMPLATE_UNCLOSED', name: '', raw, message: `有一处变量占位没有闭合：${raw}` });
        textStart = source.length;
        cursor = source.length;
        break;
      }
      pushLiteral(open);
      const raw = source.slice(open, close + 2);
      const name = source.slice(open + 2, close).trim();
      if (!name) {
        tokens.push({ type: 'broken', raw, name: '', code: 'TEMPLATE_EMPTY_NAME' });
        issues.push({ code: 'TEMPLATE_EMPTY_NAME', name: '', raw, message: `存在变量名为空的占位：${raw}` });
      } else if (!VAR_NAME_RULE.test(name)) {
        tokens.push({ type: 'broken', raw, name, code: 'TEMPLATE_INVALID_NAME' });
        issues.push({ code: 'TEMPLATE_INVALID_NAME', name, raw, message: `变量名「${name}」不成立，只能使用字母、数字、下划线、中划线与点` });
      } else {
        tokens.push({ type: 'placeholder', raw, name });
      }
      textStart = close + 2;
      cursor = close + 2;
    }
    pushLiteral(source.length);
    return { tokens, issues };
  }

  function getActiveEnvironment() {
    return state.environments.find((item) => item.id === state.activeEnvironmentId) || null;
  }

  // 把一段文本按当前环境替换成分段结果：普通文本、已替换段、未定义段、不成立段
  function resolveText(source, varMap, hasEnv) {
    const scanned = scanTemplate(source);
    const segments = [];
    const issues = [];
    const usedKeys = [];

    scanned.tokens.forEach((token) => {
      if (token.type === 'text') {
        segments.push({ type: 'text', text: token.text });
        return;
      }
      if (token.type === 'broken') {
        const matched = scanned.issues.find((item) => item.code === token.code && item.raw === token.raw);
        const message = matched ? matched.message : `变量占位不成立：${token.raw}`;
        segments.push({ type: 'error', text: token.raw, name: token.name, message });
        issues.push({ code: token.code, name: token.name, raw: token.raw, message });
        return;
      }
      const hit = varMap.get(token.name.toLowerCase());
      if (hit) {
        segments.push({ type: 'var', text: hit.value, name: hit.key });
        if (!usedKeys.some((key) => key.toLowerCase() === hit.key.toLowerCase())) usedKeys.push(hit.key);
      } else {
        const message = hasEnv
          ? `变量「${token.name}」没有在当前环境中定义`
          : `当前没有选择环境，变量「${token.name}」无法取值`;
        segments.push({ type: 'missing', text: token.raw, name: token.name, message });
        issues.push({ code: 'VARIABLE_UNDEFINED', name: token.name, raw: token.raw, message });
      }
    });

    return { segments, resolved: segments.map((seg) => seg.text).join(''), issues, usedKeys };
  }

  function isValidResolvedUrl(value) {
    if (!value || /\s/.test(value)) return false;
    if (value.startsWith('/')) return true;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (err) {
      return false;
    }
  }

  // 评估整份请求：替换三处内容，并检查变量未定义、占位不成立以及替换后内容是否成立
  function evaluateRequest() {
    const draft = collectDraft();
    const env = getActiveEnvironment();
    const varMap = new Map();
    if (env) env.variables.forEach((row) => varMap.set(row.key.toLowerCase(), row));

    const url = resolveText(draft.url, varMap, !!env);
    const headerRows = draft.headers.map((row) => ({
      source: row,
      key: resolveText(row.key, varMap, !!env),
      value: resolveText(row.value, varMap, !!env),
    }));
    const body = resolveText(draft.body, varMap, !!env);
    const issues = [];

    const collect = (field, location, part) => {
      part.issues.forEach((item) => issues.push(Object.assign({}, item, { field, location })));
    };
    collect('url', '目标地址', url);
    headerRows.forEach((row, index) => {
      collect(`headers.${index}.key`, `请求头第 ${index + 1} 行名称`, row.key);
      collect(`headers.${index}.value`, `请求头第 ${index + 1} 行取值`, row.value);
    });
    collect('body', '请求内容', body);

    // 目标地址：占位问题已记录，这里只补充替换后的结构校验
    if (!url.issues.length) {
      if (!draft.url) {
        issues.push({ field: 'url', location: '目标地址', code: 'URL_REQUIRED', name: '', message: '请填写目标地址' });
      } else if (!isValidResolvedUrl(url.resolved)) {
        issues.push({
          field: 'url',
          location: '目标地址',
          code: 'URL_INVALID',
          name: '',
          message: '变量替换后的目标地址不成立，需要以 / 开头或是合法的 http、https 地址，且不能含空格',
        });
      }
    }

    // 请求头：跳过整行为空的草稿行，其余检查名称缺失、替换结果非法与替换后重名
    const seenHeaderKeys = new Set();
    headerRows.forEach((row, index) => {
      if (!row.source.key.trim() && !row.source.value) return;
      if (row.key.issues.length || row.value.issues.length) return;
      const key = row.key.resolved.trim();
      const field = `headers.${index}.key`;
      const location = `请求头第 ${index + 1} 行名称`;
      if (!key) {
        issues.push({ field, location, code: 'HEADER_KEY_REQUIRED', name: '', message: `第 ${index + 1} 行请求头缺少名称` });
        return;
      }
      if (HEADER_NAME_RULE.test(key)) {
        issues.push({
          field,
          location,
          code: 'HEADER_KEY_INVALID',
          name: '',
          message: `第 ${index + 1} 行请求头名称替换为「${key}」后含有非法字符，请检查变量取值`,
        });
        return;
      }
      const lower = key.toLowerCase();
      if (seenHeaderKeys.has(lower)) {
        issues.push({ field, location, code: 'HEADER_KEY_DUPLICATE', name: '', message: `替换后请求头「${key}」与前面的行重名` });
        return;
      }
      seenHeaderKeys.add(lower);
    });

    // 请求内容：只在没有占位问题时检查请求方式与 JSON 结构
    if (!body.issues.length && draft.body.trim()) {
      if (body.resolved.trim() && (draft.method === 'GET' || draft.method === 'HEAD')) {
        issues.push({
          field: 'body',
          location: '请求内容',
          code: 'BODY_NOT_ALLOWED',
          name: '',
          message: `请求方式为 ${draft.method} 时不带请求内容，变量替换后仍有内容，请清空或更换请求方式`,
        });
      } else {
        const contentTypeRow = headerRows.find(
          (row) => !row.key.issues.length && row.key.resolved.trim().toLowerCase() === 'content-type'
        );
        if (contentTypeRow && contentTypeRow.value.resolved.toLowerCase().includes('json') && body.resolved.trim()) {
          try {
            JSON.parse(body.resolved);
          } catch (err) {
            const used = body.usedKeys.length ? `（涉及变量：${body.usedKeys.join('、')}）` : '';
            issues.push({
              field: 'body',
              location: '请求内容',
              code: 'BODY_INVALID_JSON',
              name: body.usedKeys.join('、'),
              message: `变量替换后的请求内容不是合法的 JSON${used}：${err.message}`,
            });
          }
        }
      }
    }

    // 汇总本次实际发生的替换，供预览区给出对照表
    const substitutions = [];
    const rememberSubs = (part) => {
      part.segments.forEach((seg) => {
        if (seg.type !== 'var') return;
        if (!substitutions.some((item) => item.name.toLowerCase() === seg.name.toLowerCase())) {
          substitutions.push({ name: seg.name, value: seg.text });
        }
      });
    };
    rememberSubs(url);
    headerRows.forEach((row) => {
      rememberSubs(row.key);
      rememberSubs(row.value);
    });
    rememberSubs(body);

    return {
      env,
      draft,
      url,
      headerRows,
      body,
      issues,
      substitutions,
      canSend: issues.length === 0,
    };
  }

  // 保存用例前只检查占位语法本身：未定义变量允许保存（别的环境里可能有定义）
  function findTemplateSyntaxIssues() {
    const draft = collectDraft();
    const issues = [];
    const check = (field, location, text) => {
      scanTemplate(text).issues.forEach((item) => issues.push(Object.assign({}, item, { field, location })));
    };
    check('url', '目标地址', draft.url);
    draft.headers.forEach((row, index) => {
      check(`headers.${index}.key`, `请求头第 ${index + 1} 行名称`, row.key);
      check(`headers.${index}.value`, `请求头第 ${index + 1} 行取值`, row.value);
    });
    check('body', '请求内容', draft.body);
    return issues;
  }

  // ---------------- 替换预览 ----------------

  function buildSegmentNodes(segments) {
    const fragment = document.createDocumentFragment();
    segments.forEach((seg) => {
      if (seg.type === 'text' && seg.text === '') return;
      const node = document.createElement('span');
      if (seg.type === 'text') {
        node.className = 'seg seg-text';
        node.textContent = seg.text === '' ? ' ' : seg.text;
      } else if (seg.type === 'var') {
        node.className = 'seg seg-var';
        node.textContent = seg.text;
        node.title = `这一段由变量「${seg.name}」替换而来，取值即当前看到的内容`;
      } else if (seg.type === 'missing') {
        node.className = 'seg seg-missing';
        node.textContent = seg.text;
        node.title = seg.message;
      } else {
        node.className = 'seg seg-broken';
        node.textContent = seg.text;
        node.title = seg.message;
      }
      fragment.appendChild(node);
    });
    return fragment;
  }

  function buildPreviewRow(label, segments, resolved, rowIssues) {
    const row = document.createElement('div');
    row.className = 'preview-row';
    if (rowIssues.length) row.classList.add('has-error');

    const labelNode = document.createElement('span');
    labelNode.className = 'preview-label';
    labelNode.textContent = label;
    row.appendChild(labelNode);

    const content = document.createElement('div');
    content.className = 'preview-content';
    if (resolved === '') {
      const empty = document.createElement('span');
      empty.className = 'preview-empty';
      empty.textContent = '（空）';
      content.appendChild(empty);
    } else {
      content.appendChild(buildSegmentNodes(segments));
    }
    row.appendChild(content);

    rowIssues.forEach((item) => {
      const note = document.createElement('p');
      note.className = 'preview-issue';
      note.textContent = item.message;
      row.appendChild(note);
    });
    return row;
  }

  function renderPreview() {
    const evaluation = evaluateRequest();
    dom.previewEnvName.textContent = evaluation.env ? evaluation.env.name : '未选择环境';
    dom.previewBox.textContent = '';
    dom.previewBox.classList.toggle('invalid', !evaluation.canSend);

    // 预览顶部给出替换处数或问题处数，发送拦截结论也在这里体现
    if (evaluation.canSend) {
      dom.previewSummary.textContent = evaluation.substitutions.length
        ? `已按当前环境替换 ${evaluation.substitutions.length} 处变量，可以发送`
        : '当前请求没有引用变量，可以发送';
      dom.previewSummary.className = 'counter preview-ok';
    } else {
      dom.previewSummary.textContent = `有 ${evaluation.issues.length} 处不成立，本次发送会被拦截`;
      dom.previewSummary.className = 'counter preview-bad';
    }

    if (evaluation.substitutions.length) {
      const legend = document.createElement('div');
      legend.className = 'preview-legend';
      evaluation.substitutions.forEach((item) => {
        const chip = document.createElement('span');
        chip.className = 'sub-chip';
        const name = document.createElement('code');
        name.className = 'sub-name';
        name.textContent = item.name;
        const arrow = document.createElement('span');
        arrow.className = 'sub-arrow';
        arrow.textContent = '→';
        const value = document.createElement('code');
        value.className = 'sub-value';
        value.textContent = item.value === '' ? '（空字符串）' : item.value;
        chip.append(name, arrow, value);
        legend.appendChild(chip);
      });
      dom.previewBox.appendChild(legend);
    }

    dom.previewBox.appendChild(buildPreviewRow('目标地址', evaluation.url.segments, evaluation.url.resolved,
      evaluation.issues.filter((item) => item.field === 'url')));

    const headerBlock = document.createElement('div');
    headerBlock.className = 'preview-headers';
    const visibleRows = evaluation.headerRows.filter((row) => row.source.key.trim() || row.source.value);
    if (!visibleRows.length) {
      const empty = document.createElement('p');
      empty.className = 'preview-emptyline';
      empty.textContent = '请求头：暂无内容';
      headerBlock.appendChild(empty);
    } else {
      evaluation.headerRows.forEach((row, index) => {
        if (!row.source.key.trim() && !row.source.value) return;
        const segments = [];
        row.key.segments.forEach((seg) => segments.push(seg));
        segments.push({ type: 'text', text: ': ' });
        row.value.segments.forEach((seg) => segments.push(seg));
        const resolved = `${row.key.resolved}: ${row.value.resolved}`;
        const rowIssues = evaluation.issues.filter(
          (item) => item.field === `headers.${index}.key` || item.field === `headers.${index}.value`
        );
        headerBlock.appendChild(buildPreviewRow(`请求头第 ${index + 1} 行`, segments, resolved, rowIssues));
      });
    }
    dom.previewBox.appendChild(headerBlock);

    dom.previewBox.appendChild(buildPreviewRow('请求内容', evaluation.body.segments, evaluation.body.resolved,
      evaluation.issues.filter((item) => item.field === 'body')));

    return evaluation;
  }

  // 发送或保存被拦截时，把问题按区块塞回请求区的错误槽位，并指出变量名
  function surfaceIssues(issues) {
    const byField = new Map();
    issues.forEach((item) => {
      const key = normalizeField(item.field);
      if (!key) return;
      if (!byField.has(key)) byField.set(key, []);
      byField.get(key).push(item.message);
    });
    byField.forEach((messages, key) => {
      showFieldError(key, Array.from(new Set(messages)).join('；'));
    });
  }

  // ---------------- 环境管理 ----------------

  async function loadEnvironments() {
    try {
      const data = await request('/api/environments');
      state.environments = Array.isArray(data.environments) ? data.environments : [];
      state.activeEnvironmentId = data.activeEnvironmentId || '';
    } catch (err) {
      state.environments = [];
      state.activeEnvironmentId = '';
      showNotice(`环境数据读取失败：${err.message}`, 'error');
    }
    renderEnvironmentSelect();
    renderVariableList();
    renderPreview();
  }

  function renderEnvironmentSelect() {
    dom.envSelect.textContent = '';
    if (!state.environments.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '暂无环境，请先新增';
      dom.envSelect.appendChild(option);
      dom.envSelect.value = '';
      dom.envSummary.textContent = '共 0 套环境';
      dom.currentEnvTitle.textContent = '未选择环境';
      dom.varSummary.textContent = '共 0 条';
      dom.renameEnv.disabled = true;
      dom.deleteEnv.disabled = true;
      dom.addVar.disabled = true;
      dom.newVarKey.disabled = true;
      dom.newVarValue.disabled = true;
      return;
    }

    state.environments.forEach((env) => {
      const option = document.createElement('option');
      option.value = env.id;
      option.textContent = `${env.name}（${env.variables.length} 个变量）`;
      dom.envSelect.appendChild(option);
    });
    dom.envSelect.value = state.activeEnvironmentId;
    dom.envSummary.textContent = `共 ${state.environments.length} 套环境`;
    dom.renameEnv.disabled = false;
    dom.deleteEnv.disabled = false;
    dom.addVar.disabled = false;
    dom.newVarKey.disabled = false;
    dom.newVarValue.disabled = false;
    const current = getActiveEnvironment();
    dom.currentEnvTitle.textContent = current ? current.name : '未选择环境';
    dom.varSummary.textContent = current ? `共 ${current.variables.length} 条` : '共 0 条';
  }

  function renderVariableList() {
    const env = getActiveEnvironment();
    dom.varList.textContent = '';
    if (!env) {
      const hint = document.createElement('p');
      hint.className = 'rows-empty';
      hint.textContent = '还没有可选环境，先在上方新增一套环境，再逐条添加变量。';
      dom.varList.appendChild(hint);
      return;
    }
    if (!env.variables.length) {
      const hint = document.createElement('p');
      hint.className = 'rows-empty';
      hint.textContent = '这套环境还没有变量，在下方逐条添加，例如变量名 host、取值 127.0.0.1:5051。';
      dom.varList.appendChild(hint);
      return;
    }

    env.variables.forEach((row, index) => {
      const line = document.createElement('div');
      line.className = 'var-row';

      const order = document.createElement('span');
      order.className = 'var-order';
      order.textContent = String(index + 1);

      const key = document.createElement('code');
      key.className = 'var-key';
      key.textContent = row.key;
      key.title = '变量名（变量名不可直接修改，可删除后重新添加）';

      const valueInput = document.createElement('input');
      valueInput.type = 'text';
      valueInput.className = 'var-value-input';
      valueInput.value = row.value;
      valueInput.autocomplete = 'off';
      valueInput.placeholder = '变量取值';
      valueInput.dataset.key = row.key;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-ghost btn-small btn-danger';
      remove.textContent = '删除';
      remove.dataset.action = 'remove-var';
      remove.dataset.key = row.key;

      line.append(order, key, valueInput, remove);
      dom.varList.appendChild(line);
    });
  }

  // 在本地状态里改某条变量取值，保证输入时预览就能实时变化；落盘由 change 事件负责
  function patchLocalVariable(key, value) {
    const env = getActiveEnvironment();
    if (!env) return;
    const row = env.variables.find((item) => item.key.toLowerCase() === key.toLowerCase());
    if (row) row.value = value;
    renderPreview();
  }

  async function persistVariableValue(key, value) {
    const env = getActiveEnvironment();
    if (!env) return;
    try {
      const data = await request(
        `/api/environments/${encodeURIComponent(env.id)}/variables/${encodeURIComponent(key)}`,
        { method: 'PUT', body: { value } }
      );
      const updated = state.environments.find((item) => item.id === env.id);
      if (updated && data.environment) {
        updated.variables = data.environment.variables;
        updated.updatedAt = data.environment.updatedAt;
      }
      renderEnvironmentSelect();
      renderPreview();
    } catch (err) {
      showNotice(`变量「${key}」取值保存失败：${err.message}，已恢复为服务端内容`, 'error');
      await loadEnvironments();
    }
  }

  async function switchEnvironment(id) {
    if (state.busy || !id || id === state.activeEnvironmentId) return;
    setBusy(true);
    try {
      await request(`/api/environments/${encodeURIComponent(id)}/activate`, { method: 'POST' });
      state.activeEnvironmentId = id;
      const env = getActiveEnvironment();
      renderEnvironmentSelect();
      renderVariableList();
      renderPreview();
      showNotice(`当前生效环境已切换为「${env ? env.name : ''}」，预览已按新环境的取值更新`, 'success');
    } catch (err) {
      showNotice(err.message, 'error');
      dom.envSelect.value = state.activeEnvironmentId;
    } finally {
      setBusy(false);
    }
  }

  async function createEnvironment() {
    if (state.busy) return;
    clearEnvErrors();
    const name = dom.newEnvName.value.trim();
    if (!name) {
      showEnvError('environmentName', '环境名称不能为空');
      dom.newEnvName.focus();
      return;
    }
    setBusy(true);
    try {
      const data = await request('/api/environments', { method: 'POST', body: { name } });
      state.environments.push(data.environment);
      state.activeEnvironmentId = data.activeEnvironmentId;
      dom.newEnvName.value = '';
      renderEnvironmentSelect();
      renderVariableList();
      renderPreview();
      showNotice(`已新增环境「${data.environment.name}」并切换为当前生效环境`, 'success');
      dom.newVarKey.focus();
    } catch (err) {
      if (err.field === 'environmentName') showEnvError('environmentName', err.message);
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function renameCurrentEnvironment() {
    if (state.busy) return;
    const env = getActiveEnvironment();
    if (!env) return;
    clearEnvErrors();
    const name = window.prompt('把当前环境重命名为：', env.name);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      showEnvError('environmentName', '环境名称不能为空');
      return;
    }
    if (trimmed === env.name) return;
    setBusy(true);
    try {
      const data = await request(`/api/environments/${encodeURIComponent(env.id)}`, {
        method: 'PATCH',
        body: { name: trimmed },
      });
      env.name = data.environment.name;
      env.updatedAt = data.environment.updatedAt;
      renderEnvironmentSelect();
      renderPreview();
      showNotice(`环境已重命名为「${data.environment.name}」`, 'success');
    } catch (err) {
      if (err.field === 'environmentName') showEnvError('environmentName', err.message);
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function deleteCurrentEnvironment() {
    if (state.busy) return;
    const env = getActiveEnvironment();
    if (!env) return;
    const confirmed = window.confirm(
      `确认删除环境「${env.name}」？该环境下的 ${env.variables.length} 条变量会一并删除，其他环境不受影响，删除后无法恢复。`
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      const data = await request(`/api/environments/${encodeURIComponent(env.id)}`, { method: 'DELETE' });
      state.environments = state.environments.filter((item) => item.id !== env.id);
      state.activeEnvironmentId = data.activeEnvironmentId;
      renderEnvironmentSelect();
      renderVariableList();
      renderPreview();
      showNotice(`环境「${data.name}」已删除${data.activeEnvironmentId ? '，已自动切换到剩余环境' : '，目前没有可用环境'}`, 'success');
    } catch (err) {
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function addVariable() {
    if (state.busy) return;
    clearEnvErrors();
    const env = getActiveEnvironment();
    if (!env) {
      showNotice('请先新增并选择一套环境，再添加变量', 'error');
      return;
    }
    const key = dom.newVarKey.value.trim();
    const value = dom.newVarValue.value;
    // 变量名为空当场拒绝，并指明这是待添加的第几条
    if (!key) {
      showEnvError('variableKey', `第 ${env.variables.length + 1} 条变量不成立：变量名不能为空`);
      dom.newVarKey.focus();
      return;
    }
    if (!VAR_NAME_RULE.test(key)) {
      showEnvError('variableKey', `第 ${env.variables.length + 1} 条变量不成立：变量名「${key}」只能使用字母、数字、下划线、中划线与点`);
      dom.newVarKey.focus();
      return;
    }
    const localDuplicate = env.variables.findIndex((row) => row.key.toLowerCase() === key.toLowerCase());
    if (localDuplicate !== -1) {
      showEnvError('variableKey', `第 ${env.variables.length + 1} 条变量不成立：第 ${localDuplicate + 1} 条已经叫「${key}」，同一环境下变量名不能重复`);
      dom.newVarKey.focus();
      return;
    }

    setBusy(true);
    try {
      const data = await request(`/api/environments/${encodeURIComponent(env.id)}/variables`, {
        method: 'POST',
        body: { key, value },
      });
      env.variables = data.environment.variables;
      env.updatedAt = data.environment.updatedAt;
      dom.newVarKey.value = '';
      dom.newVarValue.value = '';
      renderEnvironmentSelect();
      renderVariableList();
      renderPreview();
      showNotice(`已向环境「${env.name}」添加第 ${data.index + 1} 条变量「${key}」`, 'success');
      dom.newVarKey.focus();
    } catch (err) {
      // 服务端返回的重名结论里已经写明是第几条，直接展示
      if (err.field === 'variableKey') showEnvError('variableKey', err.message);
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeVariable(key) {
    if (state.busy) return;
    const env = getActiveEnvironment();
    if (!env) return;

    const doDelete = async (force) => {
      const suffix = force ? '?force=true' : '';
      return request(
        `/api/environments/${encodeURIComponent(env.id)}/variables/${encodeURIComponent(key)}${suffix}`,
        { method: 'DELETE' }
      );
    };

    setBusy(true);
    try {
      let result;
      try {
        result = await doDelete(false);
      } catch (err) {
        if (err.status !== 409 || err.code !== 'VARIABLE_STILL_REFERENCED') throw err;
        // 变量仍被其他环境引用：给出明确结论，由用户决定是否只删当前环境这一条
        const referenced = (err.details && Array.isArray(err.details.referencedBy)) ? err.details.referencedBy : [];
        const names = referenced.map((item) => item.name).join('、');
        const confirmed = window.confirm(
          `变量「${key}」仍被其他环境引用：${names}。\n\n` +
          `点击「确定」只删除当前环境「${env.name}」中的这一条，其他环境里的同名变量保持不变；点击「取消」则保留不删。`
        );
        if (!confirmed) {
          showNotice(`已保留变量「${key}」，其他环境仍在引用它`, 'info');
          return;
        }
        result = await doDelete(true);
      }

      env.variables = env.variables.filter((row) => row.key.toLowerCase() === key.toLowerCase());
      renderEnvironmentSelect();
      renderVariableList();
      renderPreview();
      if (result.stillReferencedBy && result.stillReferencedBy.length) {
        const names = result.stillReferencedBy.map((item) => item.name).join('、');
        showNotice(`已从当前环境「${env.name}」删除变量「${key}」；其他环境（${names}）里的同名变量保持不变`, 'success');
      } else {
        showNotice(`已删除变量「${key}」，没有其他环境再引用同名变量`, 'success');
      }
    } catch (err) {
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
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

    // 先按当前环境替换并检查：变量未定义、占位不成立、替换后地址或 JSON 不成立都会被拦下
    const evaluation = evaluateRequest();
    renderPreview();
    if (!evaluation.canSend) {
      surfaceIssues(evaluation.issues);
      const first = evaluation.issues[0];
      showNotice(`本次发送已被拦截：${first.location ? `${first.location}：` : ''}${first.message}`, 'error');
      const focusTarget = { url: dom.url, body: dom.body, headers: dom.headerRows }[normalizeField(first.field)];
      if (focusTarget) focusTarget.focus();
      return;
    }

    // 真正发出去的是替换后的实际内容，模板原文只保留在页面与用例里
    const resolved = {
      name: dom.name.value.trim(),
      method: evaluation.draft.method,
      url: evaluation.url.resolved,
      headers: evaluation.headerRows
        .filter((row) => row.source.key.trim() || row.source.value)
        .map((row) => ({ key: row.key.resolved.trim(), value: row.value.resolved })),
      body: evaluation.body.resolved,
    };

    setBusy(true, 'send');
    renderResultPending(resolved);
    try {
      const result = await request('/api/send', { method: 'POST', body: resolved });
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
    sub.textContent = `${draft.method} ${draft.url} 已按照填写的内容发出去，收到回应后这里会显示状态、耗时、响应头与响应内容。`;
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
        buildEmptyBlock('还没有保存过用例', '在请求区填好内容后点「保存为用例」，用例会出现在这里。')
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
    metaNode.textContent = `请求头 ${item.headers.length} 行 · 保存于 ${formatTime(item.createdAt)}`;

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

  // 回填：把用例保存下来的内容写回请求区，可以直接点发送请求重发一次
  function applyCase(item) {
    if (state.busy) return;
    fillDraft(item);
    state.selectedId = item.id;
    renderCases();
    renderDetail(item);
    showNotice(`用例「${item.name}」已回填到请求区，可直接点发送请求`, 'success');
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
    // 保存的是带占位的模板：允许引用其他环境里才有的变量，但空变量名、非法变量名、未闭合等语法问题当场拒绝
    const syntaxIssues = findTemplateSyntaxIssues();
    if (syntaxIssues.length) {
      surfaceIssues(syntaxIssues);
      const first = syntaxIssues[0];
      showNotice(`用例没有保存：${first.location}：${first.message}`, 'error');
      return;
    }

    setBusy(true, 'save');
    try {
      const created = await request('/api/cases', { method: 'POST', body: draft });
      state.selectedId = created.id;
      await loadCases();
      renderDetail(created);
      showNotice(`用例「${created.name}」已保存，请求区的变量占位原样保留`, 'success');
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
    // 请求区任意一处改动都实时重算替换预览
    dom.url.addEventListener('input', () => renderPreview());
    dom.body.addEventListener('input', () => renderPreview());
    dom.method.addEventListener('change', () => renderPreview());

    dom.headerRows.addEventListener('input', (event) => {
      const target = event.target;
      const index = Number(target.dataset ? target.dataset.index : NaN);
      const part = target.dataset ? target.dataset.part : '';
      if (!Number.isInteger(index) || !state.headers[index] || !part) return;
      state.headers[index][part] = target.value;
      const slot = document.querySelector('[data-error="headers"]');
      if (slot) slot.hidden = true;
      dom.headerRows.classList.remove('invalid');
      renderPreview();
    });

    dom.headerRows.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action="remove-header"]');
      if (!button) return;
      const index = Number(button.dataset.index);
      if (!Number.isInteger(index) || !state.headers[index]) return;
      state.headers.splice(index, 1);
      renderHeaderRows();
      renderPreview();
    });

    dom.addHeader.addEventListener('click', () => {
      state.headers.push({ key: '', value: '' });
      renderHeaderRows();
      const inputs = dom.headerRows.querySelectorAll('input');
      const last = inputs[inputs.length - 2];
      if (last) last.focus();
    });

    // ---------- 环境管理 ----------
    dom.envSelect.addEventListener('change', () => {
      switchEnvironment(dom.envSelect.value);
    });

    dom.addEnv.addEventListener('click', createEnvironment);
    dom.newEnvName.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') createEnvironment();
    });
    dom.renameEnv.addEventListener('click', renameCurrentEnvironment);
    dom.deleteEnv.addEventListener('click', deleteCurrentEnvironment);

    dom.addVar.addEventListener('click', addVariable);
    dom.newVarValue.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') addVariable();
    });
    dom.newVarKey.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') dom.newVarValue.focus();
    });

    // 变量取值：输入过程中本地实时替换，失焦或回车时落盘；删除按引用情况分别处理
    dom.varList.addEventListener('input', (event) => {
      const target = event.target;
      if (!target.classList || !target.classList.contains('var-value-input')) return;
      patchLocalVariable(target.dataset.key, target.value);
    });

    dom.varList.addEventListener('change', (event) => {
      const target = event.target;
      if (!target.classList || !target.classList.contains('var-value-input')) return;
      persistVariableValue(target.dataset.key, target.value);
    });

    dom.varList.addEventListener('keydown', (event) => {
      const target = event.target;
      if (!target.classList || !target.classList.contains('var-value-input')) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        target.blur();
      }
    });

    dom.varList.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action="remove-var"]');
      if (!button) return;
      removeVariable(button.dataset.key);
    });

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
