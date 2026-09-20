export function Empty({ title, text }: { title: string; text: string }) {
  // Title and text are passed in by callers, who translate via the catalog at the call site.
  return <div className="empty"><span aria-hidden="true">◇</span><h3>{title}</h3><p>{text}</p></div>;
}
