'use client';

export function JsonBlock({ value }: { value: unknown }): React.JSX.Element {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    text = String(value);
  }

  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-border-default bg-bg px-3 py-2 font-mono text-xs leading-relaxed text-fg">
      {text}
    </pre>
  );
}
