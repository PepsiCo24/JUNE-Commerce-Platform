import { describe, expect, it } from 'vitest';

import { redactErrorMessage, redactTaskParams } from './admin-redact.util';

describe('redactTaskParams', () => {
  it('按字段名脱敏,不改动正常业务参数', () => {
    const result = redactTaskParams({
      prompt: '一只在草地上的柯基',
      count: 4,
      size: '1024x1024',
      apiKey: 'sk-should-never-appear',
      authorization: 'Bearer should-never-appear',
      nested: { providerSecret: 'nope', modelKey: 'seedream-3.0' },
    });

    expect(result.prompt).toBe('一只在草地上的柯基');
    expect(result.count).toBe(4);
    expect(result.apiKey).toBe('[redacted]');
    expect(result.authorization).toBe('[redacted]');
    expect(result.nested).toMatchObject({
      providerSecret: '[redacted]',
      modelKey: 'seedream-3.0',
    });
    expect(JSON.stringify(result)).not.toContain('should-never-appear');
  });

  it('值里夹带的密钥形态同样被替换', () => {
    const result = redactTaskParams({
      note: '调用失败,使用的凭据是 sk-abcdefghijklmnopqrst',
      url: 'https://api.example.com/v1/images?api_key=abcdefghijklmn&size=1024',
    });

    const serialized = JSON.stringify(result);
    expect(serialized).toContain('[redacted]');
    expect(serialized).not.toContain('sk-abcdefghijklmnopqrst');
    expect(serialized).not.toContain('abcdefghijklmn&size');
  });

  it('非对象输入与空值不会抛错', () => {
    expect(redactTaskParams(null)).toEqual({});
    expect(redactTaskParams(undefined)).toEqual({});
    expect(redactTaskParams('plain')).toEqual({ value: 'plain' });
  });
});

describe('redactErrorMessage', () => {
  it('脱敏上游回吐的令牌,保留可排障的语义', () => {
    const message = redactErrorMessage(
      '401 Unauthorized: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 is invalid',
    );
    expect(message).toContain('401 Unauthorized');
    expect(message).toContain('Bearer [redacted]');
    expect(message).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('null 原样返回,便于区分"无错误"与"错误信息为空"', () => {
    expect(redactErrorMessage(null)).toBeNull();
    expect(redactErrorMessage(undefined)).toBeNull();
  });
});
