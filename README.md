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
node node/cli.mjs verify --db app.db --dir migrations --worker
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

`run` 串行处理同一 JavaScript 上下文中的调用；Worker 或跨进程并发通过 SQLite 写锁协调。MoonBit 用户可复用根包的 `load_migrations`、`validate_history`、`plan`，或实现 `Driver` 调用 `prepare`／`complete`。接口见 [pkg.generated.mbti](pkg.generated.mbti)，宿主操作约定见 [执行协议](docs/engine.md)。目前根包使用本地开发模块标识，不代表已在 Mooncakes 注册。

库调用在入队前固定参数并解析绝对路径，调用后修改原对象或工作目录不会改变迁移目标。`busy_timeout_ms` 配置锁等待（默认 5000，0 表示立即失败）；`backup_dir` 为 `apply` 指定持久备份目录，对应 CLI 的 `--busy-timeout-ms` 和 `--backup-dir`。安装包附带 TypeScript 类型声明。SQLite 执行是同步的，长迁移建议在维护窗口或独立工作进程运行。

## 在独立线程升级（0.3.0）

桌面应用或服务需要保持主线程响应时，可以使用同一引擎的独立线程入口：

```js
import { runInWorker } from 'moonmolt';
const report = await runInWorker(
  { command: 'apply', db: 'app.db', dir: 'migrations' },
  { onProgress(event) { console.log(event.stage, event.operation, event.state); } },
);
if (!report.ok) throw new Error(`${report.kind}: ${report.message}`);
```

每次调用创建一个 Worker，完成连接清理并退出后返回结果；无需手动管理线程。它复用演练、备份、业务验收与历史校验。参数和相对路径在调用时固定。同一数据库的并发升级仍由 SQLite 写锁协调；`run` 的队列仅在当前 JavaScript 上下文内共享。Worker 不会缩短 SQL 执行或持锁时间，也不能替代维护窗口。

`run(request, { onProgress })` 也支持进度通知，但 SQL 操作仍在调用线程同步执行。事件包含阶段、操作、开始／完成／失败状态、文件和检查名称，以及备份页数；不包含 SQL 内容或业务行。`sequence` 在每次调用内递增，`timestamp` 为 UTC 时间。事件是阶段信息，不是整批任务的百分比。

回调必须同步返回；异常或返回 Promise 会被记录为最多 16 条 `progress_warnings`，不会改变迁移结果。若 Worker 执行 `apply` 后没有最终报告，即使已经收到提交进度，仍返回 `commit_outcome_unknown`；先读取历史再决定下一步，不自动重试。

CLI 可使用 `--worker --progress`；最终报告输出到 stdout，进度输出到 stderr。`--format json` 时进度为带 `type: "progress"` 的 JSON Lines；失败的最终报告也在 stderr。Node.js 的运行时警告可能同时出现在 stderr，解析时应筛选 JSON 行。

## 随应用打包与升级前置检查（0.5.0）

桌面应用或服务可以直接携带迁移文本，无需在运行时释放 SQL 目录。`run` 和 `runInWorker` 都支持 `migrations`，它与 `dir` 互斥；文件名、版本顺序、演练、业务检查和历史规则相同。

```js
import { runInWorker } from './node/runtime.mjs';

const migrations = [
  { filename: '000001_notes.sql', sql: 'CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL);' },
  { filename: '000003_pinned.sql', sql: 'ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;',
    checks_json: '{"checks":[{"name":"pinned backfill","sql":"SELECT NOT EXISTS(SELECT 1 FROM notes WHERE pinned<>0);"}]}' },
];
const report = await runInWorker({
  command: 'apply', db: 'notes.db', migrations,
  expected_application_id: 1297042516,
  expected_version: 0,
});
if (!report.ok) throw new Error(`${report.kind}: ${report.message}`);
```

