# apps/web 前端协作契约

本文件是 `apps/web` 内部的**接口契约**,由多个并行开发的模块共同遵守。
契约一旦写在这里,各模块可以直接按签名调用,不需要相互等待。

## 0. 目录归属(避免并行开发时互相覆盖)

| 目录 | 归属 | 内容 |
|---|---|---|
| `src/app/globals.css` | 已完成 | 设计系统令牌、语义变量、基础样式 |
| `src/lib/**` | 已完成 | `cn`/格式化工具、API 客户端、错误类型、服务端取数 |
| `src/providers/**` | 已完成 | Auth / Query / SSE / Preferences |
| `src/components/ui/**` | UI 基础库 | 无业务语义的通用组件 |
| `src/components/feedback/**` | UI 基础库 | 加载 / 空 / 错误 / 保存状态 / 上传进度 / 确认框 |
| `src/components/media/**` | UI 基础库 | 图片(懒加载、占位、响应式) |
| `src/components/layout/**` | 登录与首页模块 | 顶栏、用户菜单、页脚、移动端折叠导航 |
| `src/components/system/**` | 已完成 | SessionWatcher 等全局副作用组件 |
| `src/features/auth/**` | 登录与首页模块 | 登录/注册/资料表单与 hooks |
| `src/features/community/**` | 社区模块 | 社区的组件与 hooks |
| `src/features/workbench/**` | 工作台模块 | 工作台的组件与 hooks |
| `src/features/admin/**` | 管理站模块 | 管理站的组件与 hooks |

**规则:只写自己归属目录下的文件。** 需要通用组件但 UI 基础库没提供时,写在自己 `features/` 目录里,不要往 `components/ui` 里加。

## 1. 设计系统用法

只使用语义化的 Tailwind 工具类,不写具体色值:

| 类名 | 含义 |
|---|---|
| `bg-bg` / `bg-bg-elevated` | 页面底色 / 浮起层底色 |
| `bg-surface` / `hover:bg-surface-hover` | 卡片、面板表面 |
| `border-border-default` / `border-border-strong` | 边框 |
| `text-fg` / `text-fg-muted` / `text-fg-subtle` | 主文字 / 次要 / 更弱 |
| `bg-accent` `text-accent` `text-accent-fg` `bg-accent-surface` `border-accent-border` | 品牌青绿强调色 |
| `text-purple-accent` | 辅助紫,仅小面积点缀 |
| `text-state-danger-fg` `bg-state-danger-bg` `border-state-danger-border` | 危险态(success/warning/info 同构) |
| `june-glass` | 半透明材质卡片 |
| `june-glow` | 背景光晕(需配 `absolute` 定位与尺寸) |
| `june-texture` | 细腻点阵纹理 |
| `june-skeleton` | 骨架屏底纹 |
| `june-prose` | 富文本正文排版 |
| `tabular` | 等宽数字(表格、统计) |

**主题**:深色场景容器加 `data-theme="dark"`,浅色场景加 `data-theme="light"`。语义变量会自动切换,同一组件两处复用。

- 深色:登录页、双入口首页、工作台
- 浅色:社区、`/admin`

**浅色背景上的小字号青绿文字必须用 `text-accent`**(它在浅色主题下解析为 `#0C7E72`,对比度 4.95:1),绝不能直接用 `text-teal-400`(1.6:1)。

**动效**:只动 `opacity` 与 `transform`。用 `motion/react` 时先取 `useReducedMotion()`(来自 `@/providers/preferences-provider`),为 true 时把动画时长设为 0 或直接渲染终态。

## 2. UI 基础库 API 契约

以下签名是各模块共同依赖的,**不得改动**。

### `src/components/ui/button.tsx`
```ts
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'link';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** true 时显示内联 spinner 并自动 disabled */
  loading?: boolean;
  /** 左右图标(lucide-react 组件元素) */
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  /** 用 Radix Slot 渲染为子元素(用于包 <Link>) */
  asChild?: boolean;
  fullWidth?: boolean;
}
export function Button(props: ButtonProps): React.JSX.Element;
```

