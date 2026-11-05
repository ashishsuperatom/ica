# The intent graph — the user's specification (2026-11-01), and the decisions taken with it

This is the source for the intent graph's rebuild on the `intent` branch. The user's text is kept as written (light typo
fixes only); the decisions they made when asked follow it. `docs/intent-graph.md` describes what is built.

## Decisions (asked 2026-11-01, answered by the user)

1. **Matching: every message goes to the composer — it is the entry point, nothing skips it.** The question is
   parametrised (dates, periods, numbers, codes, names → placeholders) into its canonical form, and pure text search (terms
   — no semantic search yet) finds the candidates: the one node whose canonical form is exactly equal, when there is one
   (then no other candidates); otherwise at most the top 5. The composer always decides — the same intent it is in, a
   candidate, or a new intent (→ the analyst) — guided by a concept that says what a match is: the same meaning, exactly
   (not the same text); a partial match is never taken. Duplicates are fine, a wrong match is a bug. (2026-11-01: "feed
   that into the composer to decide, max top 5"; "if the text search finds an exact match then no need to get top 5";
   "the composer needs a concept which tells that it has to be an exact match — not text for text but the meaning";
   "nothing is skipping the composer no matter what — that's the entry point".)
2. **Intent close happens at the next question.** The composer always gets the next question first and decides whether
   it is a new intent or the same one (a refinement of the answer). A new intent closes the current one, which triggers
   the background extraction in a clone of the session.
3. **One Durable Object per intent node** — every node, not only entry nodes; each holds its Global and users' versions,
   its history, its sub-paths. Nodes are independent: any node can be reached from any other, so none sits inside
   another; edges point between DOs.
4. **Approving the Global version needs a new capability** (not project.manage by itself).
5. **The per-session analyst runs claude-code sonnet-5** (changeable later through the agent profile).
6. **Overnight: build, deploy the platform, and test here on the forge** — the Lab project and Procurement Intelligence,
   both native engines. The user: "all tests you do here, until we develop this intent graph" (not on TotalGroup).
7. **Extracted concepts are written at once, scoped to the user** (visible to them, referenced by their node,
   provisional); each one that is not user-specific is filed as a suggestion to publish to everyone, approved by the
   curator — the composition graph's existing scopes and suggestions.
8. **The composer decides "new intent" inside its own turn:** it either answers (same intent) or replies only with a
   marker that this is a new intent — then the current intent closes and the analyst takes the new one. No extra turn
   when it answers.
9. **Next-intent edge functions are written to the existing options contract** (given STATE, history, read-only
   services; time-limited, read only), built and run on the engine like programs.
10. **One mechanism for "what next":** a program's option functions and an intent node's next-intent checks are the same
    thing (the user: "the program's next option compute is similar to the intent node's next intent compute") — an edge's
    function is an option function whose offer is "go to this intent"; one contract, one runner on the engine.

**What users say is accumulated, never taken as truth** (2026-11-01): "whatever the users are saying, whatever the
feedback they are giving, there could be truth in there, things to learn, or there could be nothing in there … each user's
information, what they're asking and what they're doing, finally gets accumulated in the project level … then we'll figure
out eventually what is essential in there so that we can keep that." Every user's variation is kept at the node (the
Global node's accumulated view); none replaces another; what is essential settles later (approval, consolidation).

**Domains are no longer used to route a question** — the intent graph is the primary way; domains and concepts remain as
things a node links to ("it should not work on domain — it should use domain/concept as a thing").

**The hand-off to the analyst is a system tool, not a marker and not a concept** (2026-11-02): the composer has a tool to
send messages to other agents — `sendToAgent("analyst", "<the message>")`, the first of them — part of the system, given
before any concept or domain. It sends only the question; the analyst knows the session, and has its own instructions
(appended to Claude Code's: what it is, what a session is, programs, what it can create and do), the shared concepts
(how to answer) and its own (its job with a completely new intent). The composer waits; the analyst's answer is
presented as usual; the composer's turn ends. "So no :::analyst anywhere." (This replaces the `:::analyst` line of
decision 8.)