示例要求数据库已经由应用初始化为该标识。`expected_application_id` 比较 SQLite 的 [`PRAGMA application_id`](https://www.sqlite.org/pragma.html#pragma_application_id)，接受有符号 32 位整数；工具只检查，不会自动设置或覆盖。未设置的数据库标识为 `0`，`--create` 创建的新库同样如此。应用应在创建自己的新文件时初始化标识，不要给未知旧文件重新打标来绕过检查。该标识区分应用文件类型，不能区分同一应用的不同用户数据库，也不是安全认证。

`expected_version` 要求**当前 MoonMolt 历史版本**等于指定值，`0` 表示没有迁移历史，版本允许间隔；它不是 SQLite 的 `user_version`。两项条件在事务内检查，`apply` 先取得写锁；条件不符返回 `policy`，不执行脚本、不新增备份，已完成迁移的无操作调用也会检查。两个调用都要求旧版本时，后拿到锁的调用会失败。正常启动需要幂等升级时可省略版本条件；处理不确定提交结果时，应先通过不带旧版本条件的 `status` 核对历史，不能自动改条件重放。

```sh
node node/cli.mjs status --db notes.db --dir migrations --format json
node node/cli.mjs apply --db notes.db --dir migrations --expected-application-id 1297042516 --expected-version 3 --worker
npm run demo:embedded
```

`status` 增加 `application_id` 和 `current_version`，`inspect` 的快照也包含标识。`migrations` 在调用时复制并冻结，只接受 `filename / sql / checks_json`；校验和由宿主计算。`checks_json` 是可选检查文件的原始 JSON **字符串**。从文件方式切换时，必须保留原始 UTF-8 文本，包括 BOM、换行与 JSON 排版，才能匹配原有校验和；不要先解析再序列化检查文件。拒绝 NUL SQL、无效 Unicode、重复版本和未知字段。完整的笔记应用例子见 [examples/embedded.mjs](examples/embedded.mjs)。

## 锁定审阅过的初始结构（0.8.0）

首次接管旧库时，还没有历史指纹可供比较；相同应用标识和版本也可能对应不同的表、索引或触发器。先审阅可信数据库的 `inspect` 快照，保存其中的 `fingerprint`，部署时用 `expected_fingerprint` 约束初始结构：

```js
const report = await runInWorker({
  command: 'apply', db: 'app.db', migrations,
  expected_application_id: 1297042516,
  expected_version: 0,
  expected_fingerprint: reviewedSchemaFingerprint,
});
```

该值必须是 64 位小写十六进制字符串，对应 CLI `--expected-fingerprint <指纹>`。所有数据库命令均支持；`apply` 在取得写锁后、备份及执行 SQL 前核对，其他命令在读取事务中核对。条件不符返回 `policy`，无操作调用也检查。已有历史的结构漂移仍优先返回 `history_mismatch`。`status`、`verify` 和无操作报告增加 `fingerprint`；`inspect.snapshot.fingerprint` 和完成批次的 `result.fingerprint`／`rehearsal.fingerprint` 保持可用。

指纹基于排序后的原始结构对象及 SQL，不包含业务数据、应用标识或版本，不能证明数据库属于哪个用户，也不是签名。等价但 SQL 表示不同的结构也可能有不同指纹。升级改变结构后，原指纹会拒绝再次调用；正常幂等启动可省略该条件，或使用已经确认成功的新结构指纹。不要在条件失败后读取未知文件的当前指纹并自动重试，这会绕过原先的审阅约束。可运行的笔记示例演示了旧指纹拒绝与新指纹下的无操作调用。

迁移脚本还会在每条相关 DDL 后检查 TEMP 名称：临时表或视图不能与主库表或视图同名（按 SQLite 的名称比较规则）。否则未限定 schema 的业务查询可能读到临时旧数据，掩盖原库损失；即使稍后删除临时对象也会立即拒绝。使用独立名称，例如 `temp.moonmolt_orders_copy`，并在查询中显式写 `main.orders`。名称不同的辅助表可跨脚本使用；不同 schema 中同名的索引以及 SQLite 自有对象不受此表／视图规则影响。

## 安全取消（0.4.0）

```js
const controller = new AbortController();
const pending = runInWorker(
  { command: 'apply', db: 'app.db', dir: 'migrations' },
  { signal: controller.signal },
);
// 界面的“取消”操作可调用 controller.abort()。
const report = await pending;
if (!report.ok && report.kind === 'cancelled') console.log('本批未提交，连接已清理');
```

`run` 与 `runInWorker` 都接受 Node.js `AbortSignal`。提前取消不会创建数据库；等待队列、备份完成、宿主操作之间和执行 SQL 的授权检查点都会响应取消。未提交的整批数据、DDL 和历史会一起回滚，完成的持久备份与报告保留。取消返回 `kind: "cancelled"`、退出码 `4`。Worker 使用共享原子标记传递取消请求，返回前等待回滚和线程退出，不强杀线程。

取消是协作式的：正在执行的单条 SQLite 运算、写锁等待或在线备份可能需要先结束，才会到达可停止的位置。`busy_timeout_ms` 仍决定等待写锁的上限。若 COMMIT 已完成，迟到的取消保留成功结果；线程意外退出且没有最终报告仍是 `commit_outcome_unknown`，不会仅凭取消请求推断已回滚。同线程 `run` 会阻塞定时器和信号回调，界面或超时取消建议使用 `runInWorker`。

CLI 收到 SIGINT（通常是 Ctrl+C）或 SIGTERM 时请求同样的安全取消；长迁移使用 `--worker` 保持信号响应。收到取消后应等待报告，不要立即再强制终止进程。

## 迁移后的业务验收

SQLite 完整性检查不能发现“表结构正常，但订单金额被清零”。从本地开发版本 0.2.0 起，每项迁移可附带同名检查文件，例如 `000001_order_status.sql` 对应 `000001_order_status.checks.json`：

```json
{
  "checks": [
    {
      "name": "订单数量和金额保持完整",
      "sql": "SELECT COUNT(*)=2 AND SUM(amount_cents)=7599 FROM orders;"
    }
  ]
}
```

这些预期值来自订单示例；接入自己的应用时应写符合其业务规则的查询。每个检查仅允许单条只读 SQL，必须恰好返回一行、一列、整数 `1`。`0`、NULL、文本、浮点数、多行或多列均视为失败。查询可使用 JOIN、子查询和 CTE；不提供参数绑定，遗留的 `? / ?1 / :name / @name / $name` 会被拒绝，避免被 SQLite 当成 NULL 而错误通过。字符串、标识符与注释中的相同文字不受影响。禁止写入、事务控制、PRAGMA 配置及读取迁移历史。检查在对应迁移的 SQL 执行完后、历史插入前运行，演练和原库都执行；失败回滚整批迁移，报告指出迁移文件及检查名称。

SQL 和检查文件在准备阶段一次性读取；检查文件的原始字节参与迁移校验和。修改、增加或删除已执行迁移的检查文件都会阻止后续升级，应通过新的迁移补充规则。没有检查文件的旧迁移保持原有 SHA-256 校验和兼容。空检查列表、重复名称、未知字段及没有对应 SQL 的检查文件会在打开数据库前被拒绝。重复执行已经完成的升级仍是无操作，不重新验证历史检查；业务数据在应用日常运行中可能正常变化。

执行报告的 `result.checks`／`rehearsal.checks` 列出通过的检查；CLI 文本输出显示通过数量。示例目录附带可运行检查。[核心执行协议](docs/engine.md)说明自定义 MoonBit 宿主如何实现该操作。

## 保留真实数据的升级前后值（0.6.0）

已有应用通常不知道用户库的订单数量或总额。可以在**新迁移**的 `.checks.json` 中增加 `preserve`，不再把这些预期值写死：

```json
{
  "preserve": [
    { "name": "订单数量", "sql": "SELECT COUNT(*) FROM orders;" },
    { "name": "金额合计", "sql": "SELECT SUM(amount_cents) FROM orders;" }
  ],
  "checks": [
    { "name": "状态回填", "sql": "SELECT NOT EXISTS(SELECT 1 FROM orders WHERE status<>'paid');" }
  ]
}
```

每条 `preserve` 查询在对应脚本前后各执行一次，必须始终返回一行一列；结果和 SQLite 类型都相同才通过。64 位整数按精确十进制值比较，BLOB 按字节比较，NULL 可以作为待保留值，REAL 仅接受有限数值。TEXT 使用 Node 解码后的字符串比较；若需要核对原始 TEXT 字节，请在查询中 `CAST(column AS BLOB)`。单个 TEXT／BLOB 结果最多 1 MiB。查询使用与普通检查相同的只读、单语句、无参数限制。

演练和原库分别捕获自己的基线；失败返回 `policy`，真实执行失败时整批 SQL、结构及历史一起回滚。捕获值只在执行期间使用，报告及进度不包含这些值。`result.preserved`／`rehearsal.preserved` 只列出通过规则；进度事件 `capture_value` 的 `phase` 为 `before / after`。

两个数组可单独使用，也可同时使用；存在的数组必须非空，名称在同一文件内唯一。内存迁移集合通过原来的 `checks_json` 字符串使用相同格式。校验和算法未改变，既有 SQL-only 和 `checks`-only 历史继续兼容；不要为已执行脚本补写或修改 sidecar，应随下一条迁移加入规则。

查询必须在脚本前后均有效并且结果确定；避免时间、随机数或连接状态函数，集合聚合需要明确排序。数量和总额相同不能证明每一条记录都未变化，请按业务需要保留 ID、关键字段或有序集合。规则只约束它所属的那条迁移，不会自动约束后续脚本，也不会在无操作升级时重新运行。金额宜使用整数分，避免用浮点聚合代替精确比较。

运行 `npm run demo:preserve` 可重现“重建时遗漏订单被拒绝 → 修正待执行脚本 → 精确保留大整数金额 → 重复升级无操作”的完整流程，示例见 [examples/preservation.mjs](examples/preservation.mjs)。

## 只读验证数据库与备份（0.7.0）

`status` 检查版本、历史和结构漂移。需要在恢复备份前或应用维护时核查当前文件的外键、表与索引一致性，可以使用独立的 `verify`：

```sh
node node/cli.mjs verify --db backups/before.sqlite --dir migrations --worker --format json
```

```js
const report = await runInWorker({
  command: 'verify', db: 'backups/before.sqlite', migrations,
  expected_application_id: 1297042516,
  // expected_version: 3,
});
if (!report.ok) throw new Error(`${report.kind}: ${report.message}`);
console.log(report.verified, report.current_version, report.pending);
```

验证使用只读连接，在同一个读事务内检查应用标识、版本、历史文件校验和、结构漂移、`foreign_key_check` 与完整的 `integrity_check`。与迁移结束时的 `quick_check` 相比，完整检查还核对索引和表中记录的一致性；大库可使用 Worker 保持调用方响应。一次活动的 SQLite 检查仍可能延迟取消，`busy_timeout_ms` 只控制锁等待。

文件与内存迁移集合都支持。需要提供该数据库完整的已执行迁移前缀；未受 MoonMolt 管理的数据库可在库接口中显式传 `migrations: []`。验证不会运行待迁移 SQL、历史 `checks / preserve`，也不会执行修复、创建数据库、生成新备份或报告文件；`to / rebuild / create / backup_dir` 不适用。恢复前备份通常仍有待升级版本，`pending` 非空不表示备份损坏。成功报告包含 `verified: true`、`database_modified: false` 和 `validation` 两项检查结果。

每项 SQLite 检查的错误最多展示 20 条，存在更多问题时明确标记省略；迁移执行中的错误报告也采用相同限制。`verify` 表示所读快照在这些结构与历史检查下通过，不证明业务内容正确、待迁移 SQL 正确，或选中的文件就是期望的用户数据。恢复操作仍按 [恢复说明](docs/restore.md)停机完成。`npm run demo:preserve` 同时演示升级后核验原库与升级前备份。

## 核验当前业务数据（0.9.0）

恢复备份或排查应用数据时，可以给 `verify` 提供**这次核验的业务规则**。例如 SQLite 结构与历史都正常，但订单金额后来被误写成零：

```js
const report = await runInWorker({
  command: 'verify', db: 'app.db', migrations,
  verify_checks: [
    { name: '订单金额仍为正数', sql: 'SELECT NOT EXISTS(SELECT 1 FROM main.orders WHERE amount_cents<=0);' },
  ],
});
if (!report.ok) throw new Error(report.message);
console.log(report.checks); // 仅包含规则名称和 ok，不包含业务值
```

CLI 使用独立 JSON 文件，例如 `application-health.json`：

```json
{"checks":[{"name":"订单金额仍为正数","sql":"SELECT NOT EXISTS(SELECT 1 FROM main.orders WHERE amount_cents<=0);"}]}
```

```sh
node node/cli.mjs verify --db app.db --dir migrations --checks-file application-health.json --worker
```

工具先核对历史和可选前置条件，再运行完整性／外键检查，最后在**同一个只读事务快照**中依次执行这些规则。规则只接受单条只读查询、无未绑定参数、一行一列且结果为整数 `1`；失败返回 `policy`／退出码 `2`，不修改数据、不执行待迁移 SQL、不创建备份。可与应用标识、版本和结构指纹条件组合。省略时仍只核验 SQLite 和历史，成功报告的 `checks` 为空数组。

规则数组在库调用时复制，之后修改输入不会改变本次核验。仅 `verify` 接受 `verify_checks`／`--checks-file`；显式提供时必须非空且名称唯一，文件仅接受 `checks` 字段。它不属于迁移历史，不影响已有 SQL／sidecar 校验和，也不会自动读取历史迁移检查。针对升级前备份应提供适合旧结构的规则；应用正常变化后的数据应使用符合当前业务的条件。规则的覆盖范围由应用作者决定；上例允许空表，如需保证订单存在，应再检查数量。参见可运行的 [保留与恢复核验示例](examples/preservation.mjs)。

迁移 DDL 现在还会检查重命名后的对象，禁止业务表借 `ALTER TABLE ... RENAME` 进入保留的 `__moonmigrate_` 命名空间；这类名称原本就不能被迁移脚本正常访问。该检查覆盖主库和临时库，失败回滚整批升级。

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

1. 读取一次迁移文件或捕获内存迁移集合，验证版本与校验和。
2. 获取 `BEGIN IMMEDIATE` 写锁，在事务内核对应用标识、预期版本、历史与结构指纹。
3. 在任何修改前，通过第二个只读连接备份，再从备份复制演练数据库。
4. 在副本上完整执行迁移，检查外键与数据库完整性。
5. 在原库执行同一批 SQL，将历史记录写入同一事务，核对最终结构后提交。

发生错误时，本批事务回滚；之前已经成功提交的批次保留。失败记录写入外部报告，不在失败事务中留下历史。工具提供向前升级和升级前备份，不提供自动降级。

请在应用启动或维护窗口执行，暂停应用写入。默认外键检查开启；`--rebuild` 会在事务外关闭本批外键约束，并在提交前检查所有引用。该模式下级联更新／删除不会自动发生，脚本需要明确维护相关数据。重建表请按“创建新表 → 明确列映射复制 → 删除旧表 → 重命名 → 恢复索引、触发器和视图”的顺序操作。

脚本不能自行控制事务、保存点、附加数据库、修改迁移历史或修改 PRAGMA 配置。允许无参数的只读外键检查，以支持生成 SQL 的检查步骤。语句边界由 SQLite 自己解析，再逐条执行；字符串中的分号和触发器 `BEGIN / END` 不会被错误切分。每条语句编译后检查未绑定参数，禁止把遗留的 `? / :name / @name / $name` 悄悄当成 NULL 写入数据库；字符串和标识符中的相同文字不受影响。已经执行的历史脚本不会重新运行。

备份位于 `<数据库路径>.moonmolt-backups/`，每次使用唯一文件名，旁边保存 JSON 执行报告；恢复步骤见 [备份恢复说明](docs/restore.md)。演练不会验证全部业务逻辑，也不能预先保证磁盘或进程在后续不会出错。若返回 `commit_outcome_unknown`，先检查历史，禁止盲目重放。

从 0.9.1 起，备份文件在 SQLite 写入和进度通知前以独占方式创建；遇到同名文件直接失败，不覆盖，也不会把已有文件标记为本次的 `incomplete_backup`。新备份、临时快照和 JSON 报告按 POSIX `0600` 创建，新备份目录按 `0700` 创建（受 umask 约束）；已有目录的权限由部署方管理。Windows 权限继承目标目录 ACL，应将 `backup_dir` 指向适合应用私有数据的目录。报告写入失败通过 `report_warning` 单独返回；迁移已经提交时仍保留成功结果和有效备份，不能因此自动重放。`incomplete_backup` 仅表示本次创建但未完成的文件，不能用于恢复。

重建带 `AUTOINCREMENT` 的表时，复制存量行并不能保留已经删除记录的 ID 上限。引擎会在每个脚本结束后检查同名表的 `sqlite_sequence`，发现上限降低或丢失即阻止升级。脚本应显式保留旧上限，并在插入新记录前恢复；更换表名时需按新名称恢复，引擎无法从任意 SQL 推断表的身份。自动模型不支持 AUTOINCREMENT，请使用人工 SQL。历史表的非标准结构、额外索引或触发器也会被拒绝。

## 验证与打包

从 0.9.2 起，Node 适配器会在演练与原库整批提交前，以及只读 `verify` 中检查持久视图和触发器定义。SQLite 创建定义时可能尚未解析正文；错误触发器可以等到应用日后写入才删除迁移历史，损坏视图也可能在升级时未被使用。工具会编译视图查询和触发器目标的插入／删除／更新路径，由授权回调阻止访问保留元数据，并拒绝未解析的最终定义；不执行这些测试写入，也不解析 EXPLAIN 的输出。

检查包含可写列、可用 ROWID 别名，兼容生成列、`WITHOUT ROWID` 和 `INSTEAD OF` 可写视图。允许前一脚本创建定义、后一脚本补齐依赖，但整批结束时需通过检查。SQLite 允许 `UPDATE OF` 指向尚不存在的列；该事件当前不能触发，后续通过 MoonMolt 增加列时会重新检查。它不是任意触发器业务行为的证明，业务数据仍需检查规则。已有损坏定义可用审阅过的新迁移修复，不能改写已执行脚本。`status` 和无操作 `apply` 仍只核对元数据；升级本工具后可主动运行 `verify` 核验旧库。可运行的笔记示例演示了拒绝延迟破坏历史的触发器。

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
