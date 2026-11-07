// WHAT A PERSON ASKED OR DID, as a message: a bubble on the right, the step below it the answer — so a thread reads as
// a conversation, and it is plain that anything can be asked, not only the screens shown. A question shows its words;
// a click shows what it did ("opened revenue by client", "narrowed to Pune").

export function Asked({ text, kind = 'asked', files = [] }: { text: string; kind?: 'asked' | 'did'; /** The files given with the question, by name. */ files?: { name: string; type?: string }[] }) {
  return (
    <div className="sa-asked" data-kind={kind}>
      {files.length > 0 && <div className="sa-asked__files">{files.map((f) => <span key={f.name} className="sa-pill sa-asked__file" title={f.name}>{f.type?.startsWith('image/') ? '🖼' : '📎'} {f.name}</span>)}</div>}
      <p className="sa-asked__bubble">{kind === 'did' ? text.charAt(0).toUpperCase() + text.slice(1) : text}</p>
    </div>
  )
}
