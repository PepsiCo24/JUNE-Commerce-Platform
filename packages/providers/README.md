# @june/providers

AI 模型供应商适配层。把 5 家生图供应商 + 2 种文本协议的差异,收敛成 `packages/shared` 里已定义的统一契约(`ModelLimits` / `ErrorCode`),对上层 Worker 暴露同一组接口。

**这个包只负责「一次上游调用」**。批量出图的拆分不在这里做:适配器如实声明 `limits.maxOutputsPerCall`,由上层用 `countUpstreamCalls(requestedCount, limits)` 决定调几次。适配器内部不循环、不重试、不落库、不转存图片。

核对日期:**2026-09-16**。所有官方文档 URL 与「哪些字段是文档明确的、哪些是推断的」都写在各适配器文件头部的注释里,改动前请先读那段注释。

## 供应商能力矩阵

| 供应商 (ProviderKind) | 能力 | 端点形态 | 同步/异步 | 单次最大出图 | 参考图 / 图生图 | 认证头 | 结果载体(有效期) | verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `OPENAI` | 文生图 + 图像编辑 | `POST /images/generations`(JSON)、`POST /images/edits`(multipart) | 同步 | **10**(`dall-e-3` 为 1) | `images/edits` 的 `image` 字段,最多 **16** 个文件,单张 < 50MB | `Authorization: Bearer` | GPT image 系列恒为 base64;DALL·E 可选 url(60 分钟) | ✅ [docs](https://platform.openai.com/docs/api-reference/images) |
| `GEMINI` | 文生图 + 图像编辑 | `POST /v1beta/interactions`(不是 `/images`) | 同步 | **1**(请求体无 `n`,且官方明说不保证出图数量) | `input` 数组里的 `{ type:'image', mime_type, data }`,base64 无 data URI 前缀;最多 **14** 张(2.5-flash-image 为 3) | `x-goog-api-key` | base64 | ❌ [docs](https://ai.google.dev/gemini-api/docs/image-generation) |
| `ARK_SEEDREAM` | 文生图 + 图生图 + 组图 | `POST /api/v3/images/generations`(国内域名 `ark.cn-beijing.volces.com`) | 同步 | **1**(默认)/ **15**(开 `sequential_image_generation: 'auto'` 的组图模式,且参考图+出图 ≤ 15;5.0 pro 不支持组图) | `image` 字段,URL 或 `data:image/<fmt>;base64,` 形式;5.0 pro 最多 **10** 张,lite/4.5/4.0 最多 **14** 张,单张 ≤ 30MB | `Authorization: Bearer` | url(**24 小时**)或 b64_json | ⚠️ 见下 [docs](https://www.volcengine.com/docs/82379/1541523) |
| `ALIYUN_WANX` | 纯文生图 | `POST /services/aigc/text2image/image-synthesis` + `GET /tasks/{task_id}` | **异步(提交 + 轮询)**,提交必带 `X-DashScope-Async: enable` | **4**(`n` 取 1~4,上游默认 4) | 不支持(本端点是纯文生图,图像编辑是另一组端点,未核对) | `Authorization: Bearer` | url(**24 小时**;task_id 同样 24 小时有效) | ✅ [docs](https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference) |
| `BFL_FLUX` | 文生图 + 图像编辑 | `POST /v1/{model}` 返回 `polling_url` + `GET {polling_url}` | **异步(提交 + 轮询)**,必须用响应返回的 `polling_url` | **1**(请求体无 `n`) | `input_image` ~ `input_image_8`,base64 或 URL,最多 **8** 张 | `x-key`(不是 Bearer) | url(签名链接**仅 10 分钟**,且不开 CORS,必须转存) | ❌ [docs](https://docs.bfl.ai/quick_start/generating_images) |
| `MOCK` | 文生图(模拟) | 无网络请求,本地合成 PNG | 可配同步 / 异步 | 4 | 忽略传入的参考图 | 无 | base64 | ❌(**永远是 false,它不是真实供应商**) |

文本(结构化输出):

| 供应商 (ProviderKind) | 端点 | 结构化输出机制 | 输出上限字段 | verified |
| --- | --- | --- | --- | --- |
| `OPENAI` | `POST /chat/completions` | `response_format: { type:'json_schema', json_schema:{ name, schema, strict } }` | `max_completion_tokens`(`max_tokens` 已弃用) | ✅ [docs](https://platform.openai.com/docs/guides/structured-outputs) |
| `OPENAI_COMPATIBLE` | 同上,`baseUrl` 由后台配置 | 同上;第三方网关对 `json_schema` 支持程度参差不齐,部分只支持 `json_object` | 同上 | ❌(每接一个网关都要单独验证) |
| `GEMINI` | `POST /v1beta/interactions` | `response_format: { type:'text', mime_type:'application/json', schema }`(对应旧协议的 `responseMimeType` + `responseSchema`) | `generation_config.max_output_tokens`(**推断**) | ❌ [docs](https://ai.google.dev/gemini-api/docs/structured-output) |

`ARK_SEEDREAM` / `ALIYUN_WANX` / `BFL_FLUX` / `MOCK` 调 `getTextProvider()` 会抛 `ProviderNotImplementedError`(错误码 `MODEL_CAPABILITY_MISMATCH`),`OPENAI_COMPATIBLE` 调 `getImageProvider()` 同样抛错。**不做静默降级** —— 悄悄回退到别家会导致「用户以为在用 A、账单出现在 B」,且排查时毫无线索。

两个文本适配器都只返回 `raw`(原始字符串)+ `parsed`(`JSON.parse` 结果),**不做业务结构校验**。是否符合 `copyResultPayloadSchema` 由上层用 zod 判定,不合规走 `CONTENT_STRUCTURE_INVALID`。

## 「待真实联调」清单

下面每一项都在对应源文件里有 `// 待真实联调:` 注释。凡是涉及模型可用性的,联调确认前不应对用户开放。

### 阻塞级(不确认就不能上线该模型)

| # | 供应商 | 待确认内容 | 位置 |
| --- | --- | --- | --- |
| 1 | `ARK_SEEDREAM` | **Seedream 4.0 的完整 Model ID**。官方文档正文只出现了 `doubao-seedream-5-0-pro-260628` 一个可核对的完整 ID(cURL 示例),4.0 / 4.5 / 5.0 lite 的带日期后缀 ID 必须去方舟控制台「查询 Model ID」确认。当前 `doubao-seedream-4-0` 是占位值。 | `src/image/ark-seedream.ts` |
| 2 | `GEMINI`(图 + 文) | **响应 JSON 的确切字段名**。官方文档只给了请求侧 REST 示例,响应侧只以 SDK 属性出现(`interaction.output_image.data`、`interaction.output_text`),没有原始 JSON 报文。解析器已做三路兼容(`output_image` / `steps[].content[]` / `candidates[].content.parts[]`),首次联调必须打一次真实响应,确认后收敛成单路。 | `src/image/gemini.ts`、`src/text/gemini-text.ts` |
| 3 | `BFL_FLUX` | **`width` / `height` 的上限与步长**。OpenAPI 只声明 `minimum: 64`、`default: 0`,没有最大值也没有「须为 N 的倍数」。当前按文档正文「FLUX.2 最高 4MP 输出」保守取 2048×2048、`dimensionStep: 32`,均为推断值。 | `src/image/bfl-flux.ts` |
| 4 | `GEMINI`(文) | **`maxOutputTokens` 与 system 提示词的字段名**。旧 `generateContent` 协议叫 `generationConfig.maxOutputTokens` / `systemInstruction`;Interactions 概览把 `system_instruction` 列为 interaction 作用域参数但没给 REST 示例。当前按 snake_case 传,属推断。 | `src/text/gemini-text.ts` |

### 非阻塞(影响体验或成本核算,不影响能否调通)

| # | 供应商 | 待确认内容 |
| --- | --- | --- |
| 5 | `GEMINI` | 参考图单张字节上限、图像 prompt 字符上限,文档均未给数值 → `maxReferenceBytes` / `maxPromptChars` 保持 0(沿用平台默认)。 |
| 6 | `ARK_SEEDREAM` | prompt 长度文档给的是**建议值**(中文 ≤ 300 字 / 英文 ≤ 600 词)而非硬上限 → `maxPromptChars` 保持 0,不冒充硬限制。 |
| 7 | `ARK_SEEDREAM` | 错误码枚举在单独的「错误码」页,本次未逐条核对 → 不按 `code` 细分映射,统一按 HTTP 状态码分类。 |
| 8 | `BFL_FLUX` | `input_image` 的 20MB / 20MP 上限来自 FLUX.1 Kontext 参数表,FLUX.2 的 OpenAPI 未重申。 |
| 9 | `BFL_FLUX` | `result.sample` 的 MIME 类型不在响应体里,按请求的 `output_format` 推断。 |
| 10 | `ALIYUN_WANX` | `task_status: UNKNOWN` 的确切触发条件(文档只说「任务不存在或状态未知」)→ 一律映射为 `UPSTREAM_RESULT_UNKNOWN` 且不可重试,交人工核对。 |
| 11 | `ALIYUN_WANX` | 图像编辑 / 图生图是另一组端点,未核对 → 本适配器 `maxReferenceImages = 0`。**`wan2.6` 系列走 messages 新协议,不能复用本适配器**,需另写一个。 |
| 12 | `OPENAI` | 参考图单张 50MB 只出现在文档描述文本里,未在 schema 中以数值约束 → 平台侧仍以自身 `FILE_TOO_LARGE` 阈值为准。 |
| 13 | 全部 5 家 | **429 是否返回标准 `Retry-After`** 只有 OpenAI 明确。其余 4 家文档未说明,已交由通用 `classifyHttpFailure` 解析,解析不到则由上层退避。 |
| 14 | `GEMINI` / `ARK_SEEDREAM` / `BFL_FLUX` / `ALIYUN_WANX` | 错误响应体结构:除 OpenAI 与万相外,其余按各家常见形态解析,解析不到回退到脱敏后的原始文本。 |

## 失败语义:可重试 vs 结果未知

这是整个包最需要小心的部分 —— **分类错了要么让用户白等,要么重复计费**。判定集中在 `src/http.ts`,测试在 `src/failure-classification.test.ts`。

| 情形 | errorCode | retryable | 理由 |
| --- | --- | --- | --- |
| 提交阶段超时 / 连接中断 / 被取消 | `UPSTREAM_RESULT_UNKNOWN` | **false** | 请求可能已到达上游并开始计费,只是响应没回来。盲目重试 = 二次付费。 |
| 提交阶段 5xx 且**无**结构化错误体(网关 502/503/504、空 body 500) | `UPSTREAM_RESULT_UNKNOWN` | **false** | 无法判断上游是否已执行。 |
| 提交阶段 5xx 且**有**结构化错误体 | `UPSTREAM_ERROR` | true | 请求被上游业务逻辑明确拒绝,通常没产出也不计费。 |
| 轮询阶段任何超时 / 5xx | `UPSTREAM_TIMEOUT` / `UPSTREAM_ERROR` | true | 轮询是幂等只读查询,重试无副作用。 |
| 429 | `UPSTREAM_RATE_LIMITED` | true | 解析 `Retry-After`,支持 delta-seconds 与 HTTP-date 两种形式(RFC 9110)。 |
| 408 | `UPSTREAM_TIMEOUT` | true | 上游自报超时。 |
| 400 / 401 / 402 / 403 / 404 / 422 | `UPSTREAM_ERROR` | **false** | 凭据、余额或参数问题,重试无意义。 |
| 2xx 但响应体不符合文档 | `UPSTREAM_ERROR` | false | `malformedResponse()`,需要人工看是不是上游改了协议。 |
| 万相 `task_status: UNKNOWN` | `UPSTREAM_RESULT_UNKNOWN` | false | 同上,交人工核对。 |

所有 `UPSTREAM_RESULT_UNKNOWN` 都会尽力带上 `providerTaskId`,方便去供应商控制台核账。

## 脱敏

`sanitizeUpstreamMessage()`(`src/sanitize.ts`)是**所有**上游文案进入 message / 日志前的唯一出口。会抹掉:

- `sk-` / `sess-` / `AIza` 前缀的 key、JWT;
- `Authorization` / `x-key` / `x-goog-api-key` / `x-dashscope-api-key` / `api-key` 的值(裸文本与 JSON 两种回显形态);
- `data:image/*;base64,...` 与长度 ≥ 200 的裸 base64 块(上游 400/422 常把请求体原样回显,里面有参考图);
- 带签名的临时链接的整个 query(保留 host + path 便于排查)。

最后折叠空白并截断到 400 字符,避免把整个请求体写进日志行。

## HTTP 约定

- 统一走 `undici` 的 `request`,入口是 `src/http.ts` 的 `httpCall()`,适配器不自己发请求。
- 默认超时 **120s**(`DEFAULT_TIMEOUT_MS`),可按调用覆盖 `options.timeoutMs`;同时叠加 `headersTimeout` / `bodyTimeout`,防止响应体挂住不返回。
- 同时尊重上层的 `options.signal`(用户取消任务 / Worker 优雅退出),内部用 `AbortSignal.any([timeout, caller])` 合并。
- `httpCall()` **不抛异常**:传输层错误以 `{ ok: false, transport }` 返回,由调用方结合 `CallPhase`(`submit` / `poll`)决定语义。

## 模拟供应商

`MOCK` 仅用于容量压测与本地开发,可配 `delayMs` / `jitterMs` / `failureRate` / `unknownRate` / `rateLimitRate`(见 `createMockImageProvider()`)。防止误当真实服务的措施:`displayName` 一律 `[MOCK]` 前缀、`modelKey` 一律 `mock-` 前缀、`limits.verified` 恒为 false、`docsUrl` 指向源文件、生成的 PNG 上画着大写 "MOCK"、**不发起任何网络请求**(即使误配了真实 `baseUrl` 也打不出去)。

## 本地校验

```bash
pnpm --filter @june/providers typecheck
pnpm --filter @june/providers test
```

测试(103 个)全部是纯函数测试,**不发真实网络请求**:

- `src/request-builders.test.ts` —— 每家的请求体构造(含 Gemini `image_size` 必须大写 K、万相 `size` 用 `*` 分隔、Ark `watermark` 显式传 false、FLUX `input_image_N` 命名、万相永远显式传 `n`)。
- `src/response-parsers.test.ts` —— 每家的响应解析,样本取自官方文档;含组图部分失败、内容审核拦截、结构不符等分支。
- `src/failure-classification.test.ts` —— 失败分类(429 / 结果未知 / 4xx / 5xx 细分)、脱敏、注册表行为、模拟供应商的注入失败。
