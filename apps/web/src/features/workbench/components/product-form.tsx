'use client';

import {
  ALLOWED_IMAGE_MIME_TYPES,
  PRODUCT_NAME_MAX,
  PRODUCT_SKU_MAX,
  productCreateSchema,
  productUpdateSchema,
  type AssetView,
  type ProductCreateInput,
  type ProductDetail,
  type ProductUpdateInput,
} from '@june/shared';
import { Package, Star, Trash2, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState, ErrorState, LoadingState } from '@/components/feedback/states';
import { UploadProgressList } from '@/components/feedback/upload-progress';
import { PageHeader } from '@/components/layout/page-header';
import { AssetImage } from '@/components/media/asset-image';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CharCounter, Field, Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { describeError } from '@/lib/api/errors';

import { useAssetUpload } from '../hooks/use-asset-upload';
import { useShopOptions } from '../hooks/use-options';
import { useProductDetail, useProductMutations } from '../hooks/use-products';
import { PRODUCT_ERROR_COPY, describeWithOverrides } from '../lib/error-copy';
import { PRODUCT_STATUS_OPTIONS } from '../lib/format';
import { blankToNull, fieldErrorsFromApi, fieldErrorsFromZod } from '../lib/form';

type ProductStatus = ProductCreateInput['status'];

