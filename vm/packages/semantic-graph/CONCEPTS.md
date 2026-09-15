# The semantic graph: what each thing is

The definitions this package is built on. Each term says what it is, what distinguishes it from the others, and how it
is written in a schema. When the graph gains or changes a concept, this file changes with it.

Examples use one made-up business: a retailer with **stores** in **regions**, selling **products** in **categories**,
with **sales**, **stock counts** and a **budget**.

---

## Declared: what exists

These are written in a schema (`schema.ts`, `ObjectDef`).

### Entity

A set of things with **identity**. Each element has a key that stays the same, a label people read it by, and may
link to other entities.

- *Distinguished by:* identity. Two stores are two things even when every value they carry is equal. An entity can be
  counted, can carry attributes, can belong to another entity (a store to its region), can form a tree (a category
  under its parent), and can change what it belongs to over time (a store moving region).
- *Written as:* `{ "kind": "entity" }`, with optional `members` (listed keys and labels), `names` people use for them,
  `attributes`, and `arrows`.
- *Examples:* Store, Region, Product, Category (once it has its own key), Customer.

### Attribute

A **value** an entity element or a fact row carries that leads nowhere else.

- *Distinguished by:* no identity. Two products both "Refurbished" share a value, not a thing; nothing can be said
  about "Refurbished" itself. An attribute has a type — **text** (optionally a listed set of values), **date**,
  **number** or **flag** — which says how it compares: text by value, dates and numbers by range.
- *Written as:* `"attributes": { "condition": { "type": "text", "members": ["New", "Refurbished"] } }` on an entity or a
  fact.
- *Examples:* a product's condition, a store's opening date, a sale line's promotion code.
- *Never added up.* A number attribute is a property (a product's weight), not a measure.

### Calendar

An entity for **time** whose elements and roll-ups are computed from dates, never stored: day → week, day → month →
quarter → year, or an organisation's fiscal or listed periods.

- *Distinguished by:* computed. A day's month is known from the day itself; every path between two calendar levels
  is the same function.
- *Written as:* `{ "kind": "calendar", "level": "month" }`, or a `fiscal` or `periods` definition.

### Fact

A set of **recorded events or states** at a declared **grain**. It is where measures live.

- *Distinguished by:* grain and measures. A fact has many rows, arrives continuously, points at entities and calendars,
  and is never pointed at. Nothing is a fact because of its size; it is a fact because each row records something
  measured about a combination of things.
- *Written as:* `{ "kind": "fact", "arrows": {…}, "measures": {…} }`.
- *Examples:* Sale (a product sold in a store on a day), StockCount (the units of a product in a store at a day's
  close), BudgetLine (a budgeted amount for a store in a month, in one version).

### Grain

What **one row** of a fact is about: the entities, calendar level and version its row is identified by. No two rows of
a fact share all of them.

- *Distinguished by:* it is a property of a fact, not a separate object. It says what a measure's number is *per*:
  Sale is per product × store × day, so `units` is units of one product in one store on one day.
- *Written as:* the fact's **grain arrows**, its time arrow and its version arrow (an arrow of kind `belongs` on a fact
  is a property of the row, not part of its grain). A fact may state its grain as `"grain": ["product", "store", "day"]`;
  when stated it must be exactly those arrows. The data is checked for it before an answer is trusted.

### Measure

A **number** on each row of a fact, with everything needed to aggregate it correctly.

- *Distinguished by:* it is what questions aggregate. Only facts have measures.
- *Written as:* `"measures": { "units": { "unit": "units", "kind": "flow", "aggregate": "sum" } }`, where:
  - **unit** — a product of base units (`units`, `h`, `money`, `money/units`); units multiply and divide, and a
    result's unit is computed and checked;
  - **kind** — how it behaves:
    - **flow**: something that happened during a period; it adds up over time and across groups (units sold);
    - **stock**: a level at an instant; it adds across groups but not over time — it says whether the last, first or
      average level stands for a period (`overTime`) (units on hand);
    - **value per unit**: a rate or price; it never adds — it is combined by min, max, median or a weighted average
      (price per unit, weighted by units);
  - **aggregate** — sum, count, count distinct (of an arrow), min, max, average, median, weighted average;
  - **currency** — for money: where each row's currency comes from; money in several currencies is converted before it
    is added;
  - **versions** — a version arrow whose versions are never added together (the original budget and the reforecast).

