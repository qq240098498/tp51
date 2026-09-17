const crypto = require('crypto');
const { load, save } = require('./store');
const { renderText, isValidVariableName } = require('./template');

// 允许的请求方式，与页面上的下拉选项保持一致
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const MAX_NAME_LENGTH = 60;
const MAX_URL_LENGTH = 2048;
const MAX_BODY_LENGTH = 200 * 1024;
const MAX_HEADER_COUNT = 30;

// 带错误码与出错位置的业务异常，页面据此把问题标到具体输入项上
class ApiError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field || '';
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
      throw new ApiError(400, 'URL_INVALID', '目标地址里不能出现空格，请检查是否有多余字符', 'url');
    }
    return value;
  }
  let parsed = null;
  try {
    parsed = new URL(value);
  } catch (err) {
    throw new ApiError(400, 'URL_INVALID', '目标地址需要以 http:// 或 https:// 开头，或填写 / 开头的内置示例接口路径', 'url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(400, 'URL_PROTOCOL_UNSUPPORTED', '目标地址只支持 http 与 https 两种协议', 'url');
  }
  return value;
}

// ---- 模板阶段（保存用例时）：只做最基本的非空与长度限制，占位符原样保留 ----
// 含 {{变量名}} 的内容此刻既不是合法地址也不是合法 JSON，真正成立与否要等替换之后再判

// 替换后的请求内容校验：GET 与 HEAD 不允许带内容，声明为 JSON 时必须能解析
function validateBody(body, method, headers) {
  const value = typeof body === 'string' ? body : '';
  if (value.length > MAX_BODY_LENGTH) {
    throw new ApiError(400, 'BODY_TOO_LONG', `请求内容不能超过 ${MAX_BODY_LENGTH} 个字符`, 'body');
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
      throw new ApiError(400, 'BODY_INVALID_JSON', `请求内容替换变量后不是合法的 JSON：${err.message}`, 'body');
    }
  }
  return value;
}

function validateTemplateUrl(url) {
  const value = pickText(url);
  if (!value) throw new ApiError(400, 'URL_REQUIRED', '目标地址不能为空', 'url');
  if (value.length > MAX_URL_LENGTH) {
    throw new ApiError(400, 'URL_TOO_LONG', `目标地址不能超过 ${MAX_URL_LENGTH} 个字符`, 'url');
  }
  return value;
}

function validateTemplateHeaders(headers) {
  if (headers === undefined || headers === null) return [];
  if (!Array.isArray(headers)) {
    throw new ApiError(400, 'HEADERS_INVALID', '请求头需要按行列表填写', 'headers');
  }
  if (headers.length > MAX_HEADER_COUNT) {
    throw new ApiError(400, 'HEADERS_TOO_MANY', `请求头最多 ${MAX_HEADER_COUNT} 行`, 'headers');
  }
  return headers
    .map((row) => ({
      key: typeof (row && row.key) === 'string' ? row.key.trim() : '',
      value: typeof (row && row.value) === 'string' ? row.value : '',
    }))
    .filter((row) => row.key || row.value);
}

function validateTemplateBody(body) {
  const value = typeof body === 'string' ? body : '';
  if (value.length > MAX_BODY_LENGTH) {
    throw new ApiError(400, 'BODY_TOO_LONG', `请求内容不能超过 ${MAX_BODY_LENGTH} 个字符`, 'body');
  }
  return value;
}

// 位置描述与字段定位：变量出问题时要能指出是哪一处、哪个变量
function describeLocation(part, index) {
  if (part === 'url') return { where: '目标地址', field: 'url' };
  if (part === 'body') return { where: '请求内容', field: 'body' };
  if (part === 'header-key') return { where: `第 ${index + 1} 行请求头的名称`, field: `headers.${index}.key` };
  return { where: `第 ${index + 1} 行请求头的取值`, field: `headers.${index}.value` };
}

