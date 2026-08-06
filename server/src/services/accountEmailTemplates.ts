import { type AccountEmailMessage } from './accountEmailSender';

export interface RenderedAccountEmail {
  subject: string;
  text: string;
  html: string;
}

export function renderAccountEmail(message: AccountEmailMessage): RenderedAccountEmail {
  const actionUrl = accountActionUrl(message.payload.actionUrl);
  if (message.template === 'verify_email') {
    return render(
      '验证你的 Primalthrum 邮箱',
      '验证邮箱',
      '请验证邮箱以启用 Workspace 和试用权益。该链接将在 24 小时后失效。',
      actionUrl,
    );
  }
  if (message.template === 'workspace_invitation') {
    const workspaceName = payloadText(message.payload.workspaceName, 'Workspace name', 120);
    const role = payloadText(message.payload.role, 'Workspace role', 40);
    return render(
      `加入 ${workspaceName} 的 Primalthrum Workspace`,
      '接受邀请',
      `你已被邀请以 ${role} 角色加入 ${workspaceName}。该一次性链接将在 7 天后失效。`,
      actionUrl,
    );
  }
  return render(
    '重置你的 Primalthrum 密码',
    '重置密码',
    '有人请求重置你的 Primalthrum 密码。该链接将在 30 分钟后失效；如非本人操作，请忽略此邮件。',
    actionUrl,
  );
}

function payloadText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const normalized = value.replace(/[\r\n]+/g, ' ').trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${label} is invalid`);
  return normalized;
}

function render(subject: string, action: string, description: string, actionUrl: string) {
  const safeUrl = escapeHtml(actionUrl);
  const safeAction = escapeHtml(action);
  const safeDescription = escapeHtml(description);
  return {
    subject,
    text: `${description}\n\n${action}: ${actionUrl}\n`,
    html: [
      '<!doctype html><html><body style="margin:0;background:#f4f4f5;color:#18181b;font-family:Arial,sans-serif">',
      '<div style="max-width:560px;margin:0 auto;padding:40px 20px">',
      '<div style="background:#fff;border:1px solid #e4e4e7;padding:32px">',
      '<p style="margin:0 0 24px;font-size:20px;font-weight:700">Primalthrum</p>',
      `<h1 style="margin:0 0 16px;font-size:24px">${safeAction}</h1>`,
      `<p style="margin:0 0 24px;line-height:1.6;color:#52525b">${safeDescription}</p>`,
      `<a href="${safeUrl}" style="display:inline-block;background:#18181b;color:#fff;padding:12px 18px;text-decoration:none">${safeAction}</a>`,
      `<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#71717a">按钮不可用时，请在浏览器打开：<br>${safeUrl}</p>`,
      '</div></div></body></html>',
    ].join(''),
  };
}

function accountActionUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('account email action URL is invalid');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('account email action URL is invalid');
  return url.toString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