### Arrow

A link from one object to another. Following an arrow from an element gives at most one thing: an arrow is a function.

- *Kinds:*
  - **grain** — from a fact to what its rows are about;
  - **belongs** — from an entity to what it belongs to (a store to its region); on a fact, a property of the row that
    is not part of its grain;
  - **roll-up** — from a calendar level to a coarser one;
  - **as-of** — an entity's link that changes over time, followed as it was on each row's date (a store's region);
  - **version** — from a fact to the version its row is in;
  - **self** — from an entity to another of its own kind (a category's parent), making a tree.
- *Partial:* an arrow that may lead to nothing (a product with no category). Rows with nothing there are kept as
  "none", never dropped silently.

### Condition

A named set of filters on **one object**, defined once and applied by name.

- *Distinguished by:* a definition people refer to ("an active store", "a clearance product") rather than filters
  retyped in every question. It is kept to from any fact that reaches its object.
- *Written as:* `"conditions": { "active store": { "on": "Store", "where": [ … ] } }`. A fact may be **kept to** some
  conditions always (`"keptTo"`), unless a question sets one aside (`"without"`).

### Path equation

Two paths that must lead to the same place (a sale's store's region equals the sale's region, when the fact carries
both). Equal paths are the same path: one normal form is chosen.

### Current state only

A source that holds only how things **stand now** (`"history": "current"`), with no record of earlier states. Its
facts are answered as they stand now; a question about an earlier day is refused, with the reason.

---

## Derived: how the schema is used

These are not written in a schema. They follow from it, and the graph computes them.

### Dimension

A **way to slice or filter a fact's measures**: an entity, an attribute or a calendar level, reached from that fact
along a path.

- *Distinguished by:* it is a **role**, not a kind of object. It is always a dimension *of a fact*: "Region is a
  dimension of Sale, through store.region". The same entity is a dimension of many facts, by different paths; an
  entity no fact reaches is not a dimension of anything.
- *What it can be:*
  - an **entity** reached along arrows (Store, Region);
  - an **attribute** of the fact itself, or of an entity reached (a sale's promotion code; a product's condition);
  - a **calendar level** reached from the fact's time (Month, Quarter).
- *How it is found:* `dimensions(schema, fact)` lists every dimension of a fact, each with its paths, the default path
  when there are several, and whether it can be empty.

### Path

The route from a fact to a dimension: a list of arrows, one per step (`["store", "region"]`). When a fact reaches a
dimension more than one way (a sale's store's region, or its customer's home region), a question says which, or the
fact names a **default**.

### Conformed dimension

A dimension **several facts share**, so their measures can be put side by side: Sale and BudgetLine both reach Store
and Month, so sales can be compared with budget by store and month. `conformedDimensions(schema, facts)` lists them.

### Question

Measures (from one or more facts), grouped by dimensions, kept to filters and conditions, over a span of time, with
coordinates applied to the result (order, limit, totals, share, compare, rolling). A question is checked by the rules
before anything is read, and refused with its reason when it cannot be answered as asked.

---

## When an attribute becomes an entity

A dimension may start as an attribute and later turn out to have identity of its own: a product's category is first a
label, then gains a key, a parent category and a manager.

The change: a new entity (Category) and an arrow (`Product.category → Category`). The old attribute is the label along
the new path, so every question asked of the old form has an exact equivalent in the new one. The dimension stays the
same; only how it is implemented changes.

What the graph does today: the new schema is a new version (by hash), old answers replay on the version they were
answered on, and the change is flagged as breaking until it is made deliberately. Not yet: keeping the old attribute
as a derived one, so old questions keep working and reduce to the same canonical question.
