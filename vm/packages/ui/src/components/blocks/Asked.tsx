// WHAT A PERSON ASKED OR DID, as a message: a bubble on the right, the step below it the answer — so a thread reads as
// a conversation, and it is plain that anything can be asked, not only the screens shown. A question shows its words;
// a click shows what it did ("opened revenue by client", "narrowed to Pune").

export function Asked({ text, kind = 'asked' }: { text: string; kind?: 'asked' | 'did' }) {
  return (
    <div className="sa-asked" data-kind={kind}>
      <p className="sa-asked__bubble">{kind === 'did' ? text.charAt(0).toUpperCase() + text.slice(1) : text}</p>
    </div>
  )
}
