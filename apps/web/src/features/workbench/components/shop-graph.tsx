'use client';

import {
  Background,
  Controls,
  Handle,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  Position,
} from '@xyflow/react';
import dagre from 'dagre';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';

import '@xyflow/react/dist/style.css';

import { EmptyState, ErrorState, LoadingState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import { useShopGraph } from '../hooks/use-shops';
import { SHOP_TYPE_LABEL } from '../lib/format';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 96;

type ShopNodeData = {
  name: string;
  type: 'MAIN' | 'SUB';
  status: 'ACTIVE' | 'PAUSED' | 'CLOSED';
  productCount: number;
  platform: string | null;
};

function layout(nodes: Array<Node<ShopNodeData>>, edges: Edge[]): { nodes: Array<Node<ShopNodeData>>; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'TB', nodesep: 48, ranksep: 80 });

  for (const node of nodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);

  return {
    nodes: nodes.map((node) => {
      const pos = graph.node(node.id);
      return {
        ...node,
        targetPosition: Position.Top,
        sourcePosition: Position.Bottom,
        position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      };
    }),
    edges,
  };
}

function ShopNode({ data }: NodeProps<Node<ShopNodeData>>): React.JSX.Element {
  return (
    <div className="w-[220px] rounded-lg border border-border-default bg-surface px-3 py-2 shadow-sm">
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 opacity-0" />
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-fg">{data.name}</p>
        <Badge size="sm" tone={data.type === 'MAIN' ? 'accent' : 'purple'}>
          {SHOP_TYPE_LABEL[data.type]}
        </Badge>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <StatusBadge status={data.status} />
        <span className="tabular text-xs text-fg-muted">{data.productCount} 商品</span>
      </div>
      {data.platform ? <p className="mt-1 truncate text-xs text-fg-subtle">{data.platform}</p> : null}
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 opacity-0" />
    </div>
  );
}

const nodeTypes = { shop: ShopNode };

export function ShopGraphPage(): React.JSX.Element {
  const router = useRouter();
  const graphQuery = useShopGraph();

  const laidOut = useMemo(() => {
    if (!graphQuery.data) return { nodes: [] as Array<Node<ShopNodeData>>, edges: [] as Edge[] };
    const nodes: Array<Node<ShopNodeData>> = graphQuery.data.nodes.map((node) => ({
      id: node.id,
      type: 'shop',
      data: {
        name: node.name,
        type: node.type,
        status: node.status,
        productCount: node.productCount,
        platform: node.platform,
      },
      position: { x: 0, y: 0 },
    }));
    const edges: Edge[] = graphQuery.data.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    }));
    return layout(nodes, edges);
  }, [graphQuery.data]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="店铺关系图"
        description="可缩放、拖动。布局由自动算法生成。点击节点进入详情。"
        breadcrumbs={[{ label: '店铺', href: '/workbench/shops' }, { label: '关系图' }]}
        actions={
          <Button variant="secondary" asChild>
            <Link href="/workbench/shops">返回列表</Link>
          </Button>
        }
      />

      {graphQuery.isPending ? <LoadingState message="加载关系图" /> : null}
      {graphQuery.isError ? <ErrorState error={graphQuery.error} onRetry={() => void graphQuery.refetch()} /> : null}
      {graphQuery.data && graphQuery.data.nodes.length === 0 ? (
        <EmptyState title="还没有店铺" description="创建主店和子店后,这里会展示层级关系。" />
      ) : null}

      {graphQuery.data && graphQuery.data.nodes.length > 0 ? (
        <div className="h-[min(70vh,640px)] overflow-hidden rounded-lg border border-border-default bg-bg">
          <ReactFlow
            nodes={laidOut.nodes}
            edges={laidOut.edges}
            nodeTypes={nodeTypes}
            fitView
            colorMode="dark"
            minZoom={0.4}
            maxZoom={1.6}
            onNodeClick={(_, node) => router.push(`/workbench/shops/${node.id}`)}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
      ) : null}
    </div>
  );
}
