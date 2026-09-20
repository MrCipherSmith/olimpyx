export function ErrorText({ text }: { text: string }) {
  // text is a pre-translated error message — either from humanizeError (server-emitted) or the caller's catalog entry.
  return <p className="form-error" role="alert">{text}</p>;
}
