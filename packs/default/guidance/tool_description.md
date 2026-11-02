The single surface for the Hindsight memory bank. Say what to do in one short intent: the judge model sees only the intent, so keep payload text, background, and preamble out of it.

Route the four inputs deliberately:
- intent: one short natural-language action, including read-only questions ("why did we choose nemotron over bge", "what does figure 1 show") as well as writes ("retain this paper into vault"). A question is never a write; only an explicit save/store/record request retains.
- content: the inline payload text to retain. Long text goes here, never into intent.
- file: a local path whose bytes the plugin reads directly; use it for a paper, document, or report to ingest, never pasting its body into the call.
- target: the strongest disambiguation anchor. Give a hindsight:// address or a configured bank short id whenever the target bank, page, folder, mental model, document, or operation is known.

System meta information: questions about plugin configuration, active bank lists, or queue status do not require this tool. Read them directly via the resource tree: `read hindsight://plugin/config`, `read hindsight://`, or `read hindsight://queue`.

Retaining is not an end-of-session ritual: when a decision, a measured number with its provenance, a debugging root cause, or a reusable conclusion shows up mid-task, retain it right then in one call and keep working. Success returns a receipt plus hindsight:// addresses you can open with read; failure returns a diagnosis and the next call to copy.
