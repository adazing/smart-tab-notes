export function PrivacyView({ onContinue, busy, error }: {
  onContinue: () => void; busy: boolean; error: string;
}): JSX.Element {
  return <section className="page">
    <h2 className="page__title">Your privacy controls</h2>
    <div className="card"><h3>What the extension reads</h3>
      <p>After you continue, selected text and nearby words are reported to the side panel when you select text on an allowed page. Explain, Ask, Highlight and Note use your selection.</p>
      <p>Requesting page context reads readable text from the current page. Other open tabs are read only when chosen for context; tab selection is planned.</p>
    </div>
    <div className="card"><h3>What is sent to AI</h3>
      <p>When you use AI features such as Explain or Ask, selected text, your question and relevant page text are sent to AI to provide context. Content from other open tabs is included when you choose those tabs for context. Blocked websites are excluded.</p>
    </div>
    <div className="card"><h3>What stays local</h3>
      <p>Saved pages, notes, highlights, chat summaries and collections use local browser storage. Blocklist preferences also stay local. No synchronization is implemented. Toolbar notes and highlights are currently temporary.</p>
    </div>
    <div className="card"><h3>You decide</h3>
      <p>Settings lets you block websites and their subdomains from reading and tab context, clear the current page’s notes, or permanently clear saved extension data. The starter blocklist is not exhaustive.</p>
    </div>
    {error && <p role="alert" className="notice">{error}</p>}
    <button className="button" disabled={busy} onClick={onContinue}>{busy ? 'Saving…' : 'Continue'}</button>
  </section>;
}
