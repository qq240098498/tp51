const crypto = require('crypto');
const { load, save } = require('./store');
const { ApiError } = require('./api');
const { NAME_RULE } = require('./templates');

const MAX_ENV_NAME_LENGTH = 40;
const MAX_VAR_KEY_LENGTH = 64;
const MAX_VAR_VALUE_LENGTH = 4096;
const MAX_VAR_COUNT = 200;

function pickText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function publicEnvironment(env) {
  return {
    id: env.id,
    name: env.name,
    variables: env.variables.map((row) => ({ key: row.key, value: row.value })),
    createdAt: env.createdAt,
    updatedAt: env.updatedAt,
  };
}

// 列表按创建时间从旧到新排列，环境顺序在页面上下拉里保持稳定
function listEnvironments() {
  const data = load();
  const list = data.environments
    .slice()
    .sort((a, b) => {
      if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : 1;
      return a.createdAt < b.createdAt ? -1 : 1;
    });
  return {
    activeEnvironmentId: data.activeEnvironmentId,
    environments: list.map(publicEnvironment),
  };
}

function findEnvironment(data, id) {
  const env = data.environments.find((item) => item.id === id);
  if (!env) throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', '该环境不存在或已被删除', 'environmentId');
  return env;
}

function assertEnvironmentName(data, name, exceptId) {
  const value = pickText(name);
  if (!value) {
    throw new ApiError(400, 'ENVIRONMENT_NAME_REQUIRED', '环境名称不能为空', 'environmentName');
  }
  if (value.length > MAX_ENV_NAME_LENGTH) {
    throw new ApiError(400, 'ENVIRONMENT_NAME_TOO_LONG', `环境名称不能超过 ${MAX_ENV_NAME_LENGTH} 个字符`, 'environmentName');
  }
  const duplicated = data.environments.find(
    (item) => item.id !== exceptId && item.name.toLowerCase() === value.toLowerCase()
  );
  if (duplicated) {
    throw new ApiError(409, 'ENVIRONMENT_NAME_DUPLICATE', `已存在同名环境「${value}」，请换一个名称`, 'environmentName');
  }
  return value;
}

// 校验单个变量名：不能为空、字符合法、长度受限
function validateVariableKey(key) {
  const value = pickText(key);
  if (!value) {
    throw new ApiError(400, 'VARIABLE_KEY_REQUIRED', '变量名不能为空', 'variableKey');
  }
  if (value.length > MAX_VAR_KEY_LENGTH) {
    throw new ApiError(400, 'VARIABLE_KEY_TOO_LONG', `变量名不能超过 ${MAX_VAR_KEY_LENGTH} 个字符`, 'variableKey');
  }
  if (!NAME_RULE.test(value)) {
    throw new ApiError(
      400,
      'VARIABLE_KEY_INVALID',
      `变量名「${value}」不成立，只能使用字母、数字、下划线、中划线与点`,
      'variableKey'
    );
  }
  return value;
}

function validateVariableValue(value) {
  const text = typeof value === 'string' ? value : '';
  if (text.length > MAX_VAR_VALUE_LENGTH) {
    throw new ApiError(400, 'VARIABLE_VALUE_TOO_LONG', `变量取值不能超过 ${MAX_VAR_VALUE_LENGTH} 个字符`, 'variableValue');
  }
  return text;
}

// 找到同一环境里的同名变量（忽略大小写），返回条目序号
function findDuplicateVariable(env, key, exceptIndex) {
  const lower = key.toLowerCase();
  return env.variables.findIndex((row, index) => index !== exceptIndex && row.key.toLowerCase() === lower);
}

function createEnvironment(payload) {
  const data = load();
  const name = assertEnvironmentName(data, payload && payload.name);
  const now = new Date().toISOString();
  const env = {
    id: crypto.randomUUID(),
    name,
    variables: [],
    createdAt: now,
    updatedAt: now,
  };
  data.environments.push(env);
  const activate = payload && payload.activate !== false;
  if (activate || !data.activeEnvironmentId) data.activeEnvironmentId = env.id;
  save(data);
  return { environment: publicEnvironment(env), activeEnvironmentId: data.activeEnvironmentId };
}

function renameEnvironment(id, payload) {
  const data = load();
  const env = findEnvironment(data, id);
  env.name = assertEnvironmentName(data, payload && payload.name, id);
  env.updatedAt = new Date().toISOString();
  save(data);
  return { environment: publicEnvironment(env) };
}

// 切换当前生效环境；环境不存在时明确拒绝，不会悄悄落到别的环境上
function activateEnvironment(id) {
  const data = load();
  findEnvironment(data, id);
  data.activeEnvironmentId = id;
  save(data);
  return { activeEnvironmentId: id };
}