function assertTokenErrors(part, tokens, index, envName) {
  tokens.forEach((token) => {
    const loc = describeLocation(part, index);
    if (!token.name) {
      throw new ApiError(
        400,
        'VAR_NAME_EMPTY',
        `${loc.where}里有一个没有写名字的变量（形如 {{}}），请补上变量名`,
        loc.field
      );
    }
    if (!isValidVariableName(token.name)) {
      throw new ApiError(
        400,
        'VAR_NAME_INVALID',
        `${loc.where}里的变量名「${token.name}」不成立：变量名需以字母或下划线开头，只能包含字母、数字、下划线与中划线`,
        loc.field
      );
    }
    if (!token.defined) {
      throw new ApiError(
        400,
        'VAR_NOT_DEFINED',
        `${loc.where}引用的变量「${token.name}」在当前环境「${envName}」中没有定义，请先在环境管理区添加，或切换到定义了它的环境`,
        loc.field
      );
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

// 用例草稿的公共校验：保存用例走这一套，{{变量名}} 占位符按模板原样保留
function normalizeRequestDraft(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const method = validateMethod(input.method);
  const url = validateTemplateUrl(input.url);
  const headers = validateTemplateHeaders(input.headers);
  const body = validateTemplateBody(input.body);
  return { method, url, headers, body };
}

// 发送前解析：按指定环境把目标地址、请求头名称与取值、请求内容里的变量全部替换，
// 再按与保存一致的严格规则校验替换结果。任何一处不成立都抛错，这一次请求不会发出去
function resolveDraftForSend(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const method = validateMethod(input.method);
  const rawUrl = validateTemplateUrl(input.url);
  const rawHeaders = validateTemplateHeaders(input.headers);
  const rawBody = validateTemplateBody(input.body);

  const data = load();
  const envId = typeof input.environmentId === 'string' ? input.environmentId : data.activeEnvironmentId;
  const env = data.environments.find((item) => item.id === envId) || null;
  const envName = env ? env.name : '';
  const variables = env ? env.variables : [];

  const urlRender = renderText(rawUrl, variables);
  assertTokenErrors('url', urlRender.tokens, -1, envName);
  const url = validateUrl(urlRender.text);

  const headers = [];
  const seenHeader = new Set();
  rawHeaders.forEach((row, index) => {
    const keyRender = renderText(row.key, variables);
    const valueRender = renderText(row.value, variables);
    assertTokenErrors('header-key', keyRender.tokens, index, envName);
    assertTokenErrors('header-value', valueRender.tokens, index, envName);
    const key = keyRender.text.trim();
    const value = valueRender.text;
    if (!key && !value) return;
    if (!key) {
      throw new ApiError(400, 'HEADER_KEY_REQUIRED', `第 ${index + 1} 行请求头替换变量后名称为空，请补充变量取值或改写模板`, `headers.${index}.key`);
    }
    if (/[^!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(key)) {
      throw new ApiError(400, 'HEADER_KEY_INVALID', `第 ${index + 1} 行请求头名称「${key}」替换变量后含有非法字符`, `headers.${index}.key`);
    }
    const lower = key.toLowerCase();
    if (seenHeader.has(lower)) {
      throw new ApiError(400, 'HEADER_KEY_DUPLICATE', `第 ${index + 1} 行请求头「${key}」替换变量后与其他行重名`, `headers.${index}.key`);
    }
    seenHeader.add(lower);
    headers.push({ key, value });
  });

  const bodyRender = renderText(rawBody, variables);
  assertTokenErrors('body', bodyRender.tokens, -1, envName);
  const body = validateBody(bodyRender.text, method, headers);

  return { method, url, headers, body, environmentId: env ? env.id : '', environmentName: envName };
}

function createCase(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const name = validateName(input.name);
  const draft = normalizeRequestDraft(input);

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
  resolveDraftForSend,
  listCases,
  getCase,
  createCase,
  deleteCase,
};
