# 备份与恢复

脚本:

| 脚本 | 作用 |
| --- | --- |
| `deploy/scripts/backup-db.sh` | `pg_dump -Fc` → 试读 → gzip → 上传独立桶 → 删过期 |
| `deploy/scripts/restore-db.sh` | 恢复到临时库或原地覆盖(破坏性,要确认) |
| `deploy/scripts/verify-backup.sh` | 每周演练:恢复到 `june_verify_*` 后删除 |
| `deploy/scripts/install-cron.sh` | 安装上述定时任务 |

相关 `.env`:`BACKUP_ENABLED`、`BACKUP_CRON`(默认 `0 3 * * *` 服务器**本地时区**)、`BACKUP_RETENTION_DAYS`、`BACKUP_S3_BUCKET`、`BACKUP_LOCAL_DIR`、以及对象存储 `S3_*`。

**备份桶必须与图片桶分开**(`BACKUP_S3_BUCKET` ≠ `S3_BUCKET`),避免一次误删全没。

## 1. 打开每日备份

```bash
# .env
BACKUP_ENABLED=true
BACKUP_S3_BUCKET=june-backups          # 独立桶
BACKUP_LOCAL_DIR=/var/backups/june
BACKUP_RETENTION_DAYS=14
BACKUP_CRON=0 3 * * *

./deploy/scripts/install-cron.sh
./deploy/scripts/backup-db.sh --tag manual-smoke
```

手工只留本地:`./deploy/scripts/backup-db.sh --local-only --tag laptop`

失败必须响:脚本非零退出;可设 `JUNE_ALERT_COMMAND` 把 stdin 推到群机器人。cron 静默失败等于没有备份。

每次 dump 都会 `pg_restore --list` 试读,列不出目录当场失败。

## 2. 恢复验证(先做这个,再碰生产库)

```bash
# 用最新本地备份演练
./deploy/scripts/verify-backup.sh

# 更接近灾难:先从对象存储拉最新一份
./deploy/scripts/verify-backup.sh --from-remote

# 保留临时库给人眼看
./deploy/scripts/verify-backup.sh --keep
```

演练在 `june_verify_<时间戳>` 进行,默认结束即删。报告在 `deploy/logs/restore-drills/`。

没有演练过的备份不能当备份。

## 3. 真恢复(维护窗口)

推荐路径:

```bash
# ① 恢复到临时库核对
./deploy/scripts/restore-db.sh backups/june-june-YYYYMMDDT...dump.gz --to-temp
# 或
./deploy/scripts/restore-db.sh --latest --to-temp

# ② 停应用,改名切换(可再改回去)
docker compose stop api worker web
# 在 postgres 容器内:
#   ALTER DATABASE june RENAME TO june_old_<ts>;
#   ALTER DATABASE june_restore_<ts> RENAME TO june;
docker compose start api worker web
./deploy/scripts/healthcheck.sh
```

原地覆盖(原库立即消失,只剩备份文件):

```bash
./deploy/scripts/restore-db.sh backups/xxx.dump.gz --in-place
```

脚本会要求交互确认。RPO = 备份时刻之后的业务数据全部丢失,执行前必须评估并通知用户。

## 4. 对象存储版本 / 误删

数据库恢复**不会**回退图片对象:

| 现象 | 处理 |
| --- | --- |
| 库里没记录、对象还在 | 孤儿文件,管理站「存储 → 清理预览/执行」`orphan_asset` |
| 库里有记录、对象没了 | 从对象存储**版本**或跨区域复制恢复该 key;桶必须开版本控制 |
| 整桶误删 | 用备份桶/跨账号复制;图片桶与备份桶账号分离就是为这一刻 |

上线前检查(云控制台):

1. 图片桶开启 Versioning
2. 生命周期:非当前版本保留天数 ≥ 回收期(`ASSET_RECYCLE_DAYS`,默认 14)+ 余量
3. 禁止生产账号对备份桶的 DeleteBucket
4. 管理站清理默认 dryRun,执行要二次确认并写审计

应用内回收站:删除资产进入回收期,`refCount > 0` 不物理删。这不是异地备份。
