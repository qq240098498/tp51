'use strict';

// 请求区里的变量占位写法：{{变量名}}
// 目标地址、请求头名称与取值、请求内容都可以用这种写法引用当前环境里的变量
// 变量名只允许字母、数字、下划线、中划线与点，避免把空格、括号这类字符带进占位
const NAME_RULE = /^[A-Za-z0-9_.-]+$/;

function hasPlaceholder(text) {
  return typeof text === 'string' && text.includes('{{');
}

// 逐段扫描一段文本：把普通文本与占位分开，同时挑出不成立的占位
// 不成立的情况有三种：没有闭合的 {{、变量名为空的 {{  }}、变量名含非法字符
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
      issues.push({
        code: 'TEMPLATE_UNCLOSED',
        name: '',
        raw,
        message: `有一处变量占位没有闭合：${raw}`,
      });
      textStart = source.length;
      cursor = source.length;
      break;
    }

    pushLiteral(open);
    const raw = source.slice(open, close + 2);
    const name = source.slice(open + 2, close).trim();
    if (!name) {
      tokens.push({ type: 'broken', raw, name: '', code: 'TEMPLATE_EMPTY_NAME' });
      issues.push({
        code: 'TEMPLATE_EMPTY_NAME',
        name: '',
        raw,
        message: `存在变量名为空的占位：${raw}`,
      });
    } else if (!NAME_RULE.test(name)) {
      tokens.push({ type: 'broken', raw, name, code: 'TEMPLATE_INVALID_NAME' });
      issues.push({
        code: 'TEMPLATE_INVALID_NAME',
        name,
        raw,
        message: `变量名「${name}」不成立，只能使用字母、数字、下划线、中划线与点`,
      });
    } else {
      tokens.push({ type: 'placeholder', raw, name });
    }
    textStart = close + 2;
    cursor = close + 2;
  }

  pushLiteral(source.length);
  return { tokens, issues };
}

module.exports = { hasPlaceholder, scanTemplate, NAME_RULE };
