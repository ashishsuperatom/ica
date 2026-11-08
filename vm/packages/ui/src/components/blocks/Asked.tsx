// WHAT A PERSON ASKED OR DID, as a message: a bubble on the right, the step below it the answer — so a thread reads as
// a conversation, and it is plain that anything can be asked, not only the screens shown. A question shows its words;
// a click shows what it did ("opened revenue by client", "narrowed to Pune"). The files given with a question sit above
// its words: an image as itself, any other file by its name.

import { useEffect, useState } from 'react'
import { Icon } from '../ui/Icon'
import { useProgramEnv } from '../frame/programEnv'

export type AskedFile = { name: string; type?: string; hash?: string; session?: string }

export function Asked({ text, kind = 'asked', files = [] }: { text: string; kind?: 'asked' | 'did'; /** The files given with the question. */ files?: AskedFile[] }) {
  return (
    <div className="sa-asked" data-kind={kind}>
      {files.length > 0 && <div className="sa-asked__files">{files.map((f, i) => <AskedFileView key={`${f.hash ?? f.name}:${i}`} file={f} />)}</div>}
      <p className="sa-asked__bubble">{kind === 'did' ? text.charAt(0).toUpperCase() + text.slice(1) : text}</p>
    </div>
  )
}

function AskedFileView({ file }: { file: AskedFile }) {
  const env = useProgramEnv()
  const image = !!file.type?.startsWith('image/') && !!file.hash && !!file.session && !!env?.preview
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!image) return
    let on = true
    void env!.preview!({ session: file.session!, hash: file.hash!, name: file.name }).then((u) => { if (on) setUrl(u) }, () => {})
    return () => { on = false }
  }, [image, file.hash, file.session])   // eslint-disable-line react-hooks/exhaustive-deps
  if (image) return <span className="sa-asked__thumb" title={file.name}>{url && <img src={url} alt={file.name} />}</span>
  return <span className="sa-pill sa-asked__file" title={file.name}><Icon icon={file.type?.startsWith('image/') ? 'lucide:image' : 'lucide:paperclip'} />{file.name}</span>
}
