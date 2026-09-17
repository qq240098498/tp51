const crypto = require('crypto');
const { load, save } = require('./store');
const { scanTemplate } = require('./templates');

// 允许的请求方式，与页面上的下拉选项保持一致
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const MAX_NAME_LENGTH = 60;
const MAX_URL_LENGTH = 2048;
const MAX_BODY_LENGTH = 200 * 1024;
const MAX_HEADER_COUNT = 30;

// 带错误码与出错位置的业务异常，页面据此把问题标到具体输入项上
// details 用来携带结构化补充信息，例如变量被哪些环境引用
class ApiError extends Error {
  constructor(status, code, message, field, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field || '';
    this.details = details && typeof details === 'object' ? details : undefined;
  }
}

function pickText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateMethod(method) {
  const value = pickText(method).toUpperCase();
  if (!value) throw new ApiError(400, 'METHOD_REQUIRED', '请选择请求方式', 'method');
  if (!ALLOWED_METHODS.includes(value)) {
    throw new ApiError(400, 'METHOD_INVALID', `不支持的请求方式：${value}`, 'method');
  }
  return value;
}

function validateName(name) {
  const value = pickText(name);
  if (!value) throw new ApiError(400, 'NAME_REQUIRED', '请填写用例名称', 'name');
  if (value.length > MAX_NAME_LENGTH) {
    throw new ApiError(400, 'NAME_TOO_LONG', `用例名称不能超过 ${MAX_NAME_LENGTH} 个字符`, 'name');
  }
  return value;
}

