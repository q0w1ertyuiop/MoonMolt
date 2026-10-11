<p align="center"><img src="docs/logo.svg" width="112" alt="MoonMolt moon and database logo"></p>

# MoonMolt · 月蜕

**结构焕新，数据如初。**

MoonMolt 是用 MoonBit 编写的 SQLite 迁移库与 CLI。适用于桌面应用、本地工具和小型服务：升级前保留一致性备份，在副本上演练，再用一个事务执行整批迁移。迁移脚本、历史记录和结构指纹共同决定数据库能否继续升级。

首版运行在 Node.js ≥24.10.0，无 npm 运行时依赖。MoonBit 工具链仅用于源码构建；尚未发布 npm 或 Mooncakes 包。

## 快速开始

安装 [MoonBit 工具链](https://www.moonbitlang.com/download/) 和 Node.js 后：

```sh
git clone https://github.com/q0w1ertyuiop/MoonMolt.git
cd MoonMolt
npm run build
npm run demo
```

演示实际创建用户、订单数据库，增加订单状态并回填、建立索引、重建用户表；中途加入错误迁移，检查原有数据和历史仍完整，再修正并重试。脚本带断言，不需要提前准备数据库。[本次实际运行结果](docs/demo-report.json)记录了输入、输出和环境。

## 在应用中使用

迁移目录中的 SQL 文件采用六位正整数版本号，名称允许字母、数字、下划线与连字符：

```text
migrations/
  000001_order_status.sql
  000002_order_index.sql
  000003_required_user_name.sql
```

```sh
node node/cli.mjs inspect --db app.db --format json
node node/cli.mjs status --db app.db --dir migrations
node node/cli.mjs rehearse --db app.db --dir migrations
node node/cli.mjs apply --db app.db --dir migrations --to 2
node node/cli.mjs apply --db app.db --dir migrations --rebuild
```

版本按数字排序，允许间隔，禁止重复。SHA-256 根据文件原始字节计算，包括注释和换行；已经执行的文件必须保持原样，历史必须是当前目录的完整前缀。数据库不存在时仅 `apply --create` 可以创建它。再次执行已完成的迁移会成为无操作，不新增备份。

已有但未使用迁移工具的数据库：把适合其当前结构的**第一项升级**编号为 `000001`。首次执行会在同一事务中创建历史表。用于全新数据库的目录应包含建表迁移；不要把旧库已经执行过的建表文件直接作为其待执行目录，工具不会自动把这些文件标记为已执行。

也可以在 Node.js 应用中复用同一个引擎。源码构建后使用本地入口，打包安装后使用 `import { run, plan } from 'moonmolt'`：

```js
import { run } from './node/runtime.mjs';
const report = await run({
  command: 'apply', db: 'app.db', dir: 'migrations',
  busy_timeout_ms: 5000,
  // backup_dir: '/path/to/application-backups',
});
if (!report.ok) throw new Error(`${report.kind}: ${report.message}`);
```

运行时串行处理同一 Node 进程中的调用；跨进程并发通过 SQLite 写锁协调。MoonBit 用户可复用根包的 `load_migrations`、`validate_history`、`plan`，或实现 `Driver` 调用 `prepare`／`complete`。接口见 [pkg.generated.mbti](pkg.generated.mbti)，宿主操作约定见 [执行协议](docs/engine.md)。目前根包使用本地开发模块标识，不代表已在 Mooncakes 注册。

库调用在入队前固定参数并解析绝对路径，调用后修改原对象或工作目录不会改变迁移目标。`busy_timeout_ms` 配置锁等待（默认 5000，0 表示立即失败）；`backup_dir` 为 `apply` 指定持久备份目录，对应 CLI 的 `--busy-timeout-ms` 和 `--backup-dir`。安装包附带 TypeScript 类型声明。SQLite 执行是同步的，长迁移建议在维护窗口或独立工作进程运行。

## Schema 辅助规划

```sh
node node/cli.mjs plan --before examples/before.json --after examples/after.json --allow-destructive --format json
```

增加 `--out upgrade.sql` 可保存 SQL 草稿；已有输出文件不会被覆盖。检查草稿后将其作为新版本放入迁移目录。报告包含风险与 `requires_rebuild`；要求重建时执行端必须指定 `--rebuild`。

规划器复用 [`kath61105/moon_schema_plan@0.4.0`](https://mooncakes.io/docs/kath61105/moon_schema_plan@0.4.0)。MoonMolt 负责识别并移除其已知事务包装，保留重建 SQL 和外键检查，统一由执行引擎管理事务。

自动规划只接受明确的完整结构模型：普通表、单列主键、简单列索引、外键和明确的重命名提示。类型限定为 `INTEGER / TEXT / REAL / BLOB / NUMERIC`。视图、触发器、CHECK、生成列、部分或表达式索引、复合主键、自定义排序规则、虚拟表、STRICT 和 WITHOUT ROWID 等应使用人工 SQL。未知模型字段会被拒绝。

`inspect` 输出原始 SQL、列、索引及外键元数据，用来检查实际数据库；它与规划器输入是两种格式，不能直接互换。不要从模型中省略现有对象来绕过限制，否则显式模型可能表示删除对象的意图。SQL 草稿必须经过阅读和演练。

## 升级如何执行

![MoonMolt execution architecture](docs/architecture.svg)

1. 读取一次迁移文件，验证版本、历史与结构指纹。
2. 获取 `BEGIN IMMEDIATE` 写锁，并在锁内再次检查历史。
3. 在任何修改前，通过第二个只读连接备份，再从备份复制演练数据库。
4. 在副本上完整执行迁移，检查外键与数据库完整性。
5. 在原库执行同一批 SQL，将历史记录写入同一事务，核对最终结构后提交。

发生错误时，本批事务回滚；之前已经成功提交的批次保留。失败记录写入外部报告，不在失败事务中留下历史。工具提供向前升级和升级前备份，不提供自动降级。

请在应用启动或维护窗口执行，暂停应用写入。默认外键检查开启；`--rebuild` 会在事务外关闭本批外键约束，并在提交前检查所有引用。该模式下级联更新／删除不会自动发生，脚本需要明确维护相关数据。重建表请按“创建新表 → 明确列映射复制 → 删除旧表 → 重命名 → 恢复索引、触发器和视图”的顺序操作。

脚本不能自行控制事务、保存点、附加数据库、修改迁移历史或修改 PRAGMA 配置。允许无参数的只读外键检查，以支持生成 SQL 的检查步骤。脚本整体交给 SQLite 执行，字符串中的分号和触发器 `BEGIN / END` 不会被错误切分。

备份位于 `<数据库路径>.moonmolt-backups/`，每次使用唯一文件名，旁边保存 JSON 执行报告；恢复步骤见 [备份恢复说明](docs/restore.md)。演练不会验证全部业务逻辑，也不能预先保证磁盘或进程在后续不会出错。若返回 `commit_outcome_unknown`，先检查历史，禁止盲目重放。

重建带 `AUTOINCREMENT` 的表时，复制存量行并不能保留已经删除记录的 ID 上限。引擎会在每个脚本结束后检查同名表的 `sqlite_sequence`，发现上限降低或丢失即阻止升级。脚本应显式保留旧上限，并在插入新记录前恢复；更换表名时需按新名称恢复，引擎无法从任意 SQL 推断表的身份。自动模型不支持 AUTOINCREMENT，请使用人工 SQL。历史表的非标准结构、额外索引或触发器也会被拒绝。

## 验证与打包

```sh
moon check --target js --deny-warn
moon test --target js
npm run build
npm test
npm pack
```

测试覆盖实际 SQLite 升级、演练、历史篡改、结构漂移、真实执行失败、外键、触发器、WAL 备份、并发、写锁超时与进程中断。CI 配置了 Windows／Linux／macOS 和 Node.js 24／26；本地验证环境与远端运行状态分别记录，不把未运行的平台写成已通过。

`npm pack` 包含已编译的 MoonBit 引擎与 Node 适配器，安装生成的压缩包后可以直接使用 `moonmolt` 命令。源码构建过程不需要 `npm install`。

设计与修正过程见 [开发记录](docs/development.md)。项目采用 Apache-2.0 许可证。