### `src/components/ui/input.tsx`
```ts
export function Input(props: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }): React.JSX.Element;
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; autoGrow?: boolean }): React.JSX.Element;
export function Label(props: { htmlFor?: string; required?: boolean; children: React.ReactNode; className?: string }): React.JSX.Element;
/** 表单字段容器:标签 + 控件 + 描述 + 错误。error 存在时自动给控件加 aria-invalid */
export function Field(props: {
  label?: React.ReactNode; htmlFor?: string; required?: boolean;
  description?: React.ReactNode; error?: string | null;
  /** 右上角额外内容,如字数统计 */ addon?: React.ReactNode;
  className?: string; children: React.ReactNode;
}): React.JSX.Element;
/** 带上限提示的字数统计,超限显示危险色 */
export function CharCounter(props: { value: string; max: number }): React.JSX.Element;
```

### `src/components/ui/card.tsx`
```ts
export function Card(props: React.HTMLAttributes<HTMLDivElement> & { glass?: boolean; interactive?: boolean }): React.JSX.Element;
export function CardHeader(props: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element;
export function CardTitle(props: React.HTMLAttributes<HTMLHeadingElement> & { as?: 'h1'|'h2'|'h3'|'h4' }): React.JSX.Element;
export function CardDescription(props: React.HTMLAttributes<HTMLParagraphElement>): React.JSX.Element;
export function CardContent(props: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element;
export function CardFooter(props: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element;
```

### `src/components/ui/badge.tsx`
```ts
type BadgeTone = 'neutral' | 'accent' | 'purple' | 'success' | 'warning' | 'danger' | 'info';
export function Badge(props: { tone?: BadgeTone; size?: 'sm'|'md'; icon?: React.ReactNode; className?: string; children: React.ReactNode }): React.JSX.Element;
/** 任务/帖子/商品状态徽标:内部把状态枚举映射到 tone 与中文文案 */
export function StatusBadge(props: { status: string; className?: string }): React.JSX.Element;
```
`StatusBadge` 需覆盖:`DRAFT PUBLISHED HIDDEN DELETED ACTIVE DISABLED PAUSED CLOSED OFF_SHELF ARCHIVED QUEUED RUNNING PARTIAL SUCCEEDED FAILED CANCELED TIMEOUT UNKNOWN PENDING VALIDATING VISIBLE ORPHAN RECYCLED PURGED`。

### `src/components/ui/dialog.tsx`
```ts
export function Dialog(props: {
  open: boolean; onOpenChange: (open: boolean) => void;
  title: React.ReactNode; description?: React.ReactNode;
  /** 底部操作区 */ footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  children?: React.ReactNode;
  /** 深色场景弹窗 */ theme?: 'dark' | 'light';
}): React.JSX.Element;
```

### `src/components/ui/sheet.tsx`
移动端抽屉(用于折叠导航)。
```ts
export function Sheet(props: {
  open: boolean; onOpenChange: (open: boolean) => void;
  side?: 'left' | 'right' | 'bottom'; title: React.ReactNode;
  children: React.ReactNode; theme?: 'dark' | 'light';
}): React.JSX.Element;
```

### `src/components/ui/dropdown-menu.tsx`
```ts
export function DropdownMenu(props: {
  trigger: React.ReactNode;
  items: Array<
    | { type: 'item'; label: React.ReactNode; icon?: React.ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean }
    | { type: 'separator' }
    | { type: 'label'; label: React.ReactNode }
  >;
  align?: 'start' | 'center' | 'end';
  theme?: 'dark' | 'light';
}): React.JSX.Element;
```

### `src/components/ui/select.tsx`
```ts
export interface SelectOption { value: string; label: React.ReactNode; description?: React.ReactNode; disabled?: boolean }
export function Select(props: {
  value: string | null; onChange: (value: string) => void;
  options: SelectOption[]; placeholder?: string;
  disabled?: boolean; invalid?: boolean; id?: string; className?: string;
  'aria-label'?: string;
}): React.JSX.Element;
```

### `src/components/ui/tabs.tsx`
```ts
export function Tabs(props: {
  value: string; onChange: (value: string) => void;
  items: Array<{ value: string; label: React.ReactNode; count?: number; disabled?: boolean }>;
  className?: string;
}): React.JSX.Element;
```

### `src/components/ui/toggle.tsx`
```ts
export function Switch(props: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; id?: string; 'aria-label'?: string }): React.JSX.Element;
export function Checkbox(props: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; id?: string; label?: React.ReactNode }): React.JSX.Element;
export function RadioGroup<T extends string>(props: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: React.ReactNode; description?: React.ReactNode; disabled?: boolean }>; name: string; orientation?: 'horizontal'|'vertical' }): React.JSX.Element;
```

