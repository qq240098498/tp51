// 请求模板里的变量占位符统一写成 {{变量名}}：
// 变量名以字母或下划线开头，只能包含字母、数字、下划线与中划线
// 目标地址、请求头（名称与取值）、请求内容都可以引用变量

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const TOKEN_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

function isValidVariableName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

// 扫描一段文本里的全部占位符，给出位置、原始写法与去掉空白后的变量名
function scanTokens(text) {
  const source = String(text == null ? '' : text);
  const tokens = [];
  TOKEN_PATTERN.lastIndex = 0;
  let match = null;
  while ((match = TOKEN_PATTERN.exec(source)) !== null) {
    tokens.push({
      raw: match[0],
      name: match[1].trim(),
      index: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

// 按变量表替换一段文本。变量表里查不到的占位符保留原文并标记 defined:false，
// 是否拦截由调用方根据 tokens 决定，本函数不抛异常
function renderText(text, variables) {
  const source = String(text == null ? '' : text);
  const map = new Map();
  (variables || []).forEach((row) => {
    if (row && typeof row.key === 'string' && row.key) {
      map.set(row.key.trim(), typeof row.value === 'string' ? row.value : '');
    }
  });

  const tokens = [];
  let output = '';
  let cursor = 0;
  scanTokens(source).forEach((token) => {
    output += source.slice(cursor, token.index);
    const defined = map.has(token.name);
    const value = defined ? map.get(token.name) : '';
    tokens.push({ ...token, defined, value });
    output += defined ? value : token.raw;
    cursor = token.end;
  });
  output += source.slice(cursor);
  return { text: output, tokens };
}

module.exports = {
  NAME_PATTERN,
  TOKEN_PATTERN,
  isValidVariableName,
  scanTokens,
  renderText,
};