**Learning happens after every answer, one learner per session** (2026-11-02): closing an intent only at the next question
lost everything when the person was content with the first answer ("if I am satisfied with the answer and never ask a 2nd
question — then we will never create anything"). So a clone learns after every answer; "this cloning has to happen in a
singleton per session … so that we don't create many": answers that arrive while a clone runs are learnt by one more run
when it finishes. "The common case is the cloning and finding the concepts will be fast." (This replaces decision 2's
"the intent closes at the next question" as the trigger for learning; the composer still decides whether the next message
is the same intent.)

**Three kinds of suggested next intent** (2026-11-02): "1. Interpolation — where we ask something that follows naturally;
2. Extrapolation — based on the data and context ask a different question, but based on that data; 3. Novelty — by thinking
outside of what data we see, a completely different direction. All three have to be computed from the system — quickly so
that it makes sense." And: "the question has to make sense in general, not only in this scenario … not optimising for the
current situation — if it knows what this thing is for and the purpose it should design them well." The learning clone
(Sonnet 5) writes one of each, for the intent (sensible for anyone asking it, with any values); each one's check decides
each time whether it makes sense then.

**A pool of next questions that evolves** (2026-11-02): "it is not going to be just three questions — there are going to be
many questions in each of those three categories … we try one of them, and if it feels we try another … in some order of
which one is most likely … we do not ask for all of them, because imagine in some case it is failing and you keep trying."
Every check tried is kept as its history (made sense, empty, failed) with how often people took it; the learner sees that
history, adds new ones and retires weak ones — "never more than three really at a time"; "it is not always necessary that you have to keep adding
— what if it doesn't make sense to add a novelty question": each run looks at what is there and adds up to three, of any
kinds, only where they make sense.

**The node is the memory of how to answer; concepts are the shared library** (2026-11-02): "the intent is supposed to be a
memory of how to solve the problem … everything that is necessary, including which table … not an exact program — a
reference, a knowledge … this is what you can do, this is what we did last time … tell about how to find the answer (errors
only if absolutely necessary) … and we have to create concepts from there so that other people can also take from there."
"Think of it like a big software project: the common libraries, tools and definitions used in multiple places are defined
in one place … how to calculate revenue, pending money … all the actual logic about how to calculate things belongs in the
concepts … referential integrity: when we find the correct formula we change it and it affects everything else … given an
intent, what are the concepts we need to load so that we can immediately answer the question in different scenarios."

**2026-11-05 — what the user decided after the first session in the UI:**
- The composer hands over with fixed terms only — `sendToAgent("analyst", "current-question")` — and the engine fills the
  question in: the composer never writes it out again (it could misread or invent one). The analyst is given, word for word,
  the questions asked since it last saw the conversation (their answers are in the session's files), then the question that
  is its to work out.
- At most three next intents an answer offers, in their own section at the end of the step, large enough to click.
- The learner first proposes the concepts (names and descriptions); they are searched among the person's and the project's
  concepts; one that matches exactly is reused, never written again.
- Every learning happens first at the person's intent; what is the person's for every answer may go outside the intent at
  once — as long as it is theirs.
- The composer's judgement (same intent or a new one) is left to it: only what must be deterministic is made so.

**What the composer and the analyst are told comes from the graph, never the code** (2026-11-05): "we can't have it
hardcoded — we need the same domain idea only — but we no longer select the domain based on the question … keep the
selection behaviour, but always return the default domain — which will just have the initial instruction for composer and
analyst … for the analyst one concept different, and for the composer one concept different, which tells about the existence
of the analyst and how and when to use it." "The domain is just a high-level selector — it will have system-level concepts
which are generally shared with all intents."

**Platform defaults apply at once; a person's learnt concepts stay outside the project's versions** (2026-11-05, "yes"): the
roles and other platform concepts were sitting in every project's draft, unseen by the agents; and learnt concepts would have
been published by whoever published next. Now the platform's own concepts are read as they are now, and concepts learnt
from a person's answers are never in the draft (docs/composition-graph.md).

**Learning goes to the person's intent only** (2026-11-05): "what if I actually meant for this intent — or this question —
I want the value in lakh … when we are working with some other intent and I want Cr … things have to be put to USER INTENT
only and then we will figure out what to take up the graph." (This replaces the person-wide "for every answer" concept of
earlier the same day.) A learnt concept states the rule itself, never who asked for it.

Earlier the same day: platform data (the intent graph, lists, settings) is read over HTTP from the Durable Objects,
never over the WebSocket, through one client per area (`control-plane/shared/api/user.ts`, `admin.ts`); the WebSocket
is only for what streams from the engine.

## The specification

### Intent Graph

So we have been using the concepts of domains. The reasoning: memory and context is essential to work with complex
systems — so a domain, which is really the root node of a tree of concepts, is what we went for, and it has been good for
us. It gave us a bit more determinism and good follow-up. Before this we just had concepts and they had no hierarchy, and
when we needed one we used to search for concepts. But the problem is that search most of the time was just not giving
the concept we wanted, and sometimes it could even give the wrong concept and pollute our agent's context. So it was a
mess. It didn't work.

So we got rid of that and rather went for domains. Now all we had to do was pick a domain given a user question and load
all the concepts associated with it. There was nothing more we had to do.

Then we moved to the next set of problems.

The first one being: domains include all the things necessary to answer, so they became big and the agents were not
following prompts any more. When the user started asking a question about another domain, we were just not able to
answer — we had to fix a session to one domain.

Creating a domain is now a task just as big as manual ontology creation. The thing is that this is very much an
empirical science: we don't know what to put into a domain until we see the questions inside it, and we have to create
domains manually.

We need a mechanism for training this system. We are also missing memory — whatever the user says is the correct
method, or if we figure out the proper way of finding something (the one we call the process graph), we had no way of
encoding it. If we start to do all of that, it will be everything required to answer all the questions in that domain —
which could be really anything.

So we will now define the best version of what we have understood, and what we want our system to be: THE INTENT GRAPH.

I will define everything you need to know and implement — here nothing will be left to guesswork.

First the Intent Node:
What the user wants to do/know/ask is the intent. It can be a question or a request. We will define that as the starting
point of the Intent Node. The Intent Node will have many more things: memory, UI representation, all the variations of
the data and state that have passed through this node will also be part of the node. So it will have a history.

So let's start with the first step — the user asks a question Q:

Q now has to go into an intent node. There are going to be 2 kinds of intent node that first we need to discuss — the
Entry Node and the Follow-up Node. The entry nodes are the ones the user directly interacts with at the beginning of a
session. It's going to be actually a list of nodes — why a list, why not a tree? It is just going to be all the
questions/requests all the users have made ever in a project.

We will have another way to organise these questions so that they are categorised and put into a hierarchy. But because
there will never be any canonical hierarchy we want rather a list — and many ways to categorise. So we will have
hierarchies, but just to index it separately.

So let's start at the beginning.

A user asks a question Q → there will be 3 scenarios.

#### Scene-1: NO MATCH to Q
1.a: But first, how would you match:
  - First we can parametrise the question so that it looks canonical — things like date and time, and customer names or
    any kind of names — we will have a list of these and based on that we can first parametrise. Then we take the terms
    in them and search just like how we do domain search today. And then we will also run a tiny semantic search model,
    which helps a bit — but mostly we will rely on text search and term search, and based on that we have to match which
    intent it will go to. The first thing to notice here is the user's Q vs the actual intent. We will not convert the
    question into an intent and then search — we will just create the canonical version of the question as it is and
    just search.
  - Imagine the user has in one prompt actually Q = q1 + q2 + request1 ⇒ we will match it only with q1+q2+req1 — even
    if there was a node with just q1+req1 and another node for q2, we will not match to both and combine. No — we will
    just go for the exact prompt, because it matters how we provide them with the answer.
  - So for scenario 1 — let's say nothing matched, not even partially, just nothing — we make the first Entry Intent
    Node with this Q. In this node we store the canonical version and this Q, and then we start the process.

#### Intent Node Process
What are we going to do, given that we have no info on what to do here? We will actually give this job to an intelligent
model. Until now we used to make the ica:composer do everything — but it's a small model with less intelligence. I have
made a decision to use big models for the first few steps, until we are sure that we have captured the intent properly.

Now is a good time to describe what really we want to keep in an Intent Node: the Intent Node stores the answer to a
question. Although it looks simple, I will tell you what other complications could come — we have to think about each.

So for question Q → EIN (Entry Intent Node) → A (1st answer that the ICA provides). What could happen:
1. A is wrong.
2. A is correct — but the way it's represented is wrong or not wanted.
3. A is correct — but we want it done another way (let's say it took a long time).

And because of that, even though we got the answer A, the job of the intent node is not done yet. Take the 1st option:
1. The answer is wrong → how do we know it's wrong? If the user knows the answer is wrong, they might just tell that this
   answer is wrong. If they don't know, we can't take that as the correct answer and create knowledge out of it. I will
   tell later what I mean by creating knowledge out of it.
2. So every answer we get, we will think of as a provisional answer. The more we get the same answer, the more we will
   say we are consistent — but consistent can't be actually the correct answer; we are just consistent, we can also be
   consistently wrong. When I say answer here I mean the process of getting the answer — not the answer itself, because
   as the world changes the answer will keep changing. Imagine we say calculate "additional revenue" — it will keep
   changing based on when we do it and what filters are applied. But the process of calculating it is the knowledge that
   we want to compare, save and judge if it's correct.

For the 2nd option → the answer is correct but the user wants to change something — let's say they say "okay but show
the created-at field and at the bottom of the table show the total and remaining amount". That could be 3 or more
conversations — and when they settle, that's the end of the Intent Node. So in a session, if a user asks Q → A → Req1 →
A → Req2 → A → Q2 → A → Req3 → A, then we say it's one intent. So there is a trick here — at some point we will know that
the current intent is over and we are supposed to move to a new one. This is more art now than science, and we will come
up with some rule for how much we need to put in one intent node. But at the end the Intent Node has the first important
thing: I → (the process) → A. The process is a learnt thing from the conversation, so that it can be a reusable system to
answer that kind of question.

We had done this thing before with programs, and it failed in many cases — the reason is that there we were creating
deterministic code that had to be run. So we have learnt our lesson — there is just so much dynamism in the system we are
building that a program simply won't do. So what we will put in the Intent Node is this:
1. Concepts: the concepts required to do this calculation or to reach the answer.
2. The input for this question and its output at the end. This goes into the history section — we store this in the
   Intent Node's Durable Object.
3. The UI representation — we will have special concepts for how to represent this for the user.
4. Everything is for this user. Nothing here will be for the global project — we will extract things from this that
   should go to the Global Intent Node for the project, and that will be a separate task we will discuss later.

One thing I missed telling: there are 3 kinds of Intent Node when it comes to ownership.
1. Global — everyone
2. Group — a group of users by some rule
3. User — each user

The Intent Nodes are primarily going to be about the user, because each user might mean something different. Now in an
enterprise that is also a problem, because we want everyone to use the same definition of the process and the concepts.
So every time we create a User Intent, we will also extract the concepts in it that should really be global and
independent of any user, and pass them upwards to the Global Intent Node for that intent. So for every intent there is
going to be one Global one, one for each user (we create this only when they match) and 0 or 1 for each group — the group
one we will not implement now; it comes in a later version.

The value of the Global one is to have one rule for everyone in the project. It will be used like this:
1. When a new user asks a question and they don't have any Intent Node for it, we match to the Global one, and if
   something matches they can start from there — now they have a copy of the Global one and we reference it to do the
   process. At the end we get an Intent Node for that user, and we might also find out if they have anything new to
   contribute to the Global Intent Node after the process is done.

Here a very important concept called agent cloning has to be discussed. Let's say we match an intent and we tell an ICA
(the analyst when new, or the composer when we have enough knowledge already built): here is the question and here are
the Global Intent Node's concepts and other things — go ahead and solve or answer this. Once it's done, we need to clone
it: the original thread is, let's say, T1; we clone T1 and get T2. To T2 we then say, in the background: figure out what
new concepts we should create, what we should store, what we should send to the Global Intent Node — and it has all the
context, so it can answer that — and then we just delete the clone T2. The reason is we don't want to do that in T1, for
2 reasons: the user might continue asking questions, so we can't stop them just because we are doing some background
job; and 2nd, we don't want this part in the main session anyway. So at each closing of the intent we just clone it and
extract additional knowledge if there is any (in most cases there will be none, actually), and save it. The big
implementation problem is this: for the ICAs codex, pi and opencode, cloning is already well defined — it's programmatic
mode, so it's easy. For claude-code it's a PTY — cloning is difficult. We need to figure out how to do the cloning
reliably for all the ICAs, and delete the clone once its job is done.

#### Scene-2: Match
When we say match we mean complete match. Also, because these are non-deterministic systems and another user might be
asking the same Q simultaneously, we will inevitably create many Intent Nodes which are actually the same. And the
reverse is also possible: they are not the same and we matched to the same one. The first case is okay; the 2nd case is
a bug we should try to avoid. So it's okay to create a new Intent Node, but don't try to fit into something that might
not match. If we create many nodes there will be many duplicates. And one of our goals is referential integrity — what I
mean is: we can never know when we have the ultimate truth, so we will consider all those concepts provisionally true,
and when we get a better version we will have to replace them. If we copy them into each Intent Node, we now have old
knowledge. So we will have the concept layer as an atomic knowledge base. Every Intent Node will simply point to the
concepts it uses — we create concepts at the end of the process, after we have the answer.

So when we match with an intent, we have a few things to do. We use that Intent Node to process and find an answer for
the user — while we do that we might realise that the previous knowledge we had about answering this intent does not
make sense for this input (remember all intents are parametrised, and each input can lead in a different direction). So
we have a sub-graph inside each intent node — as we keep getting different scenarios we will not immediately move them to
different Intent Nodes, because the intent itself has not changed; but the same intent has multiple steps, and in the
2nd, 3rd, 4th… step we might find a divergence in how it's done. So there is a sub-graph inside the Intent Node, which
breaks the process into multiple paths, so that next time we can choose a path based on the scenario.

Note that when we create a concept we have to make it atomic. The concepts are all global, so their names should always
indicate that.

So once an intent is matched, we just use its knowledge to answer, and after that we again decide if an additional
concept has to be created or something has to be changed or removed. It will be a continuous process — but we can never
delete anything; everything remains forever, even the wrong ones — we just deprecate them.

#### Scene-3: No match for the user, but a match for the Global Intent Node
This is the scenario when a new user comes — we can't find any Intent Node because they are new, or it's the first time
they asked this. So we use the Global Intent Node to answer. Remember, the Global Intent Node is never used directly —
it's just a reflection of all the User Intents summed together. It has all the common things shared by everyone; it will
not have any user-specific concepts or knowledge. So if, to answer a question, we don't need any user-specific concepts,
then GIN === UIN — both are just the same. Anyway both just reference the same concept nodes. We always use the User
Intent Node; when it's not available we copy the Global one and create a new one for that user. The id of the Intent Node
is exactly the same for Global or User: for each intent there is a Global, a User and later a Group Intent Node.

#### Follow-ups
Okay, this was about the Entry Intent Node. Let's talk about follow-ups. The whole goal of the intent node really shows up
in the follow-ups. Previously we have been searching for concepts in the global space for any question the user asks —
which is fine in the beginning while we are training the system, but if we keep doing that we will never learn and our
search space will always be big. This tells you why the Intent Graph is actually a graph: each Intent Node can have
outgoing edges, which are intents that have been expressed only within the context of the previous intent. If we do this
properly we will have a decision engine — with the ability to decide what someone should do next — and that's why we call
this edge a next edge and the following node a Next Intent Node. Each user Intent Node can have very different next
edges, but the global one has a replica of each, so we know which ones are possible.

The next-intent edges are not passive edges. They are active, in the sense that they have a computation — a function that
runs to see if that edge makes sense or not. Once we are in the session and already past the first Intent Node, this has
already happened: S: I → process → A (S is the session).

Now, given that we have the answer history and context in a session:
I → answer history, context, STATE → next answer → (possible next intents).

Focus on the possible next intents. This is a list of intents that can be computed from the answer history (mostly the
previous answer). Or it can also query the database — so we have a quick compute to validate and filter among the next
intents. The user may pick one, or might ask a completely new question — which then gets added to the list of next
intents by the background process in the clone of that session. The compute has to be quick, because otherwise we are
doing unnecessary compute when the intent itself has not been asked; it can't be full, because we'd have to do the
analysis to do it fully. So the background process will create these functions, so that we can run them at the end of
the last answer.

We will also have some next intents suggested by the agent — but they will always be tagged: asked by the user,
suggested by AI, how often we take which path. It will have full history, with the inputs and what we got for each path,
so that we have provenance and can run tests on them later.

Question for us: should the Global Intent Node have all the paths? Yes — so when a user who has never asked the question
comes, we copy the whole thing and they inherit all the paths. Many of them may not even be valid for them, because they
came from a specific user — it could happen; we will see how to solve it deterministically, or whether we can find a
reliable way of telling what is user-specific vs global/project-specific.

As you can see, there will be lots of paths as users ask questions. We need 2 things to make it stable:
1. Keep creating concepts that are global, and keep reusing them by reference.
2. A consolidation agent (later), run weekly, to merge paths and parametrise them properly — this has to be an
   intelligent agent really.

#### STATE
If it's raining outside and the chair outside is red → a person takes an umbrella. They didn't do it because the chair
was red — they did it because it was raining. This is a principle we need to deeply integrate into the system to create
STATE. We need to know what really is the case for us — we call it a signal → a signal is a computation which creates the
STATE, and STATE is something that directly maps to what we do, or which path we take.

#### Domains, and what an intent node carries
So we will let go of the idea of domains directly. Let the idea of the domain be there, but we will not use it. What we
will use is completely the intent graph system. Every time a user asks a question we try to find and match an intent.
From there it has relations to the concepts, so we pull in all the concepts related to it. It also has the memory of what
happened before, the ability to represent the user's information, and the ability to train it. Some scenarios: a user
comes, asks a question, does not like the answer, says "no, I don't like it, can you make it into this", or gives a
definition, or has many other interactions, or asks for a specific representation in the UI. At the end we get the answer
and we have to figure out what goes into that intent node, and store it inside the node with proper parameterisation.
Then, if that node exists and someone reaches it next time, what we put into the ICA is: we are in this intent node, and
this is what we did before — we load everything into it. Today we load the entire domain, which may have many more things
outside what the user is asking at the moment; the intent is a very focused system that only tells how to answer this
specific question, given the history of all the times we have tried to answer it, how it went, and the mistakes we made.
(We need not keep the errors if we figured out the proper way — the suggested way of doing it.) It is not a program. It
has the smallest programs within it, so we can compute things with them — but not a program in the sense that everything
is fixed: everything has to go through the agent, either the composer or the analyst.

We will make this the backbone of our system, and use it to train the system. Every user has their version of the intent
node, but there is almost nothing stored in it that is not specific to that user. There will be conflicts about what to
put in the user node and what in the global node, and how to figure out what is essential to the user. My view: every
time a user creates something specific, it goes into that user's intent node, and we add it as a suggestion to the global
intent node. Given there will be multiple users, each with their own versions, we do not know what should really be part
of the global/project intent node. So all of them come as suggestions — different variations — and one canonical version
will be there. The canonical version is something someone has to approve, because we cannot let any random user's way of
calculating design the whole project; they only come as suggestions, and someone is in charge of deciding which is
correct. If all of them say exactly the same thing, there is no disagreement, and it goes to the canonical view. There
are two views: the accumulated one — many variations of the intent node received from each user — and the one approved
at the moment. There is one single node only, but inside there is a collection of things from different users: different
concepts, different variations of how to process the intent, and one currently selected as the correct answer (which
again need not be correct — it is just the current view of the system). Every time a new user asks, they get the intent
node from the global project one and take whatever is the approved version. If no one has approved a version, we take the
most highly represented variation, with a message that it has not been verified; the agent takes a little reference from
that previous work and can additionally work out its own process.

#### Agents in a session
Until now we have been working only with the composer. For every session we now have an agent (programs, context, answer
history, STATE at the moment, ica:composer). From now on we will have not only the composer but an analyst as well.
Previously there was one analyst per project; now there is an analyst for each session — ica:claude-code:sonnet-5/opus-5 —
part of each and every session. It is not created at the beginning — only when necessary.

If the Intent Node is new, we always start with the analyst. Once we have an Intent Node and are reusing it, we use the
composer. If we realise in between that the composer cannot answer something, we switch to the analyst again. At any point
only one of them is running. Since they need each other's context: if we ran the composer for QA1, QA2, QA3 and realised
we need the analyst — it is the composer that says "I am going to use the analyst" — we append Q1, Q2, Q3 into the
analyst, since it has not seen them; the answer history and the STATE are always shared, so no need to inject — if it
needs them it reads them. The composer cannot see the analyst's internal process, but it can pick up from the answer and
move on if the next question matches an existing Intent Node. The rule: intent matched → composer; intent not matched →
analyst. The analyst is more intelligent, so it creates better Intent Nodes and prepares them the first time. From time to
time the analyst takes over even if an Intent Node exists, if the composer feels a new scenario has happened or it cannot
find the answer. The composer never creates Intent Nodes — it only uses them when they exist.

Like the analyst, other agents such as the connector agent can be part of some Intent Nodes, so the agent can do work not
only for answering but to change the system itself — for admins and developers: the same process through which we answer
questions is also used to modify the system. There can be many such common agents given to people. Some intent nodes will
be created very specifically, with things like the connector agent and administration agents — so the intent node itself
has a permission system. Someone without permission who says "I want to add something new" reaches the intent node and is
told they are not allowed. Those with permission on that intent node can use its agents. So: every session has the
composer and the analyst (session agents); some agents are associated only with an intent node (intent-node agents),
created by someone else or by the system, usable by those with permission.

So now do you understand where we want to go with the Intent Graph? The intent graph will be the starting point, and the
intent graph will also be how we train this system.

One more thing: the intent graph in the admin page should look like the Composition graph UI — no need to invent a new UI.
Same UI.

The User Intent Node is kept in the same place (the same DO) as the Global one. It is mostly the same intent node; for
each user there is just a reference, and any additional difference.