### `src/components/ui/tooltip.tsx`
```ts
export function Tooltip(props: { content: React.ReactNode; children: React.ReactNode; side?: 'top'|'right'|'bottom'|'left' }): React.JSX.Element;
/** 统计口径说明用的问号图标 + 悬浮说明 */
export function InfoHint(props: { children: React.ReactNode; className?: string }): React.JSX.Element;
```

### `src/components/ui/avatar.tsx`
```ts
export function Avatar(props: { src?: string | null; name: string; size?: number; className?: string }): React.JSX.Element;
```
无头像时用 `avatarFallbackColor(name)` + `initialsOf(name)`(来自 `@/lib/utils`)。

### `src/components/ui/progress.tsx`
```ts
/** value 为 null 时渲染"不确定进度"的条纹动画,绝不显示编造的百分比 */
export function Progress(props: { value: number | null; className?: string; 'aria-label'?: string }): React.JSX.Element;
export function Spinner(props: { size?: number; className?: string }): React.JSX.Element;
```

### `src/components/ui/skeleton.tsx`
```ts
export function Skeleton(props: { className?: string }): React.JSX.Element;
export function SkeletonText(props: { lines?: number; className?: string }): React.JSX.Element;
export function SkeletonCard(props: { className?: string }): React.JSX.Element;
```

### `src/components/ui/separator.tsx` / `scroll-area.tsx` / `slider.tsx` / `popover.tsx`
```ts
export function Separator(props: { orientation?: 'horizontal'|'vertical'; className?: string }): React.JSX.Element;
export function ScrollArea(props: { className?: string; children: React.ReactNode }): React.JSX.Element;
export function Slider(props: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number; disabled?: boolean; id?: string; 'aria-label'?: string }): React.JSX.Element;
export function Popover(props: { trigger: React.ReactNode; children: React.ReactNode; align?: 'start'|'center'|'end'; theme?: 'dark'|'light' }): React.JSX.Element;
```

### `src/components/ui/table.tsx`
```ts
export interface Column<T> {
  key: string; header: React.ReactNode;
  render: (row: T) => React.ReactNode;
  /** 数字列右对齐 + tabular */ numeric?: boolean;
  className?: string;
  /** 移动端隐藏该列 */ hideOnMobile?: boolean;
}
export function DataTable<T>(props: {
  columns: Array<Column<T>>; rows: T[]; rowKey: (row: T) => string;
  loading?: boolean; emptyMessage?: React.ReactNode;
  onRowClick?: (row: T) => void;
  /** 加载中时渲染的骨架行数 */ skeletonRows?: number;
}): React.JSX.Element;
```

### `src/components/ui/pagination.tsx`
```ts
/** 页码分页(社区列表、管理表格) */
export function Pagination(props: { page: number; pageSize: number; total: number; onPageChange: (page: number) => void }): React.JSX.Element;
/** 游标分页的"加载更多" */
export function LoadMore(props: { hasMore: boolean; loading: boolean; onLoadMore: () => void; className?: string }): React.JSX.Element;
```

### `src/components/feedback/states.tsx`
```ts
export function LoadingState(props: { message?: string; className?: string }): React.JSX.Element;
/** 空状态:图标 + 标题 + 说明 + 可选操作 */
export function EmptyState(props: { icon?: React.ReactNode; title: string; description?: React.ReactNode; action?: React.ReactNode; className?: string }): React.JSX.Element;
/** 错误状态:自动用 describeError 取文案,展示 requestId 便于对照日志,提供重试 */
export function ErrorState(props: { error: unknown; onRetry?: () => void; className?: string; title?: string }): React.JSX.Element;
/** 无权限 / 需要登录 */
export function ForbiddenState(props: { message?: string; className?: string }): React.JSX.Element;
```

### `src/components/feedback/save-status.tsx`
```ts
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
/** 草稿自动保存状态指示。'dirty' 显示"有未保存的修改" */
export function SaveStatus(props: { state: SaveState; savedAt?: string | null; error?: string | null; onRetry?: () => void }): React.JSX.Element;
```

