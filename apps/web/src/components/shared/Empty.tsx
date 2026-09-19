export function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><span>◇</span><h3>{title}</h3><p>{text}</p></div>; }
