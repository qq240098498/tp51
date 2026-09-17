const crypto = require('crypto');
const { load, save } = require('./store');
const { isValidVariableName } = require('./template');

const MAX_ENV_NAME_LENGTH = 40;
const MAX_ENVIRONMENT_COUNT = 30;
const MAX_VARIABLE_COUNT = 50;
const MAX_VARIABLE_KEY_LENGTH = 64;
const MAX_VARIABLE_VALUE_LENGTH = 20 * 1024;

// 带错误码与出错位置的业务异常，结构与 api.ApiError 保持一致，页面据此标记具体条目
class EnvError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.name = 'EnvError';
    this.status = status;
    this.code = code;
    this.field = field || '';
  }
}

function pickText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function findEnvironment(data, id) {
  const env = data.environments.find((item) => item.id === id);
  if (!env) throw new EnvError(404, 'ENVIRONMENT_NOT_FOUND', '环境不存在或已被删除', '');
  return env;
}

// 环境名在所有环境之间唯一，重名时直接拒绝，避免切换时分不清
function assertEnvNameUnique(data, name, exceptId) {
  const duplicated = data.environments.some((item) => item.id !== exceptId && item.name === name);
  if (duplicated) {
    throw new EnvError(400, 'ENV_NAME_DUPLICATE', `已存在名为「${name}」的环境，请换一个名字`, 'envName');
  }
}

// 新建环境时若没取名，按「新环境 / 新环境 2 / 新环境 3」顺延
function nextEnvironmentName(data) {
  const base = '新环境';
  const used = new Set(data.environments.map((item) => item.name));
  if (!used.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

function listEnvironments() {
  const data = load();
  return {
    activeEnvironmentId: data.activeEnvironmentId,
    environments: data.environments,
  };
}

function createEnvironment(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  if (data.environments.length >= MAX_ENVIRONMENT_COUNT) {
    throw new EnvError(400, 'ENVIRONMENT_TOO_MANY', `环境数量最多 ${MAX_ENVIRONMENT_COUNT} 个`, '');
  }
  let name = pickText(input.name) || nextEnvironmentName(data);
  if (name.length > MAX_ENV_NAME_LENGTH) {
    throw new EnvError(400, 'ENV_NAME_TOO_LONG', `环境名称不能超过 ${MAX_ENV_NAME_LENGTH} 个字符`, 'envName');
  }
  assertEnvNameUnique(data, name, '');

  const created = {
    id: crypto.randomUUID(),
    name,
    variables: [],
  };
  data.environments.push(created);
  // 新建的环境自动切换为当前生效环境，马上就能往里加变量
  data.activeEnvironmentId = created.id;
  save(data);
  return { activeEnvironmentId: data.activeEnvironmentId, environment: created };
}

function renameEnvironment(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const name = pickText(input.name);
  if (!name) throw new EnvError(400, 'ENV_NAME_REQUIRED', '环境名称不能为空', 'envName');
  if (name.length > MAX_ENV_NAME_LENGTH) {
    throw new EnvError(400, 'ENV_NAME_TOO_LONG', `环境名称不能超过 ${MAX_ENV_NAME_LENGTH} 个字符`, 'envName');
  }

  const data = load();
  const env = findEnvironment(data, id);
  assertEnvNameUnique(data, name, id);
  env.name = name;
  save(data);
  return { id: env.id, name: env.name };
}

function deleteEnvironment(id) {
  const data = load();
  const index = data.environments.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new EnvError(404, 'ENVIRONMENT_NOT_FOUND', '环境不存在或已被删除', '');
  }
  if (data.environments.length <= 1) {
    throw new EnvError(400, 'ENVIRONMENT_LAST', '至少要保留一个环境，不能删除当前唯一的环境', '');
  }
  const [removed] = data.environments.splice(index, 1);
  // 删掉的正是当前生效环境时，自动落到剩下环境中的第一个
  if (data.activeEnvironmentId === removed.id) {
    data.activeEnvironmentId = data.environments[0].id;
  }
  save(data);
  return {
    id: removed.id,
    name: removed.name,
    activeEnvironmentId: data.activeEnvironmentId,
  };
}

function activateEnvironment(id) {
  const data = load();
  findEnvironment(data, id);
  data.activeEnvironmentId = id;
  save(data);
  return { activeEnvironmentId: id };
}

// 全量校验并保存某个环境的变量列表：变量名为空、字符合法、重名都要指出第几条
function validateVariables(rows) {
  if (!Array.isArray(rows)) {
    throw new EnvError(400, 'VARIABLES_INVALID', '变量需要按条目列表填写', 'variables');
  }
  if (rows.length > MAX_VARIABLE_COUNT) {
    throw new EnvError(400, 'VARIABLES_TOO_MANY', `变量最多 ${MAX_VARIABLE_COUNT} 条`, 'variables');
  }
  const list = [];
  const seen = new Set();
  rows.forEach((row, index) => {
    const key = pickText(row && row.key);
    const value = typeof (row && row.value) === 'string' ? row.value : '';
    if (!key && !value) return; // 整行为空的草稿行直接跳过，不参与校验
    if (!key) {
      throw new EnvError(400, 'VAR_KEY_REQUIRED', `第 ${index + 1} 条变量的名称为空，请补全变量名或删掉这一条`, `variables.${index}.key`);
    }
    if (key.length > MAX_VARIABLE_KEY_LENGTH) {
      throw new EnvError(400, 'VAR_KEY_TOO_LONG', `第 ${index + 1} 条变量名不能超过 ${MAX_VARIABLE_KEY_LENGTH} 个字符`, `variables.${index}.key`);
    }
    if (!isValidVariableName(key)) {
      throw new EnvError(
        400,
        'VAR_KEY_INVALID',
        `第 ${index + 1} 条变量名「${key}」不成立：变量名需以字母或下划线开头，只能包含字母、数字、下划线与中划线`,
        `variables.${index}.key`
      );
    }
    if (value.length > MAX_VARIABLE_VALUE_LENGTH) {
      throw new EnvError(400, 'VAR_VALUE_TOO_LONG', `第 ${index + 1} 条变量的取值不能超过 ${MAX_VARIABLE_VALUE_LENGTH} 个字符`, `variables.${index}.value`);
    }
    if (seen.has(key)) {
      throw new EnvError(400, 'VAR_KEY_DUPLICATE', `第 ${index + 1} 条变量名「${key}」与本环境中前面的条目重名`, `variables.${index}.key`);
    }
    seen.add(key);
    list.push({ key, value });
  });
  return list;
}

function saveVariables(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const variables = validateVariables(input.variables);
  const data = load();
  const env = findEnvironment(data, id);
  env.variables = variables;
  save(data);
  return { id: env.id, name: env.name, variables: env.variables };
}

module.exports = {
  EnvError,
  listEnvironments,
  createEnvironment,
  renameEnvironment,
  deleteEnvironment,
  activateEnvironment,
  saveVariables,
  validateVariables,
};