function attributesToText(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function attributesFromText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function imagesFromDetail(product: ProductDetail): AssetView[] {
  return product.images.map((image) => ({
    id: image.assetId,
    kind: 'PRODUCT_IMAGE',
    status: 'ACTIVE',
    visibility: 'PRIVATE',
    mimeType: 'image/jpeg',
    byteSize: 0,
    width: image.width,
    height: image.height,
    url: image.url,
    thumbUrl: image.previewUrl,
    previewUrl: image.previewUrl,
    derivativeStatus: 'ready',
    createdAt: product.createdAt,
  }));
}

export function ProductFormPage({ productId }: { productId?: string }): React.JSX.Element {
  const detail = useProductDetail(productId ?? null);

  if (productId && detail.isPending) return <LoadingState message="加载商品" />;
  if (productId && detail.isError) {
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  }

  return <ProductForm product={detail.data} />;
}

export function ProductForm({ product }: { product?: ProductDetail }): React.JSX.Element {
  const router = useRouter();
  const shops = useShopOptions();
  const { create, update, remove } = useProductMutations();
  const upload = useAssetUpload();
  const editing = Boolean(product);

  const [shopId, setShopId] = useState(product?.shopId ?? '');
  const [name, setName] = useState(product?.name ?? '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [title, setTitle] = useState(product?.title ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [price, setPrice] = useState(product?.price ?? '');
  const [currency, setCurrency] = useState(product?.currency ?? 'CNY');
  const [stock, setStock] = useState(String(product?.stock ?? 0));
  const [status, setStatus] = useState<ProductStatus>(product?.status ?? 'DRAFT');
  const [attributesText, setAttributesText] = useState(product ? attributesToText(product.attributes) : '');
  const [images, setImages] = useState<AssetView[]>(product ? imagesFromDetail(product) : []);
  const [coverAssetId, setCoverAssetId] = useState<string | null>(
    product?.images[0] && product.coverUrl ? product.images.find((item) => item.url === product.coverUrl)?.assetId ?? product.images[0]?.assetId ?? null : null,
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (product && !shopId) setShopId(product.shopId);
  }, [product, shopId]);

  const submitting = create.isPending || update.isPending;
  const noShops = shops.data ? shops.data.length === 0 : false;

  async function onPickFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    const remain = Math.max(0, 20 - images.length);
    const picked = Array.from(files).slice(0, remain);
    const invalid = picked.filter((file) => !(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type));
    if (invalid.length > 0) {
      toast.error('仅支持 JPEG / PNG / WebP / GIF / AVIF');
      return;
    }
    const assets = await upload.upload(picked, 'PRODUCT_IMAGE');
    setImages((prev) => {
      const next = [...prev, ...assets].slice(0, 20);
      if (!coverAssetId && next[0]) setCoverAssetId(next[0].id);
      return next;
    });
  }

  async function submit(): Promise<void> {
    setFieldErrors({});
    const imageAssetIds = images.map((item) => item.id);
    const cover = coverAssetId && imageAssetIds.includes(coverAssetId) ? coverAssetId : (imageAssetIds[0] ?? null);
    const priceValue = price.trim() === '' ? null : Number(price);
    const stockValue = Number(stock);

    if (editing && product) {
      const payload: ProductUpdateInput = {
        shopId: shopId || undefined,
        name,
        sku: blankToNull(sku),
        title: blankToNull(title),
        description: blankToNull(description),
        price: priceValue,
        currency,
        stock: Number.isFinite(stockValue) ? stockValue : 0,
        status,
        attributes: attributesFromText(attributesText),
        coverAssetId: cover,
        imageAssetIds,
      };
      const parsed = productUpdateSchema.safeParse(payload);
      if (!parsed.success) {
        setFieldErrors(fieldErrorsFromZod(parsed.error));
        return;
      }
      try {
        await update.mutateAsync({ id: product.id, input: parsed.data });
        toast.success('商品已更新');
        router.push(`/workbench/products/${product.id}`);
      } catch (error) {
        setFieldErrors(fieldErrorsFromApi(error));
        toast.error(describeWithOverrides(error, PRODUCT_ERROR_COPY));
      }
      return;
    }

    const payload: ProductCreateInput = {
      shopId,
      name,
      sku: blankToNull(sku),
      title: blankToNull(title),
      description: blankToNull(description),
      price: priceValue,
      currency,
      stock: Number.isFinite(stockValue) ? stockValue : 0,
      status,
      attributes: attributesFromText(attributesText),
      coverAssetId: cover,
      imageAssetIds,
    };
    const parsed = productCreateSchema.safeParse(payload);
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFromZod(parsed.error));
      return;
    }
    try {
      const created = await create.mutateAsync(parsed.data);
      toast.success('商品已创建');
      router.push(`/workbench/products/${created.id}`);
    } catch (error) {
      setFieldErrors(fieldErrorsFromApi(error));
      toast.error(describeWithOverrides(error, PRODUCT_ERROR_COPY));
    }
  }

  if (shops.isError) return <ErrorState error={shops.error} onRetry={() => void shops.refetch()} />;

  if (noShops) {
    return (
      <EmptyState
        icon={<Package size={22} />}
        title="请先创建店铺"
        description="商品必须归属到店铺。先创建一家主店后再添加商品。"
        action={
          <Button asChild>
            <Link href="/workbench/shops/new">去创建店铺</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title={editing ? '编辑商品' : '新建商品'}
        description="价格与库存以提交时填写的值为准。图片会走真实上传进度。"
        breadcrumbs={[
          { label: '商品', href: '/workbench/products' },
          { label: editing ? product?.name ?? '编辑' : '新建' },
        ]}
        actions={
          editing && product ? (
            <Button variant="danger" iconLeft={<Trash2 size={16} />} onClick={() => setDeleteOpen(true)}>
              删除
            </Button>
          ) : null
        }
      />

      <Field label="所属店铺" htmlFor="product-shop" required error={fieldErrors.shopId}>
        <Select
          id="product-shop"
          value={shopId || null}
          onChange={setShopId}
          options={(shops.data ?? []).map((shop) => ({ value: shop.id, label: shop.name }))}
          placeholder={shops.isLoading ? '加载店铺' : '选择店铺'}
        />
      </Field>
      <Field label="名称" htmlFor="product-name" required error={fieldErrors.name} addon={<CharCounter value={name} max={PRODUCT_NAME_MAX} />}>
        <Input id="product-name" value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="SKU" htmlFor="product-sku" error={fieldErrors.sku} addon={<CharCounter value={sku} max={PRODUCT_SKU_MAX} />}>
        <Input id="product-sku" value={sku} onChange={(event) => setSku(event.target.value)} />
      </Field>
      <Field label="标题" htmlFor="product-title" error={fieldErrors.title}>
        <Input id="product-title" value={title} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field label="描述" htmlFor="product-desc" error={fieldErrors.description}>
        <Textarea id="product-desc" rows={5} autoGrow value={description} onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="价格" htmlFor="product-price" error={fieldErrors.price}>
          <Input id="product-price" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
        </Field>
        <Field label="币种" htmlFor="product-currency" error={fieldErrors.currency}>
          <Input id="product-currency" value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} />
        </Field>
        <Field label="库存" htmlFor="product-stock" error={fieldErrors.stock}>
          <Input id="product-stock" inputMode="numeric" value={stock} onChange={(event) => setStock(event.target.value)} />
        </Field>
      </div>
      <Field label="状态" htmlFor="product-status">
        <Select
          id="product-status"
          value={status}
          onChange={(value) => setStatus(value as ProductStatus)}
          options={PRODUCT_STATUS_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
        />
      </Field>
      <Field label="扩展属性" htmlFor="product-attrs" description="每行一条,形如 颜色=白色">
        <Textarea id="product-attrs" rows={3} value={attributesText} onChange={(event) => setAttributesText(event.target.value)} />
      </Field>

      <Card>
        <CardHeader>
          <CardTitle as="h2">商品图片</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {images.map((asset) => (
              <div key={asset.id} className="relative size-24 overflow-hidden rounded-md border border-border-default">
                <AssetImage asset={asset} variant="thumb" alt={name || '商品图'} aspect="1/1" className="size-full" />
                <div className="absolute inset-x-0 bottom-0 flex justify-between bg-bg/80 p-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={coverAssetId === asset.id ? '当前封面' : '设为封面'}
                    onClick={() => setCoverAssetId(asset.id)}
                  >
                    <Star size={12} className={coverAssetId === asset.id ? 'text-accent' : 'text-fg-muted'} />
                  </Button>
                  <Button
                    variant="danger"
                    size="icon"
                    className="size-6"
                    aria-label="移除图片"
                    onClick={() => {
                      setImages((prev) => prev.filter((item) => item.id !== asset.id));
                      setCoverAssetId((current) => (current === asset.id ? null : current));
                    }}
                  >
                    <X size={12} />
                  </Button>
                </div>
              </div>
            ))}
            {images.length < 20 ? (
              <label className="flex size-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border-strong text-fg-muted hover:bg-surface-hover">
                <Upload size={16} aria-hidden />
                <span className="text-[11px]">上传</span>
                <input
                  type="file"
                  accept={ALLOWED_IMAGE_MIME_TYPES.join(',')}
                  multiple
                  className="sr-only"
                  onChange={(event) => {
                    void onPickFiles(event.target.files);
                    event.target.value = '';
                  }}
                />
              </label>
            ) : null}
          </div>
          <p className="text-xs text-fg-subtle">最多 20 张。星标为封面。上传进度为真实字节进度,无法计算时只显示阶段。</p>
          <UploadProgressList items={upload.items} onRemove={upload.removeItem} onRetry={upload.retryItem} />
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button loading={submitting || upload.uploading} disabled={!shopId || !name.trim()} onClick={() => void submit()}>
          {editing ? '保存' : '创建'}
        </Button>
        <Button variant="ghost" onClick={() => router.push(product ? `/workbench/products/${product.id}` : '/workbench/products')}>
          取消
        </Button>
      </div>

      {product ? (
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          theme="dark"
          danger
          title="删除商品"
          description={`将删除「${product.name}」。图片引用会被释放,此操作不可撤销。`}
          confirmLabel="删除"
          loading={remove.isPending}
          onConfirm={async () => {
            try {
              await remove.mutateAsync(product.id);
              toast.success('商品已删除');
              router.push('/workbench/products');
            } catch (error) {
              toast.error(describeError(error));
            }
          }}
        />
      ) : null}
    </div>
  );
}