// 删除环境：删的是当前环境时自动把当前环境切到剩下的第一个；删空后当前环境留空
function deleteEnvironment(id) {
  const data = load();
  const env = findEnvironment(data, id);
  const index = data.environments.findIndex((item) => item.id === id);
  data.environments.splice(index, 1);
  let activeEnvironmentId = data.activeEnvironmentId;
  if (activeEnvironmentId === id) {
    activeEnvironmentId = data.environments.length ? data.environments[0].id : '';
    data.activeEnvironmentId = activeEnvironmentId;
  }
  save(data);
  return { id, name: env.name, activeEnvironmentId };
}

// 向指定环境逐条添加变量；变量名为空或同环境重名当场拒绝，并指出是哪一条不成立
function addVariable(environmentId, payload) {
  const data = load();
  const env = findEnvironment(data, environmentId);
  const key = validateVariableKey(payload && payload.key);
  const value = validateVariableValue(payload && payload.value);
  if (env.variables.length >= MAX_VAR_COUNT) {
    throw new ApiError(400, 'VARIABLE_TOO_MANY', `单个环境最多保存 ${MAX_VAR_COUNT} 条变量`, 'variableKey');
  }
  const duplicateIndex = findDuplicateVariable(env, key, -1);
  if (duplicateIndex !== -1) {
    throw new ApiError(
      409,
      'VARIABLE_KEY_DUPLICATE',
      `第 ${duplicateIndex + 1} 条变量已经叫「${key}」，同一环境下变量名不能重复`,
      'variableKey'
    );
  }
  env.variables.push({ key, value });
  env.updatedAt = new Date().toISOString();
  save(data);
  return { environment: publicEnvironment(env), index: env.variables.length - 1 };
}

// 修改已有变量的取值（变量名保持不变，改名等价于删旧增新，重名规则更清楚）
function updateVariableValue(environmentId, key, payload) {
  const data = load();
  const env = findEnvironment(data, environmentId);
  const index = env.variables.findIndex((row) => row.key.toLowerCase() === String(key || '').toLowerCase());
  if (index === -1) {
    throw new ApiError(404, 'VARIABLE_NOT_FOUND', `环境「${env.name}」里没有变量「${key}」`, 'variableKey');
  }
  env.variables[index].value = validateVariableValue(payload && payload.value);
  env.updatedAt = new Date().toISOString();
  save(data);
  return { environment: publicEnvironment(env), index };
}

// 删除变量前先看其他环境是否还在引用同名变量：
// 默认不删，返回 409 与引用环境清单；force=true 表示用户已知情，只删当前环境这一条
function deleteVariable(environmentId, key, options) {
  const data = load();
  const env = findEnvironment(data, environmentId);
  const wantedKey = validateVariableKey(key);
  const index = env.variables.findIndex((row) => row.key.toLowerCase() === wantedKey.toLowerCase());
  if (index === -1) {
    throw new ApiError(404, 'VARIABLE_NOT_FOUND', `环境「${env.name}」里没有变量「${wantedKey}」`, 'variableKey');
  }
  const [removed] = env.variables.splice(index, 1);

  // 其他环境里同名（忽略大小写）的变量都算仍在引用，列出环境名供页面给出明确结论
  const referencedBy = data.environments
    .filter((item) => item.id !== env.id)
    .filter((item) => item.variables.some((row) => row.key.toLowerCase() === removed.key.toLowerCase()))
    .map((item) => ({ id: item.id, name: item.name }));

  if (referencedBy.length && !(options && options.force)) {
    // 还没得到确认：回滚这次删除，把变量原样放回去，绝不静默删掉
    env.variables.splice(index, 0, removed);
    throw new ApiError(
      409,
      'VARIABLE_STILL_REFERENCED',
      `变量「${removed.key}」仍被其他环境引用：${referencedBy.map((item) => item.name).join('、')}`,
      'variableKey',
      { referencedBy }
    );
  }

  env.updatedAt = new Date().toISOString();
  save(data);
  return {
    environmentId: env.id,
    environmentName: env.name,
    key: removed.key,
    removedFromCurrent: true,
    stillReferencedBy: referencedBy,
  };
}

module.exports = {
  listEnvironments,
  createEnvironment,
  renameEnvironment,
  activateEnvironment,
  deleteEnvironment,
  addVariable,
  updateVariableValue,
  deleteVariable,
  MAX_ENV_NAME_LENGTH,
  MAX_VAR_KEY_LENGTH,
  MAX_VAR_VALUE_LENGTH,
  MAX_VAR_COUNT,
};
