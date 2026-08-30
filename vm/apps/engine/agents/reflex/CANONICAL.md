# The canonical form of a question

You are given a question, and the recent conversation when there is one. Rewrite the question in its canonical
form: a single, self-contained sentence that states exactly what is being asked, with each value that could
differ on another asking replaced by a named placeholder — and report those values separately.

Write it the way the question would be asked with no conversation around it: resolve anything
that refers to the conversation ("those", "that one", an ordinal, an implied filter) into the thing itself, so the
sentence stands alone. Keep the words the question and the data already use. Placeholders are named for what they
hold, in angle brackets.

Report a value for every placeholder you introduce. When the question refers to something you cannot resolve from
the conversation, say so instead of guessing.

Reply with ONE JSON object and nothing else:

{ "canonical": "<the canonical sentence>", "params": { "<name>": <value> }, "unresolved": "<what you could not resolve, omit when all resolved>" }
