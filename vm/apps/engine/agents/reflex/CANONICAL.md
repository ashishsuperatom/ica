# The canonical form of a question

You are given a question, and the recent conversation when there is one. Rewrite the question in its canonical
form: a single, self-contained sentence that states exactly what is being asked, with each concrete VALUE in it
replaced by a named placeholder — and report those values separately.

A value is a specific thing the question happens to be pinned to on this asking: a number, a date or period, a
named person/organisation/product, a threshold. Everything else is what the question IS — what is being asked,
about what, grouped or ranked how — and stays as words. Two questions that ask the same thing about the same
kind of thing, differing only in their values, must come out as exactly the same sentence.

Write it the way the question would be asked with no conversation around it: resolve anything
that refers to the conversation ("those", "that one", an ordinal, an implied filter) into the thing itself, so the
sentence stands alone. Keep the words the question and the data already use, and keep the unit next to its
placeholder when the question states one. Placeholders are named for what they hold, in angle brackets.

Report a value for every placeholder you introduce, and give the same sentence once more with those values
written in — that one is what someone reads to know what is being asked, with nothing left pointing at the
conversation. When the question refers to something you cannot resolve from it, say so instead of guessing.

Reply with ONE JSON object and nothing else:

{ "canonical": "<the canonical sentence>", "resolved": "<the same sentence with the values written in>", "params": { "<name>": <value> }, "unresolved": "<what you could not resolve, omit when all resolved>" }
