const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const TEMP_FILE = path.join(DATA_DIR, 'db.json.tmp');

// 初始数据：除示例用例外，还带三套环境（开发/测试/生产）与同名变量，
// 这样装好依赖就能直接看到多环境切换与变量替换的效果
function seedData() {
  return {
    activeEnvironmentId: 'env-dev',
    environments: [
      {
        id: 'env-dev',
        name: '开发环境',
        variables: [
          { key: 'host', value: '127.0.0.1:5051' },
          { key: 'token', value: 'dev-token-1001' },
        ],
        createdAt: '2026-09-17T03:00:00.000Z',
        updatedAt: '2026-09-17T03:00:00.000Z',
      },
      {
        id: 'env-test',
        name: '测试环境',
        variables: [
          { key: 'host', value: 'test.example.com' },
          { key: 'token', value: 'test-token-2002' },
        ],
        createdAt: '2026-09-17T03:05:00.000Z',
        updatedAt: '2026-09-17T03:05:00.000Z',
      },
      {
        id: 'env-prod',
        name: '生产环境',
        variables: [
          { key: 'host', value: 'api.example.com' },
        ],
        createdAt: '2026-09-17T03:10:00.000Z',
        updatedAt: '2026-09-17T03:10:00.000Z',
      },
    ],
    cases: [
      {
        id: 'case-1001',
        name: '回声接口连通性检查',
        method: 'GET',
        url: '/demo/echo?from=workbench',
        headers: [{ key: 'Accept', value: 'application/json' }],
        body: '',
        createdAt: '2026-09-17T01:20:00.000Z',
        updatedAt: '2026-09-17T01:20:00.000Z',
      },
      {
        id: 'case-1002',
        name: '回声接口请求内容回显',
        method: 'POST',
        url: '/demo/echo',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
        body: '{\n  "sku": "SKU-1001",\n  "count": 2\n}',
        createdAt: '2026-09-17T01:45:00.000Z',
        updatedAt: '2026-09-17T01:45:00.000Z',
      },
      {
        id: 'case-1003',
        name: '列表接口分页取值',
        method: 'GET',
        url: '/demo/items?page=2&size=2',
        headers: [{ key: 'Accept', value: 'application/json' }],
        body: '',
        createdAt: '2026-09-17T02:10:00.000Z',
        updatedAt: '2026-09-17T02:10:00.000Z',
      },
      {
        id: 'case-1004',
        name: '报错接口状态码核对',
        method: 'GET',
        url: '/demo/status?code=500',
        headers: [{ key: 'Accept', value: 'application/json' }],
        body: '',
        createdAt: '2026-09-17T02:30:00.000Z',
        updatedAt: '2026-09-17T02:30:00.000Z',
      },
    ],
  };
}

// 把单条变量整理成固定结构，变量名统一存去掉首尾空白后的原文
function normalizeVariable(item) {
  const source = item && typeof item === 'object' ? item : {};
  return {
    key: typeof source.key === 'string' ? source.key.trim() : '',
    value: typeof source.value === 'string' ? source.value : '',
  };
}

// 把单个环境整理成固定结构，避免数据文件被手工改动后出现缺字段
function normalizeEnvironment(item, fallbackIndex) {
  const source = item && typeof item === 'object' ? item : {};
  const createdAt = typeof source.createdAt === 'string' && source.createdAt
    ? source.createdAt
    : new Date().toISOString();
  const id = typeof source.id === 'string' && source.id ? source.id : `env-restored-${fallbackIndex}`;
  const variables = Array.isArray(source.variables)
    ? source.variables.map(normalizeVariable).filter((row) => row.key)
    : [];

  // 数据文件可能被手工改出同名变量，落盘时按忽略大小写去重，保留先出现的一条取值
  const seen = new Set();
  const deduped = [];
  variables.forEach((row) => {
    const lower = row.key.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    deduped.push(row);
  });

  return {
    id,
    name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : `环境 ${fallbackIndex + 1}`,
    variables: deduped,
    createdAt,
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : createdAt,
  };
}

// 把单条用例整理成固定结构，避免数据文件被手工改动后出现缺字段
function normalizeCase(item) {
  const source = item && typeof item === 'object' ? item : {};
  const createdAt = typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : new Date().toISOString();
  return {
    id: typeof source.id === 'string' ? source.id : '',
    name: typeof source.name === 'string' ? source.name : '',
    method: typeof source.method === 'string' && source.method ? source.method.toUpperCase() : 'GET',
    url: typeof source.url === 'string' ? source.url : '',
    headers: Array.isArray(source.headers)
      ? source.headers
          .filter((row) => row && typeof row === 'object')
          .map((row) => ({
            key: typeof row.key === 'string' ? row.key : '',
            value: typeof row.value === 'string' ? row.value : '',
          }))
      : [],
    body: typeof source.body === 'string' ? source.body : '',
    createdAt,
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : createdAt,
  };
}

// 整份数据保证 environments、activeEnvironmentId 与 cases 结构一致
function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  // 旧版本数据文件里没有 environments 字段：解析得到但缺这一块时，补上三套种子环境，
  // 已保存的用例原样保留；显式写成 environments: [] 时认为是用户主动删空，予以尊重
  let environments;
  if (Array.isArray(source.environments)) {
    environments = source.environments.map((item, index) => normalizeEnvironment(item, index));
  } else {
    const seed = seedData();
    environments = seed.environments;
  }
  let activeEnvironmentId = typeof source.activeEnvironmentId === 'string' ? source.activeEnvironmentId : '';
  if (!environments.some((env) => env.id === activeEnvironmentId)) {
    activeEnvironmentId = environments.length ? environments[0].id : '';
  }
  const cases = Array.isArray(source.cases) ? source.cases.map(normalizeCase).filter((item) => item.id) : [];
  return { ...source, environments, activeEnvironmentId, cases };
}

// 读取数据文件：文件缺失或内容损坏时回落到初始数据并立刻补写
function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return normalize(JSON.parse(raw));
  } catch (err) {
    const data = seedData();
    save(data);
    return data;
  }
}

// 先写临时文件再改名，写入中途被打断也不会把正式数据文件写坏
function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const text = `${JSON.stringify(normalize(data), null, 2)}\n`;
  fs.writeFileSync(TEMP_FILE, text, 'utf8');
  fs.renameSync(TEMP_FILE, DATA_FILE);
}

module.exports = { load, save, seedData, normalizeEnvironment, normalizeVariable, DATA_FILE };
