const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const TEMP_FILE = path.join(DATA_DIR, 'db.json.tmp');

// 初始环境：装上依赖就有开发与生产两套可切换的环境，同名变量取不同值
const SEED_ENVIRONMENTS = [
  {
    id: 'env-dev',
    name: '开发环境',
    variables: [
      { key: 'host', value: '127.0.0.1:5051' },
      { key: 'token', value: 'dev-token-1001' },
    ],
  },
  {
    id: 'env-prod',
    name: '生产环境',
    variables: [
      { key: 'host', value: 'api.example.com' },
      { key: 'token', value: 'prod-token-9f2c7b' },
    ],
  },
];

// 初始数据：维护用例集合与环境集合，示例用例都指向内置示例接口，装上依赖就能直接发送
function seedData() {
  return {
    activeEnvironmentId: SEED_ENVIRONMENTS[0].id,
    environments: SEED_ENVIRONMENTS.map((env) => ({
      ...env,
      variables: env.variables.map((row) => ({ ...row })),
    })),
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

// 把单个变量整理成固定结构；变量值允许为空字符串，空值照样参与替换
function normalizeVariable(item) {
  const source = item && typeof item === 'object' ? item : {};
  return {
    key: typeof source.key === 'string' ? source.key : '',
    value: typeof source.value === 'string' ? source.value : '',
  };
}

// 把单个环境整理成固定结构，避免数据文件被手工改动后出现缺字段
function normalizeEnvironment(item) {
  const source = item && typeof item === 'object' ? item : {};
  return {
    id: typeof source.id === 'string' ? source.id : '',
    name: typeof source.name === 'string' ? source.name : '',
    variables: Array.isArray(source.variables)
      ? source.variables.map(normalizeVariable)
      : [],
  };
}

// 整份数据保证 cases、environments 与 activeEnvironmentId 字段都存在且结构一致
function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const cases = Array.isArray(source.cases) ? source.cases.map(normalizeCase).filter((item) => item.id) : [];
  const environments = Array.isArray(source.environments)
    ? source.environments.map(normalizeEnvironment).filter((item) => item.id)
    : [];
  let activeEnvironmentId = typeof source.activeEnvironmentId === 'string' ? source.activeEnvironmentId : '';
  if (!environments.some((env) => env.id === activeEnvironmentId)) {
    activeEnvironmentId = environments.length ? environments[0].id : '';
  }
  return { ...source, cases, environments, activeEnvironmentId };
}

// 读取数据文件：文件缺失或内容损坏时回落到初始数据并立刻补写
function load() {
  let data = null;
  try {
    data = normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (err) {
    data = seedData();
    save(data);
    return data;
  }
  // 老版本数据里没有环境集合时，用初始环境补齐并回写，已有用例保持不动
  if (!data.environments.length) {
    const seed = seedData();
    data = { ...data, environments: seed.environments, activeEnvironmentId: seed.activeEnvironmentId };
    save(data);
  }
  return data;
}

// 先写临时文件再改名，写入中途被打断也不会把正式数据文件写坏
function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const text = `${JSON.stringify(normalize(data), null, 2)}\n`;
  fs.writeFileSync(TEMP_FILE, text, 'utf8');
  fs.renameSync(TEMP_FILE, DATA_FILE);
}

module.exports = { load, save, seedData, DATA_FILE };
