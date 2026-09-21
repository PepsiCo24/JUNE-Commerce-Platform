import { describe, expect, it, vi } from 'vitest';

import { AuditService } from './audit.service';

describe('AuditService PII 脱敏', () => {
  it('buildDiff 对店铺/支付宝敏感字段只记 changed,不写明文', () => {
    const service = new AuditService({ db: { auditLog: { create: vi.fn() } } } as never);

    const diff = service.buildDiff(
      {
        name: '旧名',
        phone: '13812345678',
        platformAccount: 'seller@shop.test',
        contactInfo: '13900001111',
        account: 'zfb-user',
        note: '隐私备注',
      },
      {
        name: '新名',
        phone: '13887654321',
        platformAccount: 'seller2@shop.test',
        contactInfo: '13900002222',
        account: 'zfb-user-2',
        note: '新备注',
      },
    );

    expect(diff.name).toEqual({ from: '旧名', to: '新名' });
    expect(diff.phone).toEqual({ changed: true });
    expect(diff.platformAccount).toEqual({ changed: true });
    expect(diff.contactInfo).toEqual({ changed: true });
    expect(diff.account).toEqual({ changed: true });
    expect(diff.note).toEqual({ changed: true });
    expect(JSON.stringify(diff)).not.toContain('138');
    expect(JSON.stringify(diff)).not.toContain('seller');
    expect(JSON.stringify(diff)).not.toContain('zfb-user');
    expect(JSON.stringify(diff)).not.toContain('隐私');
    expect(JSON.stringify(diff)).not.toContain('备注');
  });

  it('record 写入前对 metadata 中的账号字段脱敏', async () => {
    const create = vi.fn().mockResolvedValue({});
    const service = new AuditService({ db: { auditLog: { create } } } as never);

    await service.record({
      actor: null,
      action: 'credential.create',
      targetType: 'ShopCredential',
      targetId: 'c1',
      metadata: { shopId: 's1', purpose: '登录', account: 'seller@shop.test' },
    });

    expect(create).toHaveBeenCalledOnce();
    const payload = create.mock.calls[0]?.[0]?.data as {
      metadata: Record<string, unknown>;
    };
    expect(payload.metadata.account).toBe('[redacted]');
    expect(JSON.stringify(payload)).not.toContain('seller@shop.test');
  });
});