// 目标地址支持两种写法：以 / 开头的本机内置示例接口路径，以及完整的 http 或 https 地址
function validateUrl(url) {
  const value = pickText(url);
  if (!value) throw new ApiError(400, 'URL_REQUIRED', '目标地址不能为空', 'url');
  if (value.length > MAX_URL_LENGTH) {
    throw new ApiError(400, 'URL_TOO_LONG', `目标地址不能超过 ${MAX_URL_LENGTH} 个字符`, 'url');
  }
  if (value.startsWith('/')) {
    if (/\s/.test(value)) {
      throw new ApiError(400, 'URL_INVALID', '目标地址里不能出现空格，请检查是否有多余字符或变量替换结果', 'url');
    }
    return value;
  }
  let parsed = null;
  try {
    parsed = new URL(value);
  } catch (err) {
    throw new ApiError(400, 'URL_INVALID', '目标地址需要以 http:// 或 https:// 开头，或填写 / 开头的内置示例接口路径；请检查变量替换后的结果', 'url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(400, 'URL_PROTOCOL_UNSUPPORTED', '目标地址只支持 http 与 https 两种协议', 'url');
  }
  return value;
}

// 保存用例时，目标地址允许写成带 {{变量名}} 的模板，这里只检查占位语法本身
function validateUrlTemplate(url) {
  const value = typeof url === 'string' ? url.trim() : '';
  if (!value) throw new ApiError(400, 'URL_REQUIRED', '目标地址不能为空', 'url');
  if (value.length > MAX_URL_LENGTH) {
    throw new ApiError(400, 'URL_TOO_LONG', `目标地址不能超过 ${MAX_URL_LENGTH} 个字符`, 'url');
  }
  const scanned = scanTemplate(value);
  const issue = scanned.issues[0];
  if (issue) {
    throw new ApiError(400, issue.code, `目标地址：${issue.message}`, 'url');
  }
  return value;
}

// 模板里的请求头名称：占位以外的字符仍须符合请求头名称规则
const HEADER_NAME_LITERAL = /[^!#$%&'*+\-.^_`|~0-9A-Za-z]/;

function validateHeaderKeyToken(key, index, allowTemplate) {
  if (allowTemplate && key.includes('{{')) {
    const scanned = scanTemplate(key);
    const issue = scanned.issues[0];
    if (issue) {
      throw new ApiError(400, issue.code, `第 ${index + 1} 行请求头名称：${issue.message}`, `headers.${index}.key`);
    }
    const literal = scanned.tokens
      .filter((token) => token.type === 'text')
      .map((token) => token.text)
      .join('');
    if (HEADER_NAME_LITERAL.test(literal)) {
      throw new ApiError(400, 'HEADER_KEY_INVALID', `第 ${index + 1} 行请求头名称含有非法字符，变量只能顶替名称的一部分`, `headers.${index}.key`);
    }
    return;
  }
  if (/[^!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(key)) {
    throw new ApiError(400, 'HEADER_KEY_INVALID', `请求头名称「${key}」含有非法字符`, `headers.${index}.key`);
  }
}

function validateHeaderValueTemplate(value, index) {
  const scanned = scanTemplate(value);
  const issue = scanned.issues[0];
  if (issue) {
    throw new ApiError(400, issue.code, `第 ${index + 1} 行请求头取值：${issue.message}`, `headers.${index}.value`);
  }
}

// 请求头逐行校验：名称必填、字符合法、同名不重复
function validateHeaders(headers, allowTemplate) {
  if (headers === undefined || headers === null) return [];
  if (!Array.isArray(headers)) {
    throw new ApiError(400, 'HEADERS_INVALID', '请求头需要按行列表填写', 'headers');
  }
  if (headers.length > MAX_HEADER_COUNT) {
    throw new ApiError(400, 'HEADERS_TOO_MANY', `请求头最多 ${MAX_HEADER_COUNT} 行`, 'headers');
  }
  const list = [];
  const seen = new Set();
  headers.forEach((row, index) => {
    const key = pickText(row && row.key);
    const value = typeof (row && row.value) === 'string' ? row.value : '';
    if (!key && !value) return; // 整行为空的直接跳过
    if (!key) {
      throw new ApiError(400, 'HEADER_KEY_REQUIRED', `第 ${index + 1} 行请求头缺少名称`, `headers.${index}.key`);
    }
    validateHeaderKeyToken(key, index, allowTemplate);
    if (allowTemplate) validateHeaderValueTemplate(value, index);
    const lower = key.toLowerCase();
    if (seen.has(lower)) {
      throw new ApiError(400, 'HEADER_KEY_DUPLICATE', `请求头「${key}」重复填写`, `headers.${index}.key`);
    }
    seen.add(lower);
    list.push({ key, value });
  });
  return list;
}

// 请求内容按请求方式与内容类型校验：GET 与 HEAD 不允许带内容，JSON 内容必须能解析
// 保存模板时允许带 {{变量名}}，此时还无法判断替换结果，只检查占位语法，真正发送前由页面校验替换结果
function validateBody(body, method, headers, allowTemplate) {
  const value = typeof body === 'string' ? body : '';
  if (value.length > MAX_BODY_LENGTH) {
    throw new ApiError(400, 'BODY_TOO_LONG', `请求内容不能超过 ${MAX_BODY_LENGTH} 个字符`, 'body');
  }
  const containsTemplate = allowTemplate && value.includes('{{');
  if (containsTemplate) {
    const issue = scanTemplate(value).issues[0];
    if (issue) throw new ApiError(400, issue.code, `请求内容：${issue.message}`, 'body');
    return value;
  }
  if (!value.trim()) return '';
  if (method === 'GET' || method === 'HEAD') {
    throw new ApiError(400, 'BODY_NOT_ALLOWED', `请求方式为 ${method} 时不支持填写请求内容`, 'body');
  }
  const contentType = headers.find((row) => row.key.toLowerCase() === 'content-type');
  const contentTypeValue = contentType ? contentType.value.toLowerCase() : '';
  if (contentTypeValue.includes('json')) {
    try {
      JSON.parse(value);
    } catch (err) {
      throw new ApiError(400, 'BODY_INVALID_JSON', `请求内容不是合法的 JSON：${err.message}`, 'body');
    }
  }
  return value;
}

// 实际发送前的兜底：页面已经把占位替换成实际值，这里拒绝任何残留的 {{...}}，避免把模板原文发出去
function assertNoPlaceholder(draft) {
  const checks = [
    ['url', draft.url],
    ['body', draft.body],
    ...draft.headers.map((row, index) => [`headers.${index}.key`, row.key]),
    ...draft.headers.map((row, index) => [`headers.${index}.value`, row.value]),
  ];
  checks.forEach(([field, text]) => {
    if (typeof text !== 'string' || !text.includes('{{')) return;
    const scanned = scanTemplate(text);
    const unresolved = scanned.tokens.find((token) => token.type === 'placeholder');
    const broken = scanned.tokens.find((token) => token.type === 'broken');
    if (unresolved) {
      throw new ApiError(400, 'VARIABLE_UNRESOLVED', `变量「${unresolved.name}」没有取值，替换没有完成，请求不会发出`, field);
    }
    if (broken) {
      const issue = scanned.issues.find((item) => item.code === broken.code && item.raw === broken.raw) || { message: `变量占位不成立：${broken.raw}` };
      throw new ApiError(400, broken.code || 'TEMPLATE_INVALID', `变量占位不成立：${issue.message}`, field);
    }
  });
}

// 读取用例列表，按创建时间从新到旧排列，顺序稳定
function listCases() {
  const data = load();
  return data.cases
    .slice()
    .sort((a, b) => {
      if (a.createdAt === b.createdAt) return a.id < b.id ? 1 : -1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
}

function getCase(id) {
  const data = load();
  const found = data.cases.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'CASE_NOT_FOUND', '用例不存在或已被删除', '');
  return found;
}

// 实际发送前先对整份草稿做一次占位语法预扫描：坏占位要比地址、JSON 等结构问题优先报出，
// 这样像 /demo/{{a b}} 这种写法会直接指出变量名不成立，而不是笼统地说地址有问题
function assertDraftTemplateSyntax(input) {
  const url = typeof input.url === 'string' ? input.url : '';
  let issue = scanTemplate(url).issues[0];
  if (issue) throw new ApiError(400, issue.code, `目标地址：${issue.message}`, 'url');

  const headers = Array.isArray(input.headers) ? input.headers : [];
  headers.forEach((row, index) => {
    const key = pickText(row && row.key);
    const value = typeof (row && row.value) === 'string' ? row.value : '';
    if (key && key.includes('{{')) {
      issue = scanTemplate(key).issues[0];
      if (issue) {
        throw new ApiError(400, issue.code, `第 ${index + 1} 行请求头名称：${issue.message}`, `headers.${index}.key`);
      }
    }
    if (value.includes('{{')) {
      issue = scanTemplate(value).issues[0];
      if (issue) {
        throw new ApiError(400, issue.code, `第 ${index + 1} 行请求头取值：${issue.message}`, `headers.${index}.value`);
      }
    }
  });

  const body = typeof input.body === 'string' ? input.body : '';
  issue = scanTemplate(body).issues[0];
  if (issue) throw new ApiError(400, issue.code, `请求内容：${issue.message}`, 'body');
}

// 请求草稿的公共校验：实际发送时走严格规则；保存用例时允许 {{变量名}} 模板
function normalizeRequestDraft(payload, options) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const allowTemplate = !!(options && options.allowTemplate);
  const method = validateMethod(input.method);
  if (!allowTemplate) assertDraftTemplateSyntax(input);
  const url = allowTemplate ? validateUrlTemplate(input.url) : validateUrl(input.url);
  const headers = validateHeaders(input.headers, allowTemplate);
  const body = validateBody(input.body, method, headers, allowTemplate);
  const draft = { method, url, headers, body };
  if (!allowTemplate) assertNoPlaceholder(draft);
  return draft;
}

function createCase(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const name = validateName(input.name);
  // 保存的是带变量占位的请求模板，占位语法不成立时指出具体区块；替换结果由页面在发送前校验
  const draft = normalizeRequestDraft(input, { allowTemplate: true });

  const data = load();
  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    name,
    method: draft.method,
    url: draft.url,
    headers: draft.headers,
    body: draft.body,
    createdAt: now,
    updatedAt: now,
  };
  data.cases.push(created);
  save(data);
  return created;
}

function deleteCase(id) {
  const data = load();
  const index = data.cases.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'CASE_NOT_FOUND', '用例不存在或已被删除', '');
  const [removed] = data.cases.splice(index, 1);
  save(data);
  return { id: removed.id, name: removed.name };
}

module.exports = {
  ApiError,
  ALLOWED_METHODS,
  normalizeRequestDraft,
  listCases,
  getCase,
  createCase,
  deleteCase,
};
