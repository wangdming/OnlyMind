# 选模型功能

## 问题
手机端目前无法选择引擎用哪个模型。API 引擎的模型只能靠环境变量(`OPENAI_MODEL`/`ANTHROPIC_MODEL`),CLI 引擎(claude/codex)完全用 CLI 自带默认。需要在手机上为每个引擎选模型。

## 作用范围(已确认)
**按引擎粘性默认 + 每任务**:每个引擎记住上次所选模型作为默认;发任务时可临时改,并存到该任务(历史可见、重跑一致)。不绑定会话。

## 背景(现状)
- `config.js`:`openaiModel='gpt-4o'`、`anthropicModel='claude-sonnet-4-6'`(仅 env 可改)。
- `index.js` 组装 `models={openai,anthropic,anthropicMaxTokens}` 传 runner/server。
- `providers.js complete()` anthropic 请求体仅 `{model,max_tokens,messages,system,stream}` —— 无 temperature/budget_tokens/thinking,**换模型 ID 不会 400**。
- CLI 无模型参数;claude 支持 `--model <x>`(别名 opus/sonnet/haiku 或全 ID),codex 支持 `-m <x>`。model slug 均 ASCII,Windows 安全。
- `/api/engines` = `engineList(keySet)`;前端仅引擎下拉。

## 模型目录(内置 + 自定义自由输入)
- **claude**:默认('') / opus / sonnet / haiku。默认不传 `--model`。
- **codex**:默认('')。默认不传 `-m`。
- **openai**:gpt-4o / gpt-4o-mini / o3。默认 gpt-4o。
- **anthropic**:claude-opus-4-8(最强·推荐) / claude-sonnet-4-6(均衡·现默认) / claude-haiku-4-5(快省) / claude-opus-4-7 / claude-fable-5(需30天数据留存、可能安全拒答)。默认保持 sonnet-4-6。
- 每个都带「自定义」自由输入。

## 实现方案
### DB(`src/db.js`)
- `tasks` 加列 `model TEXT`(null=引擎默认)。按引擎默认存 `settings['model_<engine>']`(复用 getSetting/setSetting)。

### engines.js
- 每个 ENGINE 增 `models:[{id,label}]` 静态目录 + `allowCustom:true`;`engineList` 带出。
- claude/codex 的 `build(task,opts)`:`task.model` 非空时,claude 追加 `--model <model>`、codex 在 `exec`/`exec resume <id>` 后插 `-m <model>`。

### server.js
- `/api/engines`:每引擎补 `selected = getSetting('model_'+id) ?? 默认`(API 默认=注入的 models[provider];CLI 默认='')。
- 新增 `POST /api/engines/:engine/model` {model} → setSetting('model_'+engine, model||'')。
- `POST /api/tasks`:`effModel = (body 有 model ? body.model : getSetting) → trim 空则 null`,存 `tasks.model`。
- rerun 复制 `model`;compress 用引擎所选模型。
- buildServer 导入 getSetting/setSetting。

### runner.js
- API 分支:`model = task.model || models[provider]`。
- CLI 模型参数在 engines.build 内处理(见上)。

### 前端(index.html/app.js)
- 引擎下拉旁加「模型」下拉 + 「自定义」文本框(选自定义时显示)。
- loadEngines/engine change 时 `renderModelOptions()`:按引擎 models 重填、选中 selected;不在列表内的 selected → 选「自定义」并填入。
- 改动即存(POST model 端点);提交任务带 `model`。

## 测试
- 单元:/api/engines 含 models+selected;保存端点改 selected;任务落库解析 model(body/设置/默认);CLI build 选模型含 `--model`/`-m`、默认不含;API complete 收到 task.model;rerun 保留 model;ASCII 参数测试仍过。
- 冒烟:claude 选 sonnet、codex 选一个模型各跑通;anthropic 若有 key 切 opus-4-8 跑通。

## 子任务
- [x] 1. DB:`tasks.model` 列 + insertTask 存 model。
- [x] 2. engines.js:`ENGINE_MODELS` 目录 + engineList 带出(models/allowCustom);claude/codex build 加 `--model`/`-m`。
- [x] 3. server.js:`/api/engines` 补 selected、`POST /api/engines/:engine/model` 保存、任务解析/存 model、rerun 复制、compress 用所选模型。
- [x] 4. runner.js:API 分支 `model = task.model || models[provider]`。
- [x] 5. 前端:模型下拉 + 自定义框 + 改动即存 + 提交带 model。
- [x] 6. 单测(+3)+ 冒烟;文档收尾。

## 进度日志
- 2026-10-10:方案定稿(范围=按引擎粘性+每任务)。
- 2026-10-10(实现):1–6 全部落地。
  - 单测:新增 CLI build 模型参数、`/api/engines` models+selected 与保存端点、任务 model 解析(body/空/继承)+rerun 保留。**共 63 项全绿**;ASCII 参数测试仍过(模型 slug 均 ASCII)。
  - 冒烟:claude `--model` 实测被采纳(haiku→claude-haiku-4-5、sonnet→claude-sonnet-4-6),且经真实 runner 跑通;codex `-m` 在我们的参数位被接受(header 显示 model)。anthropic API 未跑(需带额度的 key)——调用体 `{model,max_tokens,messages,system,stream}` 已确认与 opus-4-8/sonnet/haiku/fable 兼容,不会 400。痕迹已清理。
- **收尾完成**。改动文件:`src/db.js`、`src/engines.js`、`src/server.js`、`src/runner.js`、`public/index.html`、`public/app.js`、`test/api.test.js`。
- 说明:anthropic 默认仍为 `claude-sonnet-4-6`(未擅自改成 opus-4-8,避免意外成本变化;opus-4-8 在清单标「最强·推荐」,用户可自选)。