### `src/components/feedback/confirm-dialog.tsx`
```ts
/** 删除确认。danger=true 时确认按钮为危险色;requireText 时必须输入指定文本才能确认 */
export function ConfirmDialog(props: {
  open: boolean; onOpenChange: (open: boolean) => void;
  title: string; description?: React.ReactNode;
  confirmLabel?: string; cancelLabel?: string;
  danger?: boolean; requireText?: string;
  loading?: boolean; onConfirm: () => void | Promise<void>;
  theme?: 'dark' | 'light';
}): React.JSX.Element;
/** 命令式调用:const ok = await confirm({ title: '确认删除?' }) —— 内部用一个全局挂载点 */
export function useConfirm(): (options: { title: string; description?: React.ReactNode; danger?: boolean; confirmLabel?: string; requireText?: string }) => Promise<boolean>;
```

### `src/components/feedback/upload-progress.tsx`
```ts
export interface UploadItem { id: string; name: string; percent: number | null; status: 'pending'|'uploading'|'confirming'|'done'|'error'; error?: string }
export function UploadProgressList(props: { items: UploadItem[]; onRemove?: (id: string) => void; onRetry?: (id: string) => void }): React.JSX.Element;
```

### `src/components/media/asset-image.tsx`
```ts
/**
 * 资产图片。必须:懒加载、宽高占位(避免布局跳动)、响应式 sizes、错误兜底。
 * variant 决定取哪一档派生图:列表用 thumb,详情用 preview,下载用 original。
 */
export function AssetImage(props: {
  /** 后端返回的 AssetView(含 url / thumbUrl / previewUrl / width / height) */
  asset: { id: string; url: string; thumbUrl?: string | null; previewUrl?: string | null; width?: number | null; height?: number | null; mimeType?: string } | null;
  variant?: 'thumb' | 'preview' | 'original';
  alt: string;
  /** 容器宽高比,如 '1/1' '4/3';不传时用资产真实比例,仍需给占位 */
  aspect?: string;
  className?: string;
  sizes?: string;
  priority?: boolean;
  onClick?: () => void;
}): React.JSX.Element;
/** 图片灯箱:支持左右切换、缩放、下载 */
export function ImageLightbox(props: {
  open: boolean; onOpenChange: (open: boolean) => void;
  images: Array<{ id: string; url: string; previewUrl?: string | null; alt: string; downloadUrl?: string }>;
  index: number; onIndexChange: (index: number) => void;
  /** 额外信息面板,如生成参数 */ sidebar?: React.ReactNode;
}): React.JSX.Element;
```

## 3. 数据获取约定

- 客户端组件用 `@tanstack/react-query` + `@/lib/api/client` 的 `api.get/post/...`。
- Query key 一律用数组且第一段是域名:`['community','posts',params]`、`['workbench','shops']`、`['admin','dashboard',range]`。
- 需要"配置变更即刷新"的查询,把 `useSse().configVersions.models` 放进 query key。
- 服务端组件用 `@/lib/api/server` 的 `serverGet` / `serverGetOptional`。
- 错误处理:catch 到的错误交给 `<ErrorState error={error} onRetry={refetch} />`;表单错误用 `ApiError.fieldErrors` 回填。
- **不要在前端做权限决策**。隐藏按钮只是体验优化,后端才是判定方。

## 4. 通用要求(验收会逐项检查)

1. 每个列表都要有:加载骨架、空状态、错误 + 重试、分页。
2. 每个删除操作都要二次确认。
3. 每个上传都要显示真实进度(`lengthComputable` 才有百分比,否则只显示阶段)。
4. 每个表单都要有:提交中禁用、字段级错误、成功提示。
5. **不用 emoji 充当功能图标**,统一用 `lucide-react`。
6. 断点 390 / 768 / 1440 都要检查:移动端导航折叠为 `Sheet`,生图页改为上下结构。
7. 所有交互元素可键盘操作,有 `aria-label`,聚焦环由 `:focus-visible` 全局提供。
8. 页面标题用 `pageTitle('页面名')`(来自 `@june/shared`),生成「页面名 · JUNE」。
9. Logo 只能用 `<BrandLogo>`(来自 `@june/brand`),禁止自行拼 SVG 或 img。
10. 不编造进度百分比、不假装分享成功、不在前端出现任何供应商密钥。
